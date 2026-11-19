import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { can, splitExtension, validateAttributes, validateName, type CdeCodeWarningDto } from "@sitekeep/shared";
import type { AppDeps } from "../../app/deps.js";
import { FolderTree, isUuid, projectAccess, requireAction, requireProjectAdmin, userNames, type ProjectAccess } from "../../core/security/access.js";
import { audit } from "../../core/platform/audit.js";
import type { Db } from "../../db/index.js";
import { fileVersions, files } from "../../db/schema.js";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../../core/platform/http.js";
import { msg, render, requestLanguage, tFor } from "../../i18n/index.js";
import type { StoredObject } from "../../core/platform/storage.js";
import { standardForFolder } from "../../modules/documents/naming-routes.js";
import { GATE_MESSAGE, assertDirectWriteAllowed, folderGate } from "../../workflow/service.js";
import { effectiveDefinitions } from "./attributes.js";
import { addVersion, afterVersionAdded, type FileRow } from "../../files/new-version.js";
import { isModelFile } from "../../files/model-formats.js";
import { queueFailedConversions, queueVersionConversion } from "../../files/model-backfill.js";
import { checkDocumentCode, checkMove, checkUpload } from "../../cde/guards.js";
import { documentCodeWarning, registerNewFileCode } from "../../cde/document-code.js";
import { clientInfo, recordTransition, recordView } from "../../cde/events.js";
import { cdeStateOf } from "../../cde/state.js";
import { warningDtos } from "../../cde/codes.js";
import { cleanFileName, toFileDto, toVersionDto } from "./mapper.js";
import { supersessionsOf, type VersionSupersessions } from "../../cde/supersessions.js";

/** Only the non-empty sides go into the version DTO. */
function withLinks(s: VersionSupersessions | undefined) {
  return {
    ...(s?.supersededBy.length ? { supersededBy: s.supersededBy } : {}),
    ...(s?.supersedes.length ? { supersedes: s.supersedes } : {}),
  };
}
import { ensureGeometryUpgrade } from "../../model/service.js";

