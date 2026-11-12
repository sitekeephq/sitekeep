import { and, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { validateName, type TrashDto, type TrashFileDto, type TrashFolderDto } from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { FolderTree, isUuid, projectAccess, requireProjectAdmin, userNames, type ProjectAccess } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import type { Db } from "../../db/index.js";
import { auditLog, fileVersions, files, folders, versionPreviews } from "../../db/schema.js";
import { badRequest, conflict, forbidden, notFound } from "../../core/platform/http.js";
import { msg, requestLanguage } from "../../i18n/index.js";
import type { Storage } from "../../core/platform/storage.js";
import { cleanFileName } from "./files.js";
import { folderName } from "./folders.js";
import { standardForFolder } from "../../modules/documents/naming-routes.js";

type FolderRow = typeof folders.$inferSelect;
type FileRow = typeof files.$inferSelect;

const restoreSchema = z.object({ name: z.string().trim().min(1).max(250).optional() }).default({});

/**
 * Recycle bin. Deleted files and folders stay in the database (deletedAt set) with their
 * versions on disk. Project administrators list and restore them; only system
 * administrators delete them permanently.
 */
export async function trashRoutes(api: FastifyInstance, { db, storage }: AppDeps) {
  api.get<{ Params: { pid: string } }>("/projects/:pid/trash", async (req): Promise<TrashDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const all = await AllFolders.load(db, a.project.id);
    const deletedFiles = await db
      .select({ file: files, size: fileVersions.size })
      .from(files)
      .innerJoin(fileVersions, and(eq(fileVersions.fileId, files.id), eq(fileVersions.version, files.currentVersion)))
      .where(and(eq(files.projectId, a.project.id), isNotNull(files.deletedAt)));

    // A deleted folder is listed once, at the top of what was deleted together.
    const rootFolders = [...all.byId.values()].filter((f) => f.deletedAt && !all.deletedWithParent(f));
    // Files deleted together with their folder are restored with it; list only the others.
    const looseFiles = deletedFiles.filter((r) => {
      const folder = all.byId.get(r.file.folderId);
      return !folder?.deletedAt || folder.deletedAt.getTime() !== r.file.deletedAt!.getTime();
    });

    const deleters = await lastDeleters(db, a.project.id, [
      ...rootFolders.map((f) => f.id),
      ...looseFiles.map((r) => r.file.id),
    ]);
    const names = await userNames(db, [...deleters.values()]);

    const folderDtos: TrashFolderDto[] = rootFolders.map((f) => {
      const subtree = all.batch(f);
      const ids = new Set(subtree.map((x) => x.id));
      const by = deleters.get(f.id) ?? null;
      return {
        id: f.id,
        name: f.name,
        parentId: f.parentId,
        path: f.parentId ? all.path(f.parentId) : "",
        deletedAt: f.deletedAt!.toISOString(),
        deletedBy: by,
        deletedByName: by ? names.get(by) : undefined,
        folderCount: subtree.length - 1,
        fileCount: deletedFiles.filter(
          (r) => ids.has(r.file.folderId) && r.file.deletedAt!.getTime() === f.deletedAt!.getTime(),
        ).length,
        parentAlive: !!f.parentId && all.alive(f.parentId),
      };
    });
    const fileDtos: TrashFileDto[] = looseFiles.map(({ file, size }) => {
      const by = deleters.get(file.id) ?? null;
      return {
        id: file.id,
        name: file.name,
        folderId: file.folderId,
        path: all.path(file.folderId),
        currentVersion: file.currentVersion,
        size,
        deletedAt: file.deletedAt!.toISOString(),
        deletedBy: by,
        deletedByName: by ? names.get(by) : undefined,
        folderAlive: all.alive(file.folderId),
      };
    });
    const newest = (x: { deletedAt: string }, y: { deletedAt: string }) => y.deletedAt.localeCompare(x.deletedAt);
    return { folders: folderDtos.sort(newest), files: fileDtos.sort(newest) };
  });

  api.post<{ Params: { pid: string; id: string } }>("/projects/:pid/trash/files/:id/restore", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = restoreSchema.parse(req.body ?? {});
    const file = await loadDeletedFile(db, a, req.params.id);
    const tree = await FolderTree.load(db, a.project.id);
    if (!tree.byId.has(file.folderId))
      throw conflict(msg("documents:errors.restoreFolderDeleted"), { reason: "folder_deleted" });
    const name = body.name !== undefined ? cleanFileName(body.name) : file.name;
    if (!name) throw badRequest(msg("documents:errors.invalidFileName"));
    if (name !== file.name) {
      const standard = await standardForFolder(db, tree, file.folderId);
      if (standard) {
        const r = validateName(standard, name, requestLanguage(req));
        if (!r.ok) throw badRequest(msg("documents:errors.nameNotStandard", { errors: r.errors.join("; ") }), r);
      }
    }
    const [clash] = await db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.folderId, file.folderId), eq(files.name, name), isNull(files.deletedAt)));
    if (clash)
      throw conflict(
        msg("documents:errors.restoreFileExists", { folder: folderPath(tree, file.folderId), name }),
        { reason: "name_conflict", name },
      );
    await db.update(files).set({ deletedAt: null, name }).where(eq(files.id, file.id));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "file.restored",
      targetType: "file",
      targetId: file.id,
      details: { name, ...(name !== file.name ? { from: file.name } : {}), folderId: file.folderId },
    });
    return { ok: true, id: file.id, name, folderId: file.folderId };
  });

  /** Restores the folder, the subfolders and the files deleted together with it. */
  api.post<{ Params: { pid: string; id: string } }>("/projects/:pid/trash/folders/:id/restore", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = z.object({ name: folderName.optional() }).default({}).parse(req.body ?? {});
    const all = await AllFolders.load(db, a.project.id);
    const folder = all.deleted(req.params.id);
    if (!folder.parentId || !all.alive(folder.parentId))
      throw conflict(msg("documents:errors.restoreParentDeleted"), { reason: "parent_deleted" });
    const name = body.name ?? folder.name;
    const clash = (all.children.get(folder.parentId) ?? []).find((f) => !f.deletedAt && f.name === name);
    if (clash)
      throw conflict(
        msg("documents:errors.restoreFolderExists", { folder: all.path(folder.parentId), name }),
        { reason: "name_conflict", name },
      );
    const ids = all.batch(folder).map((f) => f.id);
    const restored = await db.transaction(async (tx) => {
      const fileRows = await tx
        .update(files)
        .set({ deletedAt: null })
        .where(and(inArray(files.folderId, ids), eq(files.deletedAt, folder.deletedAt!)))
        .returning({ id: files.id });
      // Rename and undelete the top folder in one statement (unique name among live siblings).
      await tx.update(folders).set({ deletedAt: null, name }).where(eq(folders.id, folder.id));
      const below = ids.filter((id) => id !== folder.id);
      if (below.length) await tx.update(folders).set({ deletedAt: null }).where(inArray(folders.id, below));
      return fileRows.length;
    });
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "folder.restored",
      targetType: "folder",
      targetId: folder.id,
      details: { name, ...(name !== folder.name ? { from: folder.name } : {}), folders: ids.length, files: restored },
    });
    return { ok: true, id: folder.id, name, folders: ids.length, files: restored };
  });

  /** Permanent delete (system administrators only); frees storage no other version uses. */
  api.delete<{ Params: { pid: string; id: string } }>("/projects/:pid/trash/files/:id", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireSystemAdmin(a);
    const file = await loadDeletedFile(db, a, req.params.id);
    const r = await purgeFiles(db, storage, [file.id]);
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "file.purged",
      targetType: "file",
      targetId: file.id,
      details: { name: file.name, versions: r.versions, removedObjects: r.removedObjects },
    });
    return { ok: true, ...r };
  });

  api.delete<{ Params: { pid: string; id: string } }>("/projects/:pid/trash/folders/:id", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireSystemAdmin(a);
    const all = await AllFolders.load(db, a.project.id);
    const folder = all.deleted(req.params.id);
    const ids = [folder.id, ...all.descendants(folder.id)];
    if (ids.some((id) => all.alive(id))) throw conflict(msg("documents:errors.purgeLiveFolders"));
    const fileRows = await db.select({ id: files.id, deletedAt: files.deletedAt }).from(files).where(inArray(files.folderId, ids));
    if (fileRows.some((f) => !f.deletedAt)) throw conflict(msg("documents:errors.purgeLiveFiles"));
    const r = await purgeFiles(db, storage, fileRows.map((f) => f.id));
    // Grants and attribute bindings go with the folders (ON DELETE CASCADE).
    await db.delete(folders).where(inArray(folders.id, ids));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "folder.purged",
      targetType: "folder",
      targetId: folder.id,
      details: { name: folder.name, folders: ids.length, files: fileRows.length, ...r },
    });
    return { ok: true, folders: ids.length, files: fileRows.length, ...r };
  });
}

