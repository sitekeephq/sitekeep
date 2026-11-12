import type { Readable } from "node:stream";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ZipFile } from "yazl";
import { z } from "zod";
import { ZIP_MISSING_FILE, can, splitExtension, type ZipRequest } from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { FolderTree, isUuid, projectAccess, type ProjectAccess } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import { fileVersions, files } from "../../db/schema.js";
import { badRequest } from "../../core/platform/http.js";
import { msg, tReq } from "../../i18n/index.js";
import { folderDisplayPath } from "./path.js";

type FileRow = typeof files.$inferSelect;
type VersionRow = typeof fileVersions.$inferSelect;

const MAX_ITEMS = 5000;
/** Formats that are already compressed are stored as they are. */
const STORED = new Set(["zip", "ifczip", "7z", "rar", "gz", "png", "jpg", "jpeg", "mp4", "docx", "xlsx", "pptx", "rvz", "frag"]);

const ids = z.array(z.string()).max(MAX_ITEMS).optional();
const zipSchema = z.object({ fileIds: ids, folderIds: ids, versionIds: ids, name: z.string().max(100).optional() });

/**
 * Bulk download: one zip with the latest version of the chosen files, whole folder subtrees
 * (folder structure kept) and/or chosen versions. Files the caller may see but not download
 * are left out and listed in _eksikler.txt; items the caller cannot see are listed by id only.
 *
 * POST takes a JSON body; GET takes the same lists comma separated in the query string so a
 * browser link can stream the zip straight to disk.
 */
export async function zipRoutes(api: FastifyInstance, deps: AppDeps) {
  api.post<{ Params: { pid: string } }>("/projects/:pid/download-zip", async (req, reply) =>
    sendZip(deps, req.params.pid, req.user!, zipSchema.parse(req.body ?? {}), reply),
  );
  api.get<{ Params: { pid: string }; Querystring: Record<string, string | undefined> }>(
    "/projects/:pid/download-zip",
    async (req, reply) => {
      const list = (v?: string) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
      const body = zipSchema.parse({
        fileIds: list(req.query.fileIds),
        folderIds: list(req.query.folderIds),
        versionIds: list(req.query.versionIds),
        name: req.query.name,
      });
      return sendZip(deps, req.params.pid, req.user!, body, reply);
    },
  );
}

interface Entry {
  path: string;
  file: FileRow;
  version: VersionRow;
}