export async function fileRoutes(api: FastifyInstance, deps: AppDeps) {
  const { db, storage, jobs } = deps;

  /**
   * Upload one or more files into a folder. A file with the same name in the folder gets a
   * new version. Fields (send before the files): comment, attributes (JSON object),
   * suitabilityCode and revisionCode (ISO 19650 codes of the new versions, cde/codes.ts).
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
    const results: {
      name: string;
      ok: boolean;
      errors: string[];
      fileId?: string;
      version?: number;
      conflict?: unknown;
      /** ISO-3: the document code is held by another document (enforcement off). */
      warning?: unknown;
      /** ISO-2: suitability / revision codes that do not fit the folder's state (enforcement off). */
      warnings?: CdeCodeWarningDto[];
    }[] = [];
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
    // ISO 19650 codes of the new versions (checked against the folder's state in addVersion).
    const codes = { suitabilityCode: fields.suitabilityCode?.trim() || null, revisionCode: fields.revisionCode?.trim() || null };

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
        const r = await addVersion(db, a, folderId, s.name, s.obj, comment, attributes, can(perm.level, "edit"), defs, { lang, codes });
        // Enforcement off (D-8): a code held by another document (ISO-3) and suitability / revision
        // codes that do not fit the state (ISO-2) are stored with warnings.
        const warning = await documentCodeWarning(db, r.file, a.principal);
        const warnings = warningDtos(lang, r.codeWarnings);
        results.push({
          name: s.name,
          ok: true,
          errors: [],
          fileId: r.file.id,
          version: r.version.version,
          ...(warning ? { warning } : {}),
          ...(warnings.length ? { warnings } : {}),
        });
        await afterVersionAdded(db, jobs, a, r);
      } catch (err) {
        await storage.remove(s.obj.key);
        const message = err instanceof HttpError ? (err.msg ? render(lang, err.msg) : err.message) : t("documents:errors.saveFailed");
        if (!(err instanceof HttpError)) req.log.error(err);
        // A document code held by another document: the client shows where it is (ISO-3).
        const codeConflict = err instanceof HttpError && (err.details as { kind?: string } | undefined)?.kind === "document_code";
        results.push({ name: s.name, ok: false, errors: [message], ...(codeConflict ? { conflict: (err as HttpError).details } : {}) });
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
    // ISO-12: what replaced each version and what it replaced, linked where the caller may look.
    const links = await supersessionsOf(db, a.project.id, versions.map((v) => v.id), tree, a);
    const dto = (v: (typeof versions)[number]) => ({ ...toVersionDto(v, names), ...withLinks(links.get(v.id)) });
    return { ...toFileDto(file, current, names), latest: dto(current), versions: versions.map(dto) };
  });

  api.patch<{ Params: { pid: string; id: string } }>("/projects/:pid/files/:id", async (req) => {
    const { a, file, tree } = await loadFile(db, req.params.pid, req.params.id, req.user!);
    const body = z
      .object({
        name: z.string().trim().min(1).max(250).optional(),
        folderId: z.string().uuid().optional(),
        attributes: z.record(z.string(), z.string()).optional(),
        description: z.string().trim().max(500).nullable().optional(),
        /** Reason for a change that needs one (e.g. renaming a document that is shared). */
        reason: z.string().trim().max(500).optional(),
      })
      .parse(req.body);
    requireAction(tree, a, file.folderId, "edit");
    const description = body.description === undefined ? file.description : body.description || null;
    const targetFolder = body.folderId ?? file.folderId;
    const moved = !!body.folderId && body.folderId !== file.folderId;
    const lang = requestLanguage(req);
    const guard = { projectId: a.project.id, access: a, tree, source: "move", lang, reason: body.reason ?? null } as const;
    if (moved) {
      requireAction(tree, a, body.folderId!, "upload");
      // ISO 19650 transition rules (enforced projects): a move is the transition between the two states.
      await checkMove(db, { ...guard, fileId: file.id, fromFolderId: file.folderId, toFolderId: body.folderId! });
      // The folder's review gate still applies; the state part of the gate was decided by checkMove
      // (a move inside one state is no transition).
      const gate = await folderGate(db, tree, body.folderId!);
      if (gate.gated && !gate.message) throw forbidden(GATE_MESSAGE);
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
    let documentCode = file.documentCode;
    if (newName !== file.name || targetFolder !== file.folderId) {
      const standard = await standardForFolder(db, tree, targetFolder);
      if (standard) {
        const r = validateName(standard, newName, lang);
        if (!r.ok) throw badRequest(msg("documents:errors.nameNotStandard", { errors: r.errors.join("; ") }), r);
      }
      const checked = await checkDocumentCode(db, { ...guard, folderId: targetFolder, name: newName, fileId: file.id, containerId: file.containerId });
      documentCode = checked.documentCode ?? documentCode;
    }
    const [row] = await db
      .update(files)
      .set({
        name: newName,
        folderId: targetFolder,
        attributes,
        description,
        documentCode,
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
    if (moved)
      await audit(db, {
        projectId: a.project.id,
        userId: a.user.id,
        action: "file.moved",
        targetType: "file",
        targetId: file.id,
        details: { name: newName, fromFolderId: file.folderId, toFolderId: targetFolder },
      });
    if (moved)
      await recordTransition(db, {
        projectId: a.project.id,
        userId: a.user.id,
        fileId: file.id,
        fromFolderId: file.folderId,
        toFolderId: targetFolder,
        fromState: cdeStateOf(tree, file.folderId),
        toState: cdeStateOf(tree, targetFolder),
        mode: "direct",
        client: clientInfo(req),
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
    // A copy is a new document (its own container); the CDE guards decide like for an upload.
    const guard = { projectId: a.project.id, access: a, tree, source: "copy", lang: requestLanguage(req) } as const;
    await checkUpload(db, { ...guard, folderId: body.folderId, name, existingFileId: null });
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
      const { documentCode } = await checkDocumentCode(tx as unknown as Db, {
        ...guard,
        folderId: body.folderId,
        name,
        fileId: null,
        containerId: null,
      });
      const [inserted] = await tx
        .insert(files)
        .values({
          projectId: a.project.id,
          folderId: body.folderId,
          name,
          attributes: file.attributes,
          documentCode,
          createdBy: a.user.id,
        })
        .returning();
      const newFile = await registerNewFileCode(tx as unknown as Db, inserted!, "copy");
      const pendingDerivative = isModelFile(name);
      const [version] = await tx
        .insert(fileVersions)
        .values({
          fileId: newFile.id,
          version: 1,
          storageKey: source.storageKey,
          size: source.size,
          sha256: source.sha256,
          uploadedBy: a.user.id,
          comment: render(requestLanguage(req), msg("documents:messages.copiedFrom", { name: file.name })),
          derivativeStatus: pendingDerivative ? "pending" : "none",
        })
        .returning();
      return { file: newFile, version: version! };
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
    requireDownload(tree, a, file);
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

  /**
   * The IFC a module converted a version to (Revit .rvt → IFC, docs/features/MODEL_FORMATS.md), kept since the
   * conversion. Same permission and audit entry as downloading the file itself.
   */
  api.get<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/ifc", async (req, reply) => {
    const { a, file, version, tree } = await loadVersion(db, req.params.pid, req.params.vid, req.user!);
    requireDownload(tree, a, file);
    let size: number | null = null;
    if (version.ifcKey) size = await storage.size(version.ifcKey).catch(() => null);
    if (!version.ifcKey || size === null) throw notFound(msg("documents:errors.ifcNotKept"));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "file.downloaded",
      targetType: "file",
      targetId: file.id,
      details: { version: version.version, format: "ifc" },
    });
    return sendStream(reply, storage.get(version.ifcKey), `${splitExtension(file.name).base}.ifc`, size);
  });

  /**
   * "Convert again" (project administrators): converts a version of a file a module converts (.rvt) once more with
   * the converter installed now; a ready model stays open until the new one replaces it.
   */
  api.post<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/convert-again", async (req) => {
    const { a, file, version } = await loadVersion(db, req.params.pid, req.params.vid, req.user!);
    requireProjectAdmin(a);
    const refused = await queueVersionConversion(db, jobs, version, file.name);
    if (refused === "notConvertible") throw badRequest(msg("documents:errors.notConvertible"));
    if (refused === "busy") throw conflict(msg("documents:errors.conversionBusy"));
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "file.model_reconverted",
      targetType: "file",
      targetId: file.id,
      details: { version: version.version, status: version.derivativeStatus },
    });
    return { queued: 1 };
  });

  /** "Convert failed models again" for the whole project (project administrators). */
  api.post<{ Params: { pid: string } }>("/projects/:pid/model-conversions/retry-failed", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const queued = await queueFailedConversions(db, jobs, a.project.id);
    await audit(db, {
      projectId: a.project.id,
      userId: a.user.id,
      action: "file.model_retry_failed",
      targetType: "project",
      targetId: a.project.id,
      details: { queued },
    });
    return { queued };
  });

  /** Viewer derivative (That Open Fragments) of an IFC version. */
  api.get<{ Params: { pid: string; vid: string } }>("/projects/:pid/versions/:vid/model", async (req, reply) => {
    const { a, file, version, tree } = await loadVersion(db, req.params.pid, req.params.vid, req.user!);
    requireView(tree, a, file);
    if (version.derivativeStatus !== "ready" || !version.derivativeKey)
      throw conflict(msg("documents:errors.modelNotReady", { status: version.derivativeStatus }));
    await recordView(db, { projectId: a.project.id, userId: a.user.id, fileId: file.id, versionId: version.id, kind: "model", client: clientInfo(req) });
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
      .filter((r) => isModelFile(r.files.name))
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

/** Download permission on the file (or its own uploader); 404 when the caller cannot even see it. */
export function requireDownload(tree: FolderTree, a: ProjectAccess, file: FileRow) {
  const perm = tree.permission(a.principal, file.folderId);
  const own = perm.canUpload && file.createdBy === a.user.id;
  if (can(perm.level, "download") || own) return;
  if (!can(perm.level, "view")) throw notFound(msg("documents:entities.file"));
  throw forbidden(msg("documents:errors.noDownloadPermission"));
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

export { cleanFileName, toFileDto, toVersionDto } from "./mapper.js";