function requireSystemAdmin(a: ProjectAccess) {
  if (!a.user.isAdmin) throw forbidden(msg("documents:errors.purgeAdminOnly"));
}

async function loadDeletedFile(db: Db, a: ProjectAccess, id: string): Promise<FileRow> {
  if (!isUuid(id)) throw notFound(msg("documents:entities.file"));
  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), eq(files.projectId, a.project.id), isNotNull(files.deletedAt)));
  if (!file) throw notFound(msg("documents:entities.trashFile"));
  return file;
}

/**
 * Deletes files with all their versions, then removes the stored objects (originals and
 * viewer derivatives) that no remaining version row refers to.
 */
export async function purgeFiles(
  db: Db,
  storage: Storage,
  fileIds: string[],
): Promise<{ versions: number; removedObjects: number }> {
  if (!fileIds.length) return { versions: 0, removedObjects: 0 };
  const versions = await db
    .select({ id: fileVersions.id, storageKey: fileVersions.storageKey, derivativeKey: fileVersions.derivativeKey })
    .from(fileVersions)
    .where(inArray(fileVersions.fileId, fileIds));
  const keys = new Set<string>();
  for (const v of versions) {
    keys.add(v.storageKey);
    if (v.derivativeKey) keys.add(v.derivativeKey);
  }
  // Viewer previews (office PDF, sheet JSON, DXF, 2D scenes) belong to one version each.
  const previewKeys = versions.length
    ? (
        await db
          .select({ key: versionPreviews.storageKey, meta: versionPreviews.meta })
          .from(versionPreviews)
          .where(inArray(versionPreviews.versionId, versions.map((v) => v.id)))
      ).flatMap((p) => [p.key, p.meta.sceneModelKey].filter((k): k is string => !!k))
    : [];
  await db.transaction(async (tx) => {
    await tx.delete(fileVersions).where(inArray(fileVersions.fileId, fileIds));
    await tx.delete(files).where(inArray(files.id, fileIds));
  });
  let removedObjects = 0;
  const list = [...keys];
  if (list.length) {
    const stillUsed = await db
      .select({ storageKey: fileVersions.storageKey, derivativeKey: fileVersions.derivativeKey })
      .from(fileVersions)
      .where(or(inArray(fileVersions.storageKey, list), inArray(fileVersions.derivativeKey, list)));
    const used = new Set(stillUsed.flatMap((v) => [v.storageKey, v.derivativeKey]));
    for (const key of list) {
      if (used.has(key)) continue;
      await storage.remove(key);
      removedObjects++;
    }
  }
  for (const key of previewKeys) {
    await storage.remove(key);
    removedObjects++;
  }
  return { versions: versions.length, removedObjects };
}

