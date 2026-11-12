import path from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  can,
  splitExtension,
  validateAttributes,
  validateName,
  type FileDto,
  type FileVersionDto,
} from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { FolderTree, isUuid, projectAccess, requireAction, userNames, type ProjectAccess } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import type { Db } from "../../db/index.js";
import { fileVersions, files } from "../../db/schema.js";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../../core/platform/http.js";
import { msg, render, requestLanguage, tFor } from "../../i18n/index.js";
import type { StoredObject } from "../../core/platform/storage.js";
import { standardForFolder } from "../../modules/documents/naming-routes.js";
import { assertDirectWriteAllowed } from "../../workflow/service.js";
import { effectiveDefinitions } from "./attributes.js";
import { VIEWABLE, addVersion, afterVersionAdded, type FileRow, type VersionRow } from "../../files/new-version.js";
import { ensureGeometryUpgrade } from "../../model/service.js";

export async function fileRoutes(api: FastifyInstance, deps: AppDeps) {
  const { db, storage, jobs } = deps;

  /**
   * Upload one or more files into a folder. A file with the same name in the folder gets a
   * new version. Fields (send before the files): comment, attributes (JSON object).
   * Names are checked against the folder's naming standard before anything is stored.
   */
  api.post<{ Params: { pid: string; fid: string } }>("/projects/:pid/folders/:fid/files", async (req, reply) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    const folderId = req.params.fid;
    const perm = requireAction(tree, a, folderId, "upload");
    await assertDirectWriteAllowed(db, tree, folderId);
    const standard = await standardForFolder(db, tree, folderId);
    if (!req.isMultipart()) throw badRequest(msg("documents:errors.multipartExpected"));
    const lang = requestLanguage(req);
    const t = tFor(lang);

    const fields: Record<string, string> = {};
    const stored: { name: string; obj: StoredObject }[] = [];
    const results: { name: string; ok: boolean; errors: string[]; fileId?: string; version?: number }[] = [];
    const seen = new Set<string>();

    for await (const part of req.parts()) {
      if (part.type === "field") {
        fields[part.fieldname] = String(part.value);
        continue;
      }
      const name = cleanFileName(part.filename);
      const errors: string[] = [];
      if (!name) errors.push(t("documents:errors.invalidFileName"));
      else if (seen.has(name)) errors.push(t("documents:errors.duplicateInRequest"));
      if (name && standard) errors.push(...validateName(standard, name, lang).errors);
      if (errors.length) {
        part.file.resume();
        results.push({ name: name || part.filename, ok: false, errors });
        continue;
      }
      seen.add(name);
      const obj = await storage.put(part.file, `projects/${a.project.id}/files`);
      if (part.file.truncated) {
        await storage.remove(obj.key);
        results.push({ name, ok: false, errors: [t("documents:errors.fileTooLarge")] });
        continue;
      }
      stored.push({ name, obj });
    }

    let attributes: Record<string, string> = {};
    if (fields.attributes) {
      try {
        const parsed = z.record(z.string(), z.string()).parse(JSON.parse(fields.attributes));
        // Values are trimmed; empty ones are ignored.
        attributes = Object.fromEntries(
          Object.entries(parsed)
            .map(([k, v]) => [k.trim(), v.trim()] as const)
            .filter(([k, v]) => k && v),
        );
      } catch {
        for (const s of stored) await storage.remove(s.obj.key);
        throw badRequest(msg("documents:errors.attributesNotObject"));
      }
    }
    const comment = fields.comment?.trim() || null;

    // Typed attributes bound to this folder (or an ancestor): values must be valid; required
    // ones are checked per file in addVersion (a new version keeps the file's earlier values).
    const defs = await effectiveDefinitions(db, tree, folderId);
    const attrErrors = validateAttributes(defs, attributes, { partial: true, lang }).map((e) => e.message);
    if (attrErrors.length) {
      for (const s of stored) {
        await storage.remove(s.obj.key);
        results.push({ name: s.name, ok: false, errors: attrErrors });
      }
      stored.length = 0;
    }

    for (const s of stored) {
      try {
        const r = await addVersion(db, a, folderId, s.name, s.obj, comment, attributes, can(perm.level, "edit"), defs, { lang });
        results.push({ name: s.name, ok: true, errors: [], fileId: r.file.id, version: r.version.version });
        await afterVersionAdded(db, jobs, a, r);
      } catch (err) {
        await storage.remove(s.obj.key);
        const message = err instanceof HttpError ? (err.msg ? render(lang, err.msg) : err.message) : t("documents:errors.saveFailed");
        if (!(err instanceof HttpError)) req.log.error(err);
        results.push({ name: s.name, ok: false, errors: [message] });
      }
    }
    if (!results.length) throw badRequest(msg("documents:errors.noFile"));
    const anyOk = results.some((r) => r.ok);
    return reply.status(anyOk ? 200 : 400).send({ standard: standard?.name ?? null, results });
  });

  api.get<{ Params: { pid: string; id: string } }>("/projects/:pid/files/:id", async (req) => {
    const { a, file, tree } = await loadFile(db, req.params.pid, req.params.id, req.user!);
    requireView(tree, a, file);
    const versions = await db
      .select()
      .from(fileVersions)
      .where(eq(fileVersions.fileId, file.id))
      .orderBy(desc(fileVersions.version));
    const names = await userNames(db, versions.map((v) => v.uploadedBy));
    const current = versions.find((v) => v.version === file.currentVersion)!;
    return { ...toFileDto(file, current, names), versions: versions.map((v) => toVersionDto(v, names)) };
  });

  api.patch<{ Params: { pid: string; id: string } }>("/projects/:pid/files/:id", async (req) => {
    const { a, file, tree } = await loadFile(db, req.params.pid, req.params.id, req.user!);
    const body = z
      .object({
        name: z.string().trim().min(1).max(250).optional(),
        folderId: z.string().uuid().optional(),
        attributes: z.record(z.string(), z.string()).optional(),
        description: z.string().trim().max(500).nullable().optional(),
      })
      .parse(req.body);
    requireAction(tree, a, file.folderId, "edit");
    const description = body.description === undefined ? file.description : body.description || null;
    const targetFolder = body.folderId ?? file.folderId;
    if (body.folderId && body.folderId !== file.folderId) {
      requireAction(tree, a, body.folderId, "upload");
      await assertDirectWriteAllowed(db, tree, body.folderId);
    }
    const newName = body.name !== undefined ? cleanFileName(body.name) : file.name;
    if (!newName) throw badRequest(msg("documents:errors.invalidFileName"));
    let attributes = file.attributes;
    if (body.attributes) {
      const defs = await effectiveDefinitions(db, tree, targetFolder);
      const errors = validateAttributes(defs, body.attributes, { partial: true, lang: requestLanguage(req) });
      if (errors.length) throw badRequest(errors.map((e) => e.message).join(" "), errors);
      attributes = { ...file.attributes };
      for (const [k, v] of Object.entries(body.attributes)) {
        // An empty value removes the attribute.
        if (v.trim()) attributes[k] = v.trim();
        else delete attributes[k];
      }
    }
    if (newName !== file.name || targetFolder !== file.folderId) {
      const standard = await standardForFolder(db, tree, targetFolder);
      if (standard) {
        const r = validateName(standard, newName, requestLanguage(req));
        if (!r.ok) throw badRequest(msg("documents:errors.nameNotStandard", { errors: r.errors.join("; ") }), r);
      }
    }
    const [row] = await db
      .update(files)
      .set({
        name: newName,
        folderId: targetFolder,
        attributes,
        description,
      })
      .where(eq(files.id, file.id))
      .returning();
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "file.updated",
      targetType: "file",
      targetId: file.id,
      details: { from: { name: file.name, folderId: file.folderId }, ...body },
    });
    const [v] = await db
      .select()
      .from(fileVersions)
      .where(and(eq(fileVersions.fileId, file.id), eq(fileVersions.version, row!.currentVersion)));
    return toFileDto(row!, v!, await userNames(db, [v!.uploadedBy]));
  });

  api.post<{ Params: { pid: string; id: string } }>("/projects/:pid/files/:id/copy", async (req) => {
    const { a, file, tree } = await loadFile(db, req.params.pid, req.params.id, req.user!);
    requireView(tree, a, file);
    if (!can(tree.permission(a.principal, file.folderId).level, "download"))
      throw forbidden(msg("documents:errors.copyNeedsDownload"));
    const body = z
      .object({
        folderId: z.string().uuid(),
        name: z.string().trim().min(1).max(250).optional(),
      })
      .parse(req.body);
    requireAction(tree, a, body.folderId, "upload");
    await assertDirectWriteAllowed(db, tree, body.folderId);
    const name = cleanFileName(body.name ?? file.name);
    if (!name) throw badRequest(msg("documents:errors.invalidFileName"));
    const standard = await standardForFolder(db, tree, body.folderId);
    if (standard) {
      const result = validateName(standard, name, requestLanguage(req));
      if (!result.ok) throw badRequest(msg("documents:errors.nameNotStandard", { errors: result.errors.join("; ") }), result);
    }
    const defs = await effectiveDefinitions(db, tree, body.folderId);
    const attrErrors = validateAttributes(defs, file.attributes, { lang: requestLanguage(req) });
    if (attrErrors.length) throw badRequest(attrErrors.map((e) => e.message).join(" "), attrErrors);
    const [collision] = await db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.folderId, body.folderId), eq(files.name, name), isNull(files.deletedAt)));
    if (collision) throw conflict(msg("documents:errors.existsInTarget", { name }));
    const [source] = await db
      .select()
      .from(fileVersions)
      .where(and(eq(fileVersions.fileId, file.id), eq(fileVersions.version, file.currentVersion)));
    if (!source) throw notFound(msg("documents:entities.fileVersion"));
    const copied = await db.transaction(async (tx) => {
      const [newFile] = await tx
        .insert(files)
        .values({
          projectId: a.project.id,
          folderId: body.folderId,
          name,
          attributes: file.attributes,
          createdBy: a.user.id,
        })
        .returning();
      const pendingDerivative = VIEWABLE.has(splitExtension(name).extension.toLowerCase());
      const [version] = await tx
        .insert(fileVersions)
        .values({
          fileId: newFile!.id,
          version: 1,
          storageKey: source.storageKey,
          size: source.size,
          sha256: source.sha256,
          uploadedBy: a.user.id,
          comment: render(requestLanguage(req), msg("documents:messages.copiedFrom", { name: file.name })),
          derivativeStatus: pendingDerivative ? "pending" : "none",
        })
        .returning();
      return { file: newFile!, version: version! };
    });
    await afterVersionAdded(db, jobs, a, copied, { copiedFromFileId: file.id });
    return toFileDto(copied.file, copied.version, await userNames(db, [a.user.id]));
  });

  api.delete<{ Params: { pid: string; id: string } }>("/projects/:pid/files/:id", async (req) => {
    const { a, file, tree } = await loadFile(db, req.params.pid, req.params.id, req.user!);
    requireAction(tree, a, file.folderId, "edit");
    await db.update(files).set({ deletedAt: new Date() }).where(eq(files.id, file.id));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "file.deleted",
      targetType: "file",
      targetId: file.id,
      details: { name: file.name },
    });
    return { ok: true };
  });

  api.get<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/download", async (req, reply) => {
    const { a, file, version, tree } = await loadVersion(db, req.params.pid, req.params.vid, req.user!);
    const perm = tree.permission(a.principal, file.folderId);
    const own = perm.canUpload && file.createdBy === a.user.id;
    if (!can(perm.level, "download") && !own) {
      if (!can(perm.level, "view")) throw notFound(msg("documents:entities.file"));
      throw forbidden(msg("documents:errors.noDownloadPermission"));
    }
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "file.downloaded",
      targetType: "file",
      targetId: file.id,
      details: { version: version.version },
    });
    return sendStream(reply, storage.get(version.storageKey), file.name, version.size);
  });

  /** Viewer derivative (That Open Fragments) of an IFC version. */
  api.get<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/model", async (req, reply) => {
    const { a, file, version, tree } = await loadVersion(db, req.params.pid, req.params.vid, req.user!);
    requireView(tree, a, file);
    if (version.derivativeStatus !== "ready" || !version.derivativeKey)
      throw conflict(msg("documents:errors.modelNotReady", { status: version.derivativeStatus }));
    try {
      await storage.size(version.derivativeKey);
    } catch (error) {
      reply.header("Cache-Control", "no-store");
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notFound(msg("documents:entities.modelDerivative"));
      throw error;
    }
    // Coarse-curve derivatives (before 24.10.2026) are rebuilt in the background; this one is
    // served meanwhile. A failure to queue must not keep the model from opening.
    await ensureGeometryUpgrade(db, jobs, version).catch((err: unknown) => req.log.warn({ err }, "geometry upgrade not queued"));
    // The derivative of a version can be rebuilt, so the browser revalidates (cheap 304) instead
    // of keeping an immutable copy.
    const etag = `"${version.derivativeKey.replace(/[^\w.-]/g, "_")}"`;
    reply.header("Cache-Control", "private, no-cache");
    reply.header("ETag", etag);
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    reply.header("Content-Type", "application/octet-stream");
    return reply.send(storage.get(version.derivativeKey));
  });

  /** IFC versions the caller can open in the viewer (latest version of each file by default). */
  api.get<{ Params: { pid: string }; Querystring: { all?: string } }>("/projects/:pid/models", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    const rows = await db
      .select()
      .from(files)
      .innerJoin(fileVersions, eq(fileVersions.fileId, files.id))
      .where(and(eq(files.projectId, a.project.id), isNull(files.deletedAt)));
    const names = await userNames(db, rows.map((r) => r.file_versions.uploadedBy));
    return rows
      .filter((r) => VIEWABLE.has(splitExtension(r.files.name).extension.toLowerCase()))
      .filter((r) => tree.byId.has(r.files.folderId) && can(tree.permission(a.principal, r.files.folderId).level, "view"))
      .filter((r) => req.query.all === "1" || r.file_versions.version === r.files.currentVersion)
      .map((r) => ({
        ...toVersionDto(r.file_versions, names),
        fileName: r.files.name,
        folderId: r.files.folderId,
        folderPath: tree
          .ancestry(r.files.folderId)
          .map((id) => tree.get(id).name)
          .join(" / "),
        isLatest: r.file_versions.version === r.files.currentVersion,
      }))
      .sort((x, y) => x.folderPath.localeCompare(y.folderPath, "tr") || x.fileName.localeCompare(y.fileName, "tr"));
  });
}

