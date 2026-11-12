/**
 * OpenCDE Documents API 1.0 (https://github.com/buildingSMART/documents-API, swagger.yaml),
 * outside /api/v1 under /documents/1.0 (docs/features/OPENCDE.md):
 *
 *   POST /upload-documents                                   → upload_ui_url (CDE page)
 *   POST /upload-sessions/:sid                               upload_documents_url → DocumentsToUpload
 *   PUT|POST /upload-sessions/:sid/files/:fid/parts/:index   one part (content range)
 *   POST /upload-sessions/:sid/files/:fid/completion         → DocumentVersion (same service as uploads)
 *   POST /upload-sessions/:sid/files/:fid/cancellation       → 204
 *   POST /select-documents                                   → select_documents_url (CDE page)
 *   GET  /selections/:sid                                    selected_documents_url → SelectedDocuments
 *   GET  /documents/:did/versions                            document_versions
 *   GET  /documents/:did/versions/:n                         document_version
 *   GET  /documents/:did/versions/:n/metadata                document_version_metadata
 *   GET  /documents/:did/versions/:n/download                document_version_download
 *   POST /document-versions                                  latest versions of tracked documents (ETag)
 *
 * Every call needs a Bearer token with `documents` (upload and read) or `documents:read` and works
 * with the user's own folder permissions. Nothing calls out: parts go to the CDE's own storage.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { can, OPENCDE_DOCS_LIMITS, validateAttributes, validateName } from "@sitekeep/shared";
import type { ResolvedDeps } from "../app/deps.js";
import { FolderTree, projectAccess, requireAction, userNames, type AuthUser } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import type { Db } from "../db/index.js";
import { attributeDefinitions, files, fileVersions, opencdeDocSessionFiles, opencdeDocSessions, opencdeUploadParts, tokens } from "../db/schema.js";
import { addVersion, afterVersionAdded, newVersionBlocker, type FileRow, type VersionRow } from "../files/new-version.js";
import { badRequest, conflict, forbidden, notFound } from "../core/platform/http.js";
import { publicBaseUrl } from "../oauth/config.js";
import { setOpenCdeCors } from "../oauth/cors.js";
import { effectiveDefinitions } from "../modules/documents/attributes.js";
import { standardForFolder } from "../modules/documents/naming-routes.js";
import { assertDirectWriteAllowed } from "../workflow/service.js";
import {
  callbackProblem,
  decodeContext,
  documentsBase,
  documentVersionDto,
  dropParts,
  encodeContext,
  loadApiSession,
  metadataEntries,
  newKey,
  purgeExpiredSessions,
  requireDocumentsAccess,
  type DocSessionFileRow,
  type DocSessionRow,
} from "./common.js";
import { hashToken } from "../core/security/auth.js";
import { DEFAULT_LANGUAGE, msg, render, requestLanguage } from "../i18n/index.js";

const callbackSchema = z.object({ url: z.string().min(1).max(2000), expires_in: z.number().int().positive() });

const uploadDocumentsSchema = z.object({
  callback: callbackSchema,
  server_context: z.string().max(500).nullish(),
  files: z
    .array(
      z.object({
        file_name: z.string().trim().min(1).max(250),
        session_file_id: z.string().min(1).max(200),
        document_id: z.string().min(1).max(100).nullish(),
      }),
    )
    .min(1)
    .max(OPENCDE_DOCS_LIMITS.maxFiles),
});

const selectDocumentsSchema = z.object({
  callback: callbackSchema,
  server_context: z.string().max(500).nullish(),
  supported_file_extensions: z.array(z.string().max(20)).max(50).nullish(),
});

const uploadFileDetailsSchema = z.object({
  files: z
    .array(z.object({ size_in_bytes: z.number().int().nonnegative(), session_file_id: z.string().min(1).max(200) }))
    .min(1)
    .max(OPENCDE_DOCS_LIMITS.maxFiles),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function documentsApiRoutes(app: FastifyInstance, deps: ResolvedDeps) {
  const { db, storage, jobs, oauth: opts } = deps;
  const maxSize = deps.maxUploadBytes ?? 20 * 1024 * 1024 * 1024;
  const web = (req: FastifyRequest) => publicBaseUrl(opts, req);

  /** Client application name for the pages and the audit log. */
  async function clientLabel(user: AuthUser): Promise<string> {
    const [t] = user.token ? await db.select({ name: tokens.name }).from(tokens).where(eq(tokens.id, user.token.id)) : [];
    return t?.name || render(DEFAULT_LANGUAGE, msg("opencde:defaults.accessToken")); // stored with the session
  }

  /** Common start of both flows: callback rules, page link, session row, audit. */
  async function startSession(
    req: FastifyRequest,
    user: AuthUser,
    kind: DocSessionRow["kind"],
    body: { callback: { url: string; expires_in: number }; server_context?: string | null; supported_file_extensions?: string[] | null },
  ) {
    const problem = await callbackProblem(db, user, body.callback.url);
    if (problem) throw badRequest(problem);
    await purgeExpiredSessions(db, storage);
    const now = Date.now();
    const key = newKey();
    const callbackSeconds = Math.min(body.callback.expires_in, OPENCDE_DOCS_LIMITS.callbackMaxSeconds);
    const uiSeconds = Math.min(OPENCDE_DOCS_LIMITS.uiSeconds, callbackSeconds);
    const ctx = await usableContext(user, body.server_context);
    const [s] = await db
      .insert(opencdeDocSessions)
      .values({
        kind,
        userId: user.id,
        oauthClientId: user.token?.oauthClientId ?? null,
        clientName: await clientLabel(user),
        uiKeyHash: hashToken(key),
        uiExpiresAt: new Date(now + uiSeconds * 1000),
        callbackUrl: body.callback.url,
        callbackExpiresAt: new Date(now + callbackSeconds * 1000),
        supportedExtensions: (body.supported_file_extensions ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean),
        projectId: ctx.projectId,
        folderId: ctx.folderId,
        expiresAt: new Date(now + callbackSeconds * 1000),
      })
      .returning();
    const page = kind === "upload" ? "upload" : "select";
    return { session: s!, url: `${web(req)}/opencde/${page}?key=${key}`, expiresIn: uiSeconds };
  }

  /** server_context of an earlier exchange, if the project and folder are still the user's. */
  async function usableContext(user: AuthUser, value: string | null | undefined) {
    const ctx = decodeContext(value);
    if (!ctx.projectId) return { projectId: null, folderId: null };
    try {
      const a = await projectAccess(db, ctx.projectId, user);
      const tree = await FolderTree.load(db, a.project.id);
      return { projectId: a.project.id, folderId: ctx.folderId && tree.byId.has(ctx.folderId) ? ctx.folderId : null };
    } catch {
      return { projectId: null, folderId: null };
    }
  }

  async function auditSession(s: DocSessionRow, action: string, details: Record<string, unknown> = {}) {
    await audit(db, {
      projectId: s.projectId,
      userId: s.userId,
      action,
      targetType: "opencde_session",
      targetId: s.id,
      details: { client: s.clientName, kind: s.kind, ...details },
    });
  }

  async function loadSessionFile(s: DocSessionRow, fileRowId: string): Promise<DocSessionFileRow> {
    if (!UUID.test(fileRowId)) throw notFound(msg("opencde:entities.file"));
    const [f] = await db
      .select()
      .from(opencdeDocSessionFiles)
      .where(and(eq(opencdeDocSessionFiles.id, fileRowId), eq(opencdeDocSessionFiles.sessionId, s.id)));
    if (!f) throw notFound(msg("opencde:entities.file"));
    return f;
  }

  /** The file and version behind /documents/:did/versions/:n, if the caller may see it. */
  async function loadDocument(user: AuthUser, did: string) {
    if (!UUID.test(did)) throw notFound(msg("opencde:entities.document"));
    const [file] = await db.select().from(files).where(and(eq(files.id, did), isNull(files.deletedAt)));
    if (!file) throw notFound(msg("opencde:entities.document"));
    const a = await projectAccess(db, file.projectId, user);
    const tree = await FolderTree.load(db, file.projectId);
    if (!tree.byId.has(file.folderId)) throw notFound(msg("opencde:entities.document"));
    const perm = tree.permission(a.principal, file.folderId);
    const own = perm.canUpload && file.createdBy === user.id;
    if (!can(perm.level, "view") && !own) throw notFound(msg("opencde:entities.document"));
    return { a, tree, file, perm, own };
  }

  async function loadDocumentVersion(user: AuthUser, did: string, n: string) {
    const d = await loadDocument(user, did);
    const num = Number(n.replace(/^v/i, ""));
    if (!Number.isInteger(num) || num < 1) throw notFound(msg("opencde:entities.version"));
    const [version] = await db
      .select()
      .from(fileVersions)
      .where(and(eq(fileVersions.fileId, d.file.id), eq(fileVersions.version, num)));
    if (!version) throw notFound(msg("opencde:entities.version"));
    return { ...d, version };
  }

  /** Visible latest versions of files (selection results, document query). */
  async function versionsVisible(user: AuthUser, versionIds: string[]): Promise<{ file: FileRow; version: VersionRow }[]> {
    if (!versionIds.length) return [];
    const rows = await db
      .select()
      .from(fileVersions)
      .innerJoin(files, eq(files.id, fileVersions.fileId))
      .where(and(inArray(fileVersions.id, versionIds), isNull(files.deletedAt)));
    const out: { file: FileRow; version: VersionRow }[] = [];
    const trees = new Map<string, { tree: FolderTree; a: Awaited<ReturnType<typeof projectAccess>> } | null>();
    for (const r of rows) {
      const pid = r.files.projectId;
      if (!trees.has(pid)) {
        try {
          trees.set(pid, { a: await projectAccess(db, pid, user), tree: await FolderTree.load(db, pid) });
        } catch {
          trees.set(pid, null);
        }
      }
      const t = trees.get(pid);
      if (!t || !t.tree.byId.has(r.files.folderId)) continue;
      const perm = t.tree.permission(t.a.principal, r.files.folderId);
      if (!can(perm.level, "view") && !(perm.canUpload && r.files.createdBy === user.id)) continue;
      out.push({ file: r.files, version: r.file_versions });
    }
    // Keep the order of the selection.
    return versionIds.flatMap((id) => out.filter((o) => o.version.id === id));
  }

  // ---- JSON endpoints ------------------------------------------------------------------------------

  await app.register(async (docs) => {
    docs.addHook("onSend", async (_req, reply) => {
      setOpenCdeCors(reply);
      reply.header("Cache-Control", "no-store");
    });

    docs.post("/documents/1.0/upload-documents", async (req) => {
      const user = requireDocumentsAccess(req, "write");
      const body = uploadDocumentsSchema.parse(req.body);
      const ids = new Set(body.files.map((f) => f.session_file_id));
      if (ids.size !== body.files.length) throw badRequest(msg("opencde:errors.sessionFileIdsUnique"));
      // document_id: a new version of a document of this CDE that the user can see.
      for (const f of body.files) {
        if (!f.document_id) continue;
        try {
          await loadDocument(user, f.document_id);
        } catch {
          throw badRequest(msg("opencde:errors.documentIdNotFound", { id: f.document_id }));
        }
      }
      const { session, url, expiresIn } = await startSession(req, user, "upload", body);
      await db.insert(opencdeDocSessionFiles).values(
        body.files.map((f) => ({
          sessionId: session.id,
          sessionFileId: f.session_file_id,
          fileName: f.file_name,
          documentId: f.document_id ?? null,
        })),
      );
      await auditSession(session, "opencde.upload_started", { files: body.files.map((f) => f.file_name) });
      return { upload_ui_url: url, expires_in: expiresIn, max_size_in_bytes: maxSize };
    });

    docs.post("/documents/1.0/select-documents", async (req) => {
      const user = requireDocumentsAccess(req, "read");
      const body = selectDocumentsSchema.parse(req.body);
      const { session, url, expiresIn } = await startSession(req, user, "select", body);
      await auditSession(session, "opencde.select_started");
      return { select_documents_url: url, expires_in: expiresIn };
    });

    /** upload_documents_url: file sizes in, part instructions out. */
    docs.post<{ Params: { sid: string } }>("/documents/1.0/upload-sessions/:sid", async (req) => {
      const user = requireDocumentsAccess(req, "write");
      const s = await loadApiSession(db, req.params.sid, user, "upload");
      if (s.status === "pending") throw conflict(msg("opencde:errors.uploadPending"));
      if (s.status === "cancelled") throw conflict(msg("opencde:errors.uploadCancelled"));
      const body = uploadFileDetailsSchema.parse(req.body);
      const rows = await db.select().from(opencdeDocSessionFiles).where(eq(opencdeDocSessionFiles.sessionId, s.id));
      const api = documentsBase(opts, req);
      const out = [];
      for (const f of body.files) {
        const row = rows.find((r) => r.sessionFileId === f.session_file_id);
        if (!row) throw badRequest(msg("opencde:errors.unknownSessionFileId", { id: f.session_file_id }));
        if (row.status === "completed") throw conflict(msg("opencde:errors.fileAlreadyUploaded", { name: row.targetName ?? row.fileName }));
        if (row.status === "cancelled") throw conflict(msg("opencde:errors.fileUploadCancelled", { name: row.targetName ?? row.fileName }));
        if (f.size_in_bytes > maxSize) throw badRequest(msg("opencde:errors.fileTooLarge", { name: row.fileName, max: maxSize }));
        if (f.size_in_bytes === 0) throw badRequest(msg("opencde:errors.fileEmpty", { name: row.fileName }));
        const partSize = deps.documentsPartBytes ?? OPENCDE_DOCS_LIMITS.partBytes;
        // A changed size (export finished later, retry) starts the parts again.
        if (row.sizeInBytes !== f.size_in_bytes || row.partSize !== partSize) {
          await dropParts(db, storage, [row.id]);
          await db
            .update(opencdeDocSessionFiles)
            .set({ sizeInBytes: f.size_in_bytes, partSize, status: "uploading" })
            .where(eq(opencdeDocSessionFiles.id, row.id));
        }
        const fileUrl = `${api}/upload-sessions/${s.id}/files/${row.id}`;
        const parts = [];
        for (let start = 0, i = 0; start < f.size_in_bytes; start += partSize, i++) {
          const end = Math.min(start + partSize, f.size_in_bytes) - 1;
          parts.push({
            url: `${fileUrl}/parts/${i}`,
            http_method: "PUT" as const,
            additional_headers: { values: [{ name: "Content-Length", value: String(end - start + 1) }] },
            include_authorization: true,
            content_range_start: start,
            content_range_end: end,
          });
        }
        out.push({
          session_file_id: row.sessionFileId,
          upload_file_parts: parts,
          upload_completion: { url: `${fileUrl}/completion` },
          upload_cancellation: { url: `${fileUrl}/cancellation` },
        });
      }
      await auditSession(s, "opencde.upload_instructions", {
        files: body.files.map((f) => ({ id: f.session_file_id, size: f.size_in_bytes })),
      });
      return { server_context: encodeContext(s.projectId, s.folderId), documents_to_upload: out };
    });

    /** selected_documents_url. */
    docs.get<{ Params: { sid: string } }>("/documents/1.0/selections/:sid", async (req) => {
      const user = requireDocumentsAccess(req, "read");
      const s = await loadApiSession(db, req.params.sid, user, "select");
      if (s.status !== "completed") throw conflict(msg("opencde:errors.selectionPending"));
      const api = documentsBase(opts, req);
      const rows = await versionsVisible(user, s.selectedVersionIds);
      await auditSession(s, "opencde.selection_read", { documents: rows.length });
      return {
        server_context: encodeContext(s.projectId, s.folderId),
        documents: rows.map((r) => documentVersionDto(api, web(req), r.file, r.version)),
      };
    });

    docs.get<{ Params: { did: string } }>("/documents/1.0/documents/:did/versions", async (req) => {
      const user = requireDocumentsAccess(req, "read");
      const { file } = await loadDocument(user, req.params.did);
      const versions = await db.select().from(fileVersions).where(eq(fileVersions.fileId, file.id)).orderBy(desc(fileVersions.version));
      const api = documentsBase(opts, req);
      return { documents: versions.map((v) => documentVersionDto(api, web(req), file, v)) };
    });

    docs.get<{ Params: { did: string; n: string } }>("/documents/1.0/documents/:did/versions/:n", async (req) => {
      const user = requireDocumentsAccess(req, "read");
      const { file, version } = await loadDocumentVersion(user, req.params.did, req.params.n);
      return documentVersionDto(documentsBase(opts, req), web(req), file, version);
    });

    docs.get<{ Params: { did: string; n: string } }>("/documents/1.0/documents/:did/versions/:n/metadata", async (req) => {
      const user = requireDocumentsAccess(req, "read");
      const { a, tree, file, version } = await loadDocumentVersion(user, req.params.did, req.params.n);
      const names = await userNames(db, [version.uploadedBy]);
      const defs = await db
        .select({ name: attributeDefinitions.name, type: attributeDefinitions.type })
        .from(attributeDefinitions)
        .where(eq(attributeDefinitions.projectId, file.projectId));
      return {
        metadata: metadataEntries(file, version, tree, {
          projectName: a.project.name,
          uploadedByName: version.uploadedBy ? (names.get(version.uploadedBy) ?? null) : null,
          attributeTypes: new Map(defs.map((d) => [d.name, d.type])),
        }, requestLanguage(req)),
      };
    });

    docs.get<{ Params: { did: string; n: string } }>("/documents/1.0/documents/:did/versions/:n/download", async (req, reply) => {
      const user = requireDocumentsAccess(req, "read");
      const { a, file, version, perm, own } = await loadDocumentVersion(user, req.params.did, req.params.n);
      if (!can(perm.level, "download") && !own) throw forbidden(msg("opencde:errors.noDownloadPermission"));
      await audit(db, {
        projectId: a.project.id,
        userId: user.id,
        action: "file.downloaded",
        targetType: "file",
        targetId: file.id,
        details: { version: version.version, via: "opencde-documents", client: user.token?.oauthClientId ?? "api" },
      });
      const ascii = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
      reply.header("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
      reply.header("Content-Length", String(version.size));
      reply.header("Content-Type", "application/octet-stream");
      return reply.send(storage.get(version.storageKey));
    });

    /** Document query: latest version of each tracked document the caller can see (ETag, 304). */
    docs.post("/documents/1.0/document-versions", async (req, reply) => {
      const user = requireDocumentsAccess(req, "read");
      const body = z.object({ document_ids: z.array(z.string().max(100)).max(1000) }).parse(req.body);
      const ids = [...new Set(body.document_ids.filter((d) => UUID.test(d)))];
      const latest = ids.length
        ? await db
            .select({ id: fileVersions.id })
            .from(files)
            .innerJoin(fileVersions, and(eq(fileVersions.fileId, files.id), eq(fileVersions.version, files.currentVersion)))
            .where(and(inArray(files.id, ids), isNull(files.deletedAt)))
        : [];
      const rows = await versionsVisible(
        user,
        latest.map((l) => l.id),
      );
      const etag = `"${createHash("sha256")
        .update(rows.map((r) => `${r.file.id}:${r.version.id}`).sort().join(","))
        .digest("hex")
        .slice(0, 32)}"`;
      reply.header("ETag", etag);
      if (req.headers["if-none-match"] === etag) return reply.status(304).send();
      const api = documentsBase(opts, req);
      return { versions: rows.map((r) => documentVersionDto(api, web(req), r.file, r.version)) };
    });

    // CORS preflight of every Documents endpoint; unknown paths and versions: JSON 404.
    docs.all("/documents/*", async (req, reply) =>
      req.method === "OPTIONS"
        ? reply.status(204).send()
        : reply.status(404).send({ error: "not_found", message: render(requestLanguage(req), msg("opencde:errors.resourceNotFound")) }),
    );
  });

  // ---- Parts, completion, cancellation: raw bodies (any or no content type) ------------------------

  await app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
    raw.addHook("onSend", async (_req, reply) => {
      setOpenCdeCors(reply);
      reply.header("Cache-Control", "no-store");
    });

    const partRoute = async (req: FastifyRequest<{ Params: { sid: string; fid: string; index: string } }>, reply: FastifyReply) => {
      const user = requireDocumentsAccess(req, "write");
      const s = await loadApiSession(db, req.params.sid, user, "upload");
      const row = await loadSessionFile(s, req.params.fid);
      if (row.status !== "uploading" || !row.sizeInBytes || !row.partSize)
        throw conflict(msg(row.status === "completed" ? "opencde:errors.thisFileAlreadyUploaded" : "opencde:errors.sendSizesFirst"));
      const index = Number(req.params.index);
      const count = Math.ceil(row.sizeInBytes / row.partSize);
      if (!Number.isInteger(index) || index < 0 || index >= count) throw notFound(msg("opencde:entities.part"));
      const expected = Math.min(row.partSize, row.sizeInBytes - index * row.partSize);
      const declared = req.headers["content-length"];
      if (declared !== undefined && Number(declared) !== expected)
        throw badRequest(msg("opencde:errors.partSizeDeclared", { index, expected, declared }));
      const body = (req.body as AsyncIterable<Buffer> | undefined) ?? Readable.from([]);
      async function* limited() {
        let received = 0;
        for await (const chunk of body) {
          received += chunk.length;
          if (received > expected) throw badRequest(msg("opencde:errors.partTooLarge", { index, expected }));
          yield chunk;
        }
      }
      const obj = await storage.put(Readable.from(limited()), `opencde-uploads/${s.id}`);
      if (obj.size !== expected) {
        await storage.remove(obj.key);
        throw badRequest(msg("opencde:errors.partSizeReceived", { index, expected, size: obj.size }));
      }
      const [old] = await db
        .select()
        .from(opencdeUploadParts)
        .where(and(eq(opencdeUploadParts.fileRowId, row.id), eq(opencdeUploadParts.partIndex, index)));
      if (old) {
        await storage.remove(old.storageKey).catch(() => undefined);
        await db.update(opencdeUploadParts).set({ storageKey: obj.key, size: obj.size }).where(and(eq(opencdeUploadParts.fileRowId, row.id), eq(opencdeUploadParts.partIndex, index)));
      } else {
        await db.insert(opencdeUploadParts).values({ fileRowId: row.id, partIndex: index, storageKey: obj.key, size: obj.size });
      }
      return reply.status(200).send();
    };
    raw.put("/documents/1.0/upload-sessions/:sid/files/:fid/parts/:index", partRoute);
    raw.post("/documents/1.0/upload-sessions/:sid/files/:fid/parts/:index", partRoute);

    raw.post<{ Params: { sid: string; fid: string } }>("/documents/1.0/upload-sessions/:sid/files/:fid/completion", async (req, reply) => {
      drain(req);
      const user = requireDocumentsAccess(req, "write");
      const s = await loadApiSession(db, req.params.sid, user, "upload");
      const row = await loadSessionFile(s, req.params.fid);
      const api = documentsBase(opts, req);
      if (row.status === "completed" && row.fileId && row.versionId) {
        const [r] = await db
          .select()
          .from(fileVersions)
          .innerJoin(files, eq(files.id, fileVersions.fileId))
          .where(eq(fileVersions.id, row.versionId));
        if (r) return documentVersionDto(api, web(req), r.files, r.file_versions);
      }
      if (row.status === "cancelled") throw conflict(msg("opencde:errors.thisFileUploadCancelled"));
      if (row.status !== "uploading" || !row.sizeInBytes || !row.partSize) throw conflict(msg("opencde:errors.uploadPartsFirst"));
      const parts = await db.select().from(opencdeUploadParts).where(eq(opencdeUploadParts.fileRowId, row.id)).orderBy(asc(opencdeUploadParts.partIndex));
      const count = Math.ceil(row.sizeInBytes / row.partSize);
      const missing = [...Array(count).keys()].filter((i) => !parts.some((p) => p.partIndex === i));
      if (missing.length) throw conflict(msg("opencde:errors.missingParts", { parts: missing.slice(0, 20).join(", ") }));
      if (!s.projectId || (!s.folderId && !row.documentId)) throw conflict(msg("opencde:errors.noTargetFolder"));

      // The same checks as the upload route, again: rights may have changed since the page.
      const a = await projectAccess(db, s.projectId, user);
      const tree = await FolderTree.load(db, a.project.id);
      let folderId = s.folderId ?? "";
      let name = row.targetName ?? row.fileName;
      let canEdit: boolean;
      if (row.documentId) {
        const [existing] = await db
          .select()
          .from(files)
          .where(and(eq(files.id, row.documentId), eq(files.projectId, a.project.id), isNull(files.deletedAt)));
        if (!existing || !tree.byId.has(existing.folderId)) throw notFound(msg("opencde:entities.document"));
        const blocker = await newVersionBlocker(db, tree, a, existing, requestLanguage(req));
        if (blocker) throw forbidden(blocker);
        folderId = existing.folderId;
        name = existing.name;
        canEdit = true;
      } else {
        const perm = requireAction(tree, a, folderId, "upload");
        await assertDirectWriteAllowed(db, tree, folderId);
        const standard = await standardForFolder(db, tree, folderId);
        if (standard) {
          const r = validateName(standard, name, requestLanguage(req));
          if (!r.ok) throw badRequest(msg("opencde:errors.namingStandard", { errors: r.errors.join("; ") }), r);
        }
        canEdit = can(perm.level, "edit");
      }
      const defs = await effectiveDefinitions(db, tree, folderId);
      const attributes = s.attributes;
      const attrErrors = validateAttributes(defs, attributes, { partial: true, lang: requestLanguage(req) });
      if (attrErrors.length) throw badRequest(attrErrors.map((e) => e.message).join(" "), attrErrors);

      async function* joined() {
        for (const p of parts) for await (const chunk of storage.get(p.storageKey)) yield chunk as Buffer;
      }
      const obj = await storage.put(Readable.from(joined()), `projects/${a.project.id}/files`);
      if (obj.size !== row.sizeInBytes) {
        await storage.remove(obj.key);
        throw badRequest(msg("opencde:errors.fileSizeMismatch", { expected: row.sizeInBytes, size: obj.size }));
      }
      let result: Awaited<ReturnType<typeof addVersion>>;
      try {
        result = await addVersion(db, a, folderId, name, obj, s.comment, attributes, canEdit, defs, { lang: requestLanguage(req) });
      } catch (err) {
        await storage.remove(obj.key);
        throw err;
      }
      await afterVersionAdded(db, jobs, a, result, { via: "opencde-documents", client: s.clientName });
      await dropParts(db, storage, [row.id]);
      await db
        .update(opencdeDocSessionFiles)
        .set({ status: "completed", fileId: result.file.id, versionId: result.version.id })
        .where(eq(opencdeDocSessionFiles.id, row.id));
      await finishIfDone(s);
      await auditSession(s, "opencde.upload_completed", { name, fileId: result.file.id, version: result.version.version, size: obj.size });
      reply.header("Content-Type", "application/json; charset=utf-8");
      return documentVersionDto(api, web(req), result.file, result.version);
    });

    raw.post<{ Params: { sid: string; fid: string } }>("/documents/1.0/upload-sessions/:sid/files/:fid/cancellation", async (req, reply) => {
      drain(req);
      const user = requireDocumentsAccess(req, "write");
      const s = await loadApiSession(db, req.params.sid, user, "upload");
      const row = await loadSessionFile(s, req.params.fid);
      if (row.status === "completed") throw conflict(msg("opencde:errors.cannotCancelUploaded"));
      await dropParts(db, storage, [row.id]);
      await db.update(opencdeDocSessionFiles).set({ status: "cancelled" }).where(eq(opencdeDocSessionFiles.id, row.id));
      await finishIfDone(s);
      await auditSession(s, "opencde.upload_cancelled", { name: row.targetName ?? row.fileName, by: "client" });
      return reply.status(204).send();
    });
  });

  /** Upload session closes when every file is completed or cancelled. */
  async function finishIfDone(s: DocSessionRow) {
    const rows = await db.select({ status: opencdeDocSessionFiles.status }).from(opencdeDocSessionFiles).where(eq(opencdeDocSessionFiles.sessionId, s.id));
    if (rows.every((r) => r.status === "completed" || r.status === "cancelled")) {
      const allCancelled = rows.every((r) => r.status === "cancelled");
      await db
        .update(opencdeDocSessions)
        .set({ status: allCancelled ? "cancelled" : "completed", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(opencdeDocSessions.id, s.id));
    }
  }
}

/** Completion and cancellation have no body; whatever a client sends is discarded. */
function drain(req: FastifyRequest) {
  const b = req.body as NodeJS.ReadableStream | undefined;
  if (b && typeof (b as Readable).resume === "function") (b as Readable).resume();
}

