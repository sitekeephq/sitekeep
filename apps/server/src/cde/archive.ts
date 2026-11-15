/**
 * ISO-1, D-10: archive on publication. When an approved review publishes a new version of a
 * document that already has a current publication, that publication is first copied into the
 * project's archive folder (same storage key, no byte copy), at the same path below the archive as
 * it had below its Published folder (ensureFolderPath), and flagged `superseded`. Only for projects
 * that enforce the transitions; the system does it (transition published → archived, mode `auto`).
 */
import { and, eq, isNull } from "drizzle-orm";
import { splitExtension } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { fileVersions, files } from "../db/schema.js";
import type { FolderTree } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import { ensureFolderPath } from "../workflow/chain-service.js";
import { cdeStateOf } from "./state.js";
import { stateFolderOf } from "./transitions.js";
import { recordTransition } from "./events.js";

export interface ArchiveInput {
  projectId: string;
  tree: FolderTree;
  archiveFolderId: string;
  containerId: string;
  /** The version about to be published: a publication with the same bytes is not archived (re-run). */
  newStorageKey: string;
  /** Where the new version goes: a publication elsewhere is superseded as well. */
  targetFolderId: string;
  targetName: string;
  review: { id: string; code: string | null; number: number; createdBy: string };
  actorId: string | null;
}

/** Archives the container's current publications; returns the (possibly reloaded) tree and the archive copies. */
export async function archiveCurrentPublications(db: Db, input: ArchiveInput): Promise<{ tree: FolderTree; archived: string[] }> {
  let tree = input.tree;
  const archived: string[] = [];
  if (!tree.byId.has(input.archiveFolderId)) return { tree, archived };
  const candidates = await db
    .select()
    .from(files)
    .where(and(eq(files.projectId, input.projectId), eq(files.containerId, input.containerId), isNull(files.deletedAt), isNull(files.cdeStatus)));
  for (const pub of candidates) {
    if (!tree.byId.has(pub.folderId) || cdeStateOf(tree, pub.folderId) !== "published") continue;
    const [current] = await db
      .select()
      .from(fileVersions)
      .where(and(eq(fileVersions.fileId, pub.id), eq(fileVersions.version, pub.currentVersion)));
    if (!current || current.storageKey === input.newStorageKey) continue;

    // The path below the Published folder, mirrored below the archive.
    const root = stateFolderOf(tree, pub.folderId);
    const chain = tree.ancestry(pub.folderId);
    const segments = root ? chain.slice(chain.indexOf(root) + 1).map((id) => tree.get(id).name) : [];
    const ensured = await ensureFolderPath(db, tree, input.projectId, input.archiveFolderId, segments, input.review.createdBy, input.review.id);
    tree = ensured.tree;
    const folderId = ensured.folderId;

    const comment = `Superseded by review ${input.review.code ?? `#${input.review.number}`}`; // i18n-ok: version comment stored as data
    const copy = await db.transaction(async (tx) => {
      const [same] = await tx
        .select()
        .from(files)
        .where(and(eq(files.folderId, folderId), eq(files.name, pub.name), isNull(files.deletedAt)));
      const versionValues = {
        storageKey: current.storageKey,
        size: current.size,
        sha256: current.sha256,
        uploadedBy: current.uploadedBy,
        comment,
        derivativeStatus: current.derivativeStatus,
        derivativeKey: current.derivativeKey,
        ifcSummary: current.ifcSummary,
        suitabilityCode: current.suitabilityCode,
        revisionCode: current.revisionCode,
        codesSetBy: current.codesSetBy,
        codesSetAt: current.codesSetAt,
      };
      // The archive copy of the same document collects every superseded publication as a version.
      if (same && same.containerId === input.containerId) {
        const [v] = await tx
          .insert(fileVersions)
          .values({ fileId: same.id, version: same.currentVersion + 1, ...versionValues })
          .returning();
        const [f] = await tx
          .update(files)
          .set({ currentVersion: v!.version, cdeStatus: "superseded" })
          .where(eq(files.id, same.id))
          .returning();
        return { file: f!, version: v! };
      }
      // Another document holds the name: the archive copy gets the revision in its name.
      const { base, extension } = splitExtension(pub.name);
      const name = same ? `${base} (${current.revisionCode ?? `V${current.version}`})${extension ? `.${extension}` : ""}` : pub.name;
      const [f] = await tx
        .insert(files)
        .values({
          projectId: input.projectId,
          folderId,
          name,
          attributes: pub.attributes,
          containerId: input.containerId,
          documentCode: pub.documentCode,
          cdeStatus: "superseded",
          createdBy: input.review.createdBy,
        })
        .returning();
      const [v] = await tx.insert(fileVersions).values({ fileId: f!.id, version: 1, ...versionValues }).returning();
      // A publication in another place than the new one is no longer current either.
      if (pub.folderId !== input.targetFolderId || pub.name !== input.targetName)
        await tx.update(files).set({ cdeStatus: "superseded" }).where(eq(files.id, pub.id));
      return { file: f!, version: v! };
    });
    archived.push(copy.file.id);
    await audit(db, {
      projectId: input.projectId,
      userId: input.actorId,
      action: "cde.superseded",
      targetType: "file",
      targetId: copy.file.id,
      details: {
        name: copy.file.name,
        version: copy.version.version,
        sourceFileId: pub.id,
        sourceVersionId: current.id,
        revisionCode: current.revisionCode,
        folderId,
        reviewId: input.review.id,
        system: true,
      },
    });
    await recordTransition(db, {
      projectId: input.projectId,
      userId: input.actorId,
      fileId: copy.file.id,
      versionId: copy.version.id,
      fromFolderId: pub.folderId,
      toFolderId: folderId,
      fromState: "published",
      toState: cdeStateOf(tree, folderId),
      mode: "auto",
      reviewId: input.review.id,
    });
  }
  return { tree, archived };
}