export async function loadFile(db: Db, pid: string, id: string, user: NonNullable<import("fastify").FastifyRequest["user"]>) {
  const a = await projectAccess(db, pid, user);
  if (!isUuid(id)) throw notFound(msg("documents:entities.file"));
  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), eq(files.projectId, a.project.id), isNull(files.deletedAt)));
  if (!file) throw notFound(msg("documents:entities.file"));
  const tree = await FolderTree.load(db, a.project.id);
  if (!tree.byId.has(file.folderId)) throw notFound(msg("documents:entities.file"));
  return { a, file, tree };
}

export async function loadVersion(db: Db, pid: string, vid: string, user: NonNullable<import("fastify").FastifyRequest["user"]>) {
  if (!isUuid(vid)) throw notFound(msg("documents:entities.version"));
  const [version] = await db.select().from(fileVersions).where(eq(fileVersions.id, vid));
  if (!version) throw notFound(msg("documents:entities.version"));
  const r = await loadFile(db, pid, version.fileId, user);
  return { ...r, version };
}

export function requireView(tree: FolderTree, a: ProjectAccess, file: FileRow) {
  const perm = tree.permission(a.principal, file.folderId);
  if (can(perm.level, "view")) return;
  if (perm.canUpload && file.createdBy === a.user.id) return;
  throw notFound(msg("documents:entities.file"));
}