/** Who deleted each item last, from the activity log. */
async function lastDeleters(db: Db, projectId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const rows = await db
    .select({ targetId: auditLog.targetId, userId: auditLog.userId })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.projectId, projectId),
        inArray(auditLog.action, ["file.deleted", "folder.deleted"]),
        inArray(auditLog.targetId, ids),
      ),
    )
    .orderBy(desc(auditLog.id));
  for (const r of rows) if (r.targetId && r.userId && !out.has(r.targetId)) out.set(r.targetId, r.userId);
  return out;
}

function folderPath(tree: FolderTree, id: string): string {
  return tree
    .ancestry(id)
    .map((x) => tree.get(x).name)
    .join(" / ");
}

/** Every folder of a project, deleted ones included. */
class AllFolders {
  readonly byId = new Map<string, FolderRow>();
  readonly children = new Map<string, FolderRow[]>();

  constructor(rows: FolderRow[]) {
    for (const f of rows) {
      this.byId.set(f.id, f);
      if (f.parentId) {
        const list = this.children.get(f.parentId) ?? [];
        list.push(f);
        this.children.set(f.parentId, list);
      }
    }
  }

  static async load(db: Db, projectId: string) {
    return new AllFolders(await db.select().from(folders).where(eq(folders.projectId, projectId)));
  }

  alive(id: string): boolean {
    const f = this.byId.get(id);
    return !!f && !f.deletedAt;
  }

  deleted(id: string): FolderRow {
    const f = isUuid(id) ? this.byId.get(id) : undefined;
    if (!f || !f.deletedAt) throw notFound(msg("documents:entities.trashFolder"));
    return f;
  }

  /** True when the folder was deleted in the same operation as its parent. */
  deletedWithParent(f: FolderRow): boolean {
    const p = f.parentId ? this.byId.get(f.parentId) : undefined;
    return !!p?.deletedAt && !!f.deletedAt && p.deletedAt.getTime() === f.deletedAt.getTime();
  }

  /** The folder and the subfolders deleted together with it. */
  batch(root: FolderRow): FolderRow[] {
    const out = [root];
    const at = root.deletedAt?.getTime();
    const walk = (id: string) => {
      for (const c of this.children.get(id) ?? []) {
        if (c.deletedAt?.getTime() !== at) continue;
        out.push(c);
        walk(c.id);
      }
    };
    walk(root.id);
    return out;
  }

  descendants(id: string): string[] {
    const out: string[] = [];
    const walk = (fid: string) => {
      for (const c of this.children.get(fid) ?? []) {
        out.push(c.id);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  }

  path(id: string): string {
    const names: string[] = [];
    let cur = this.byId.get(id);
    while (cur) {
      names.unshift(cur.name);
      cur = cur.parentId ? this.byId.get(cur.parentId) : undefined;
    }
    return names.join(" / ");
  }
}