async function sendZip(
  { db, storage }: AppDeps,
  pid: string,
  user: NonNullable<import("fastify").FastifyRequest["user"]>,
  body: ZipRequest & { name?: string },
  reply: FastifyReply,
) {
  const a = await projectAccess(db, pid, user);
  const tree = await FolderTree.load(db, a.project.id);
  const fileIds = unique(body.fileIds);
  const folderIds = unique(body.folderIds);
  const versionIds = unique(body.versionIds);
  if (!fileIds.length && !folderIds.length && !versionIds.length) throw badRequest(msg("documents:errors.zipNothingSelected"));

  const entries: Entry[] = [];
  const skipped: string[] = [];
  const notFound: string[] = [];
  const access = new Access(tree, a);

  // Single files: latest version, at the top of the zip.
  const valid = (list: string[]) => {
    const ok = list.filter(isUuid);
    notFound.push(...list.filter((x) => !isUuid(x)));
    return ok;
  };
  const fileList = valid(fileIds);
  if (fileList.length) {
    const rows = await db
      .select()
      .from(files)
      .innerJoin(fileVersions, and(eq(fileVersions.fileId, files.id), eq(fileVersions.version, files.currentVersion)))
      .where(and(inArray(files.id, fileList), eq(files.projectId, a.project.id), isNull(files.deletedAt)));
    const byId = new Map(rows.map((r) => [r.files.id, r]));
    for (const id of fileList) {
      const r = byId.get(id);
      const state = r ? access.check(r.files) : "hidden";
      if (state === "hidden") notFound.push(id);
      else if (state === "no_download") skipped.push(`${folderDisplayPath(tree, r!.files.folderId)} / ${r!.files.name}`);
      else entries.push({ path: r!.files.name, file: r!.files, version: r!.file_versions });
    }
  }

  // Specific versions: "ad (V2).uzantı".
  const versionList = valid(versionIds);
  if (versionList.length) {
    const rows = await db
      .select()
      .from(fileVersions)
      .innerJoin(files, eq(files.id, fileVersions.fileId))
      .where(and(inArray(fileVersions.id, versionList), eq(files.projectId, a.project.id), isNull(files.deletedAt)));
    const byId = new Map(rows.map((r) => [r.file_versions.id, r]));
    for (const id of versionList) {
      const r = byId.get(id);
      const state = r ? access.check(r.files) : "hidden";
      if (state === "hidden") notFound.push(id);
      else if (state === "no_download")
        skipped.push(`${folderDisplayPath(tree, r!.files.folderId)} / ${r!.files.name} (V${r!.file_versions.version})`);
      else entries.push({ path: versionedName(r!.files.name, r!.file_versions.version), file: r!.files, version: r!.file_versions });
    }
  }

  // Folders: the visible subtree, paths relative to the parent of the chosen folder.
  const folderList = valid(folderIds);
  const subtreeIds = new Map<string, string>(); // folderId → path inside the zip
  for (const fid of folderList) {
    if (!tree.byId.has(fid) || !tree.visible(a.principal, fid)) {
      notFound.push(fid);
      continue;
    }
    const base = tree.get(fid).name;
    subtreeIds.set(fid, base);
    const walk = (id: string, prefix: string) => {
      for (const c of tree.children.get(id) ?? []) {
        if (!tree.visible(a.principal, c.id)) continue;
        const p = `${prefix}/${c.name}`;
        subtreeIds.set(c.id, p);
        walk(c.id, p);
      }
    };
    walk(fid, base);
  }
  if (subtreeIds.size) {
    const rows = await db
      .select()
      .from(files)
      .innerJoin(fileVersions, and(eq(fileVersions.fileId, files.id), eq(fileVersions.version, files.currentVersion)))
      .where(and(inArray(files.folderId, [...subtreeIds.keys()]), isNull(files.deletedAt)));
    rows.sort((x, y) => x.files.name.localeCompare(y.files.name, "tr"));
    for (const r of rows) {
      const state = access.check(r.files);
      if (state === "hidden") continue; // not listed: the caller cannot see the file at all
      const p = `${subtreeIds.get(r.files.folderId)}/${r.files.name}`;
      if (state === "no_download") skipped.push(`${folderDisplayPath(tree, r.files.folderId)} / ${r.files.name}`);
      else entries.push({ path: p, file: r.files, version: r.file_versions });
    }
  }

  if (entries.length + skipped.length + notFound.length > MAX_ITEMS)
    throw badRequest(msg("documents:errors.zipTooMany", { max: MAX_ITEMS }));

  // Unique paths inside the zip (the same file chosen twice is added once).
  const seen = new Set<string>();
  const usedPaths = new Set<string>();
  const finalEntries: Entry[] = [];
  for (const e of entries) {
    if (seen.has(e.version.id)) continue;
    seen.add(e.version.id);
    let p = e.path;
    for (let n = 2; usedPaths.has(p.toLowerCase()); n++) {
      const slash = e.path.lastIndexOf("/") + 1;
      const { base, extension } = splitExtension(e.path.slice(slash));
      p = `${e.path.slice(0, slash)}${base} (${n})${extension ? `.${extension}` : ""}`;
    }
    usedPaths.add(p.toLowerCase());
    finalEntries.push({ ...e, path: p });
  }

  const missing: string[] = [];
  const present: Entry[] = [];
  for (const e of finalEntries) {
    const ok = await storage.size(e.version.storageKey).then(
      () => true,
      () => false,
    );
    if (ok) present.push(e);
    else missing.push(e.path);
  }

  const zip = new ZipFile();
  for (const e of present) {
    const ext = splitExtension(e.file.name).extension.toLowerCase();
    zip.addReadStreamLazy(
      e.path,
      { mtime: e.version.uploadedAt, compress: !STORED.has(ext), size: e.version.size },
      (cb) => {
        const stream = storage.get(e.version.storageKey);
        // yazl does not listen for read errors; unhandled, one would take the whole server down.
        stream.on("error", (err) => (zip.outputStream as Readable).destroy(err));
        cb(null, stream);
      },
    );
  }
  if (skipped.length || notFound.length || missing.length) {
    const t = tReq(reply.request);
    const lines = [`${a.project.code} — ${new Date().toISOString()}`, t("documents:zip.intro"), ""];
    if (skipped.length) lines.push(t("documents:zip.noDownload"), ...skipped.map((s) => `  - ${s}`), "");
    if (notFound.length) lines.push(t("documents:zip.notFound"), ...notFound.map((s) => `  - ${s}`), "");
    if (missing.length) lines.push(t("documents:zip.missingContent"), ...missing.map((s) => `  - ${s}`), "");
    zip.addBuffer(Buffer.from(lines.join("\r\n"), "utf8"), ZIP_MISSING_FILE);
  }
  zip.end();

  await audit(db, {
    projectId: a.project.id,
    userId: a.user.id,
    action: "file.zip_downloaded",
    targetType: "project",
    targetId: a.project.id,
    details: {
      count: present.length,
      skipped: skipped.length + notFound.length + missing.length,
      items: present.slice(0, 1000).map((e) => ({ fileId: e.file.id, version: e.version.version, path: e.path })),
    },
  });

  const name = `${(body.name?.trim() || `${a.project.code}-dosyalar`).replace(/[\\/:*?"<>|]/g, "_")}.zip`;
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  reply.header("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  reply.header("Content-Type", "application/zip");
  return reply.send(zip.outputStream);
}

/** Download rules of the single-file endpoint: download level, or the uploader on an upload-only folder. */
class Access {
  constructor(
    private readonly tree: FolderTree,
    private readonly a: ProjectAccess,
  ) {}

  check(file: FileRow): "ok" | "no_download" | "hidden" {
    if (!this.tree.byId.has(file.folderId)) return "hidden";
    const perm = this.tree.permission(this.a.principal, file.folderId);
    const own = perm.canUpload && file.createdBy === this.a.user.id;
    if (can(perm.level, "download") || own) return "ok";
    if (can(perm.level, "view")) return "no_download";
    return "hidden";
  }
}

function versionedName(name: string, version: number): string {
  const { base, extension } = splitExtension(name);
  return `${base} (V${version})${extension ? `.${extension}` : ""}`;
}

function unique(list?: string[]): string[] {
  return [...new Set(list ?? [])];
}
