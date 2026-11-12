/**
 * One way to store a new file version, shared by the upload route and the WOPI editors
 * (PutFile): the same permission, folder gate, naming and attribute rules, the same jobs
 * (IFC, title block, previews and search text) and the same audit entries.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import { can, splitExtension, validateAttributes, validateName, type AttributeDefinition } from "@sitekeep/shared";
import type { FolderTree, ProjectAccess } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import type { Db } from "../db/index.js";
import { fileVersions, files, users, wopiLocks } from "../db/schema.js";
import { badRequest, conflict, forbidden } from "../core/platform/http.js";
import { DEFAULT_LANGUAGE, msg, render } from "../i18n/index.js";
import type { JobQueue } from "../jobs/queue.js";
import { queuePreviewsFor } from "../previews/service.js";
import type { StoredObject } from "../core/platform/storage.js";
import { effectiveDefinitions } from "../modules/documents/attributes.js";
import { standardForFolder } from "../modules/documents/naming-routes.js";
import { GATE_MESSAGE, folderGate } from "../workflow/service.js";

export type FileRow = typeof files.$inferSelect;
export type VersionRow = typeof fileVersions.$inferSelect;

/** Extensions with a model-viewer derivative (IFC → Fragments). */
export const VIEWABLE = new Set(["ifc"]);

export interface AddVersionOptions {
  /** WOPI PutFile has already checked its own lock. */
  ignoreEditLock?: boolean;
  /** Language of the uploader (validation messages). */
  lang?: string;
}

/** The active editor lock of a file (WOPI), or null. */
export async function activeEditLock(db: Db, fileId: string) {
  const [row] = await db
    .select({ lock: wopiLocks, userName: users.name })
    .from(wopiLocks)
    .leftJoin(users, eq(users.id, wopiLocks.userId))
    .where(and(eq(wopiLocks.fileId, fileId), gt(wopiLocks.expiresAt, new Date())));
  return row ? { ...row.lock, userName: row.userName } : null;
}

export async function addVersion(
  db: Db,
  a: ProjectAccess,
  folderId: string,
  name: string,
  obj: StoredObject,
  comment: string | null,
  attributes: Record<string, string>,
  canEdit: boolean,
  defs: readonly AttributeDefinition[] = [],
  opts: AddVersionOptions = {},
): Promise<{ file: FileRow; version: VersionRow }> {
  const requireAttributes = (values: Record<string, string>) => {
    const missing = validateAttributes(
      defs.filter((d) => d.required),
      values,
      { lang: opts.lang ?? DEFAULT_LANGUAGE },
    );
    if (missing.length) throw badRequest(missing.map((e) => e.message).join(" "), missing);
  };
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(files)
      .where(and(eq(files.folderId, folderId), eq(files.name, name), isNull(files.deletedAt)));
    const derivativeStatus = VIEWABLE.has(splitExtension(name).extension.toLowerCase()) ? "pending" : "none";
    if (existing) {
      if (!canEdit && existing.createdBy !== a.user.id)
        throw forbidden(msg("files:errors.noNewVersionPermission"));
      if (!opts.ignoreEditLock) {
        const lock = await activeEditLock(tx as unknown as Db, existing.id);
        if (lock)
          throw conflict(
            lock.userName ? msg("files:errors.editLocked", { name: lock.userName }) : msg("files:errors.editLockedUnknown"),
          );
      }
      requireAttributes({ ...existing.attributes, ...attributes });
      const next = existing.currentVersion + 1;
      const [version] = await tx
        .insert(fileVersions)
        .values({
          fileId: existing.id,
          version: next,
          storageKey: obj.key,
          size: obj.size,
          sha256: obj.sha256,
          uploadedBy: a.user.id,
          comment,
          derivativeStatus,
        })
        .returning();
      const [file] = await tx
        .update(files)
        .set({ currentVersion: next, attributes: { ...existing.attributes, ...attributes } })
        .where(eq(files.id, existing.id))
        .returning();
      return { file: file!, version: version! };
    }
    requireAttributes(attributes);
    const [file] = await tx
      .insert(files)
      .values({ projectId: a.project.id, folderId, name, attributes, createdBy: a.user.id })
      .returning();
    const [version] = await tx
      .insert(fileVersions)
      .values({
        fileId: file!.id,
        version: 1,
        storageKey: obj.key,
        size: obj.size,
        sha256: obj.sha256,
        uploadedBy: a.user.id,
        comment,
        derivativeStatus,
      })
      .returning();
    return { file: file!, version: version! };
  });
}

/**
 * Background work and audit after a version was stored: IFC derivative, title block check
 * (PDF), viewer previews and search text (see shared/viewers.ts).
 */
export async function afterVersionAdded(
  db: Db,
  jobs: JobQueue,
  a: ProjectAccess,
  r: { file: FileRow; version: VersionRow },
  details: Record<string, unknown> = {},
): Promise<void> {
  const name = r.file.name;
  const ext = splitExtension(name).extension.toLowerCase();
  if (VIEWABLE.has(ext)) await jobs.enqueue("ifc_to_frag", { versionId: r.version.id });
  // Title block and revision check (document intelligence), in the background.
  if (ext === "pdf") await jobs.enqueue("docintel_extract", { versionId: r.version.id });
  // In-browser viewers: office PDF, sheet JSON, DXF, search text.
  await queuePreviewsFor(db, jobs, r.version.id, name);
  await audit(db, {
    projectId: a.project.id,
    userId: a.user.id,
    action: r.version.version === 1 ? "file.uploaded" : "file.version_added",
    targetType: "file",
    targetId: r.file.id,
    details: { name, version: r.version.version, size: r.version.size, folderId: r.file.folderId, ...details },
  });
}

/**
 * Why the caller may not store a new version of an existing file, or null when they may.
 * The same rules as the upload route: upload right on the folder, the folder gate (approved
 * reviews only), the naming standard, edit right or own file, required attributes.
 * `lang`: the language of the returned text (the reader's; default: the installation's).
 */
export async function newVersionBlocker(
  db: Db,
  tree: FolderTree,
  a: ProjectAccess,
  file: FileRow,
  lang: string = DEFAULT_LANGUAGE,
): Promise<string | null> {
  const perm = tree.permission(a.principal, file.folderId);
  if (!perm.canUpload) return render(lang, msg("files:errors.noUploadPermission"));
  if (!can(perm.level, "edit") && file.createdBy !== a.user.id) return render(lang, msg("files:errors.noNewVersionPermission"));
  if ((await folderGate(db, tree, file.folderId)).gated) return render(lang, GATE_MESSAGE);
  const standard = await standardForFolder(db, tree, file.folderId);
  if (standard) {
    const r = validateName(standard, file.name, lang);
    if (!r.ok) return render(lang, msg("files:errors.nameNotStandard", { errors: r.errors.join("; ") }));
  }
  const defs = await effectiveDefinitions(db, tree, file.folderId);
  const missing = validateAttributes(
    defs.filter((d) => d.required),
    file.attributes,
    { lang },
  );
  if (missing.length) return missing.map((e) => e.message).join(" ");
  return null;
}