function sendStream(reply: FastifyReply, stream: NodeJS.ReadableStream, name: string, size: number) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  reply.header("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  reply.header("Content-Length", String(size));
  reply.header("Content-Type", "application/octet-stream");
  return reply.send(stream);
}

export function cleanFileName(raw: string): string {
  const base = path.basename(raw.replace(/\\/g, "/")).trim();
  if (!base || base === "." || base === ".." || /[<>:"|?*\x00-\x1f]/.test(base)) return "";
  return base.normalize("NFC");
}

export function toVersionDto(v: VersionRow, names: Map<string, string>): FileVersionDto {
  return {
    id: v.id,
    fileId: v.fileId,
    version: v.version,
    size: v.size,
    sha256: v.sha256,
    uploadedBy: v.uploadedBy ?? "",
    uploadedByName: v.uploadedBy ? names.get(v.uploadedBy) : undefined,
    uploadedAt: v.uploadedAt.toISOString(),
    comment: v.comment,
    derivativeStatus: v.derivativeStatus,
    derivativeError: v.derivativeError,
    ifcSummary: v.ifcSummary,
  };
}

export function toFileDto(f: FileRow, v: VersionRow, names: Map<string, string>): FileDto {
  return {
    id: f.id,
    folderId: f.folderId,
    name: f.name,
    description: f.description ?? null,
    extension: splitExtension(f.name).extension.toLowerCase(),
    currentVersion: f.currentVersion,
    attributes: f.attributes,
    createdAt: f.createdAt.toISOString(),
    createdBy: f.createdBy ?? "",
    latest: toVersionDto(v, names),
  };
}
