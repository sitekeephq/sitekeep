/**
 * Browser side of the OpenCDE Documents API (docs/features/OPENCDE.md), under /api/v1/opencde. Only a
 * browser session of the user who owns the session may use these; the page link works once
 * (the first browser session that opens it) and only for a short time.
 *
 *   GET  /opencde/sessions/:key                                  session, application, files
 *   GET  /opencde/sessions/:key/projects/:pid/folders            folders with upload/view rights
 *   GET  /opencde/sessions/:key/projects/:pid/folders/:fid/rules naming standard, attributes, gate
 *   GET  /opencde/sessions/:key/projects/:pid/documents          latest versions (folder or search)
 *   POST /opencde/sessions/:key/upload                           "Gönder" → callback?upload_documents_url=
 *   POST /opencde/sessions/:key/select                           "Seçimi Gönder" → callback?selected_documents_url=
 *   POST /opencde/sessions/:key/cancel                           "İptal" → callback?user_cancelled_…=true
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  can,
  foldTr,
  OPENCDE_DOCS_LIMITS,
  OPENCDE_REVISION_KEY,
  OPENCDE_SUITABILITY_KEY,
  splitExtension,
  validateAttributes,
  validateName,
  type OpenCdeDocumentRowDto,
  type OpenCdeFolderDto,
  type OpenCdeRedirectDto,
  type OpenCdeSessionDto,
  type OpenCdeUploadRulesDto,
} from "@sitekeep/shared";
import type { ResolvedDeps } from "../app/deps.js";
import { FolderTree, projectAccess, requireAction, userNames } from "../core/security/access.js";
import { audit } from "../core/platform/audit.js";
import { hashToken } from "../core/security/auth.js";
import { files, fileVersions, oauthClients, opencdeDocSessionFiles, opencdeDocSessions } from "../db/schema.js";
import { cleanFileName } from "../modules/documents/files.js";
import { newVersionBlocker } from "../files/new-version.js";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../core/platform/http.js";
import { withParams } from "../oauth/redirect.js";
import { effectiveDefinitions } from "../modules/documents/attributes.js";
import { standardForFolder } from "../modules/documents/naming-routes.js";
import { GATE_MESSAGE, folderGate } from "../workflow/service.js";
import { callbackTarget, documentsBase, dropParts, expired, type DocSessionRow } from "./common.js";
import { msg, render, requestLanguage, tReq } from "../i18n/index.js";

const uploadInput = z.object({
  projectId: z.string().uuid(),
  folderId: z.string().uuid(),
  comment: z.string().max(2000).nullish(),
  revision: z.string().max(50).nullish(),
  suitability: z.string().max(50).nullish(),
  attributes: z.record(z.string(), z.string().max(1000)).optional(),
  names: z.record(z.string(), z.string().max(250)).default({}),
});

export async function opencdePageRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const { db, storage, oauth: opts } = deps;
  const maxSize = deps.maxUploadBytes ?? 20 * 1024 * 1024 * 1024;

  /**
   * The session behind a page link, for its owner's browser. The first browser session that
   * opens it claims it; others get 403. Unclaimed links expire after a few minutes.
   */
  async function pageSession(req: FastifyRequest<{ Params: { key: string } }>, opts2: { open?: boolean } = {}): Promise<DocSessionRow> {
    const user = req.user!;
    if (user.token?.kind !== "session") throw forbidden(msg("opencde:errors.browserOnly"));
    const key = req.params.key;
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(key)) throw notFound(msg("opencde:entities.link"));
    const [s] = await db.select().from(opencdeDocSessions).where(eq(opencdeDocSessions.uiKeyHash, hashToken(key)));
    if (!s) throw notFound(msg("opencde:entities.link"));
    if (s.userId !== user.id)
      throw forbidden(msg("opencde:errors.linkOtherUser"));
    const now = Date.now();
    if (!s.claimedAt) {
      if (s.uiExpiresAt.getTime() <= now) throw expired("link");
      const [claimed] = await db
        .update(opencdeDocSessions)
        .set({ claimedAt: new Date(), claimedBy: user.token.id, updatedAt: new Date() })
        .where(and(eq(opencdeDocSessions.id, s.id), isNull(opencdeDocSessions.claimedAt)))
        .returning();
      if (!claimed) return pageSession(req, opts2);
      return claimed;
    }
    if (s.claimedBy !== user.token.id) throw forbidden(msg("opencde:errors.linkOtherBrowser"));
    if (!opts2.open && s.expiresAt.getTime() <= now) throw expired("session");
    return s;
  }

  /** Actions on the page: still open, and the application still waits for the callback. */
  function requireOpen(s: DocSessionRow) {
    if (s.status !== "pending") throw conflict(msg("opencde:errors.alreadyCompleted"));
    if (s.callbackExpiresAt.getTime() <= Date.now()) throw expired("callback");
  }

  api.get<{ Params: { key: string } }>("/opencde/sessions/:key", async (req): Promise<OpenCdeSessionDto> => {
    const s = await pageSession(req, { open: true });
    const rows = await db.select().from(opencdeDocSessionFiles).where(eq(opencdeDocSessionFiles.sessionId, s.id));
    const [client] = s.oauthClientId
      ? await db.select({ name: oauthClients.name, description: oauthClients.description }).from(oauthClients).where(eq(oauthClients.id, s.oauthClientId))
      : [];
    const existingIds = rows.map((r) => r.documentId).filter((x): x is string => !!x);
    const existing = existingIds.length
      ? await db
          .select()
          .from(files)
          .where(and(inArray(files.id, existingIds), isNull(files.deletedAt)))
      : [];
    const trees = new Map<string, FolderTree>();
    for (const f of existing) if (!trees.has(f.projectId)) trees.set(f.projectId, await FolderTree.load(db, f.projectId));
    return {
      kind: s.kind,
      status: s.status,
      client: { name: client?.name ?? s.clientName, description: client?.description ?? null },
      callbackTarget: callbackTarget(s.callbackUrl, requestLanguage(req)),
      expiresAt: s.callbackExpiresAt.toISOString(),
      supportedExtensions: s.supportedExtensions,
      context: { projectId: s.projectId, folderId: s.folderId },
      maxSizeInBytes: maxSize,
      files: rows
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.fileName.localeCompare(b.fileName, "tr"))
        .map((r) => {
          const f = r.documentId ? existing.find((e) => e.id === r.documentId) : undefined;
          const tree = f ? trees.get(f.projectId) : undefined;
          return {
            id: r.id,
            sessionFileId: r.sessionFileId,
            fileName: r.fileName,
            targetName: r.targetName,
            existing:
              f && tree?.byId.has(f.folderId)
                ? {
                    fileId: f.id,
                    name: f.name,
                    projectId: f.projectId,
                    folderId: f.folderId,
                    folderPath: tree
                      .ancestry(f.folderId)
                      .map((id) => tree.get(id).name)
                      .join(" / "),
                    version: f.currentVersion,
                  }
                : null,
            existingError: r.documentId && !f ? tReq(req)("opencde:errors.documentToUpdateMissing") : null,
          };
        }),
    };
  });

  api.get<{ Params: { key: string; pid: string } }>("/opencde/sessions/:key/projects/:pid/folders", async (req): Promise<OpenCdeFolderDto[]> => {
    await pageSession(req);
    const a = await projectAccess(db, req.params.pid, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    const out: OpenCdeFolderDto[] = [];
    const walk = (parentId: string | null, path: string[]) => {
      for (const f of tree.children.get(parentId) ?? []) {
        if (!tree.visible(a.principal, f.id)) continue;
        const perm = tree.permission(a.principal, f.id);
        const p = [...path, f.name];
        out.push({ id: f.id, parentId: f.parentId, name: f.name, path: p.join(" / "), canUpload: perm.canUpload, canView: can(perm.level, "view") });
        walk(f.id, p);
      }
    };
    walk(null, []);
    return out;
  });

  api.get<{ Params: { key: string; pid: string; fid: string } }>(
    "/opencde/sessions/:key/projects/:pid/folders/:fid/rules",
    async (req): Promise<OpenCdeUploadRulesDto> => {
      await pageSession(req);
      const a = await projectAccess(db, req.params.pid, req.user!);
      const tree = await FolderTree.load(db, a.project.id);
      requireAction(tree, a, req.params.fid, "upload");
      const gate = await folderGate(db, tree, req.params.fid);
      return {
        standard: await standardForFolder(db, tree, req.params.fid),
        attributes: await effectiveDefinitions(db, tree, req.params.fid),
        gateMessage: gate.gated ? render(requestLanguage(req), GATE_MESSAGE) : null,
      };
    },
  );

  api.get<{ Params: { key: string; pid: string }; Querystring: { folderId?: string; q?: string } }>(
    "/opencde/sessions/:key/projects/:pid/documents",
    async (req): Promise<OpenCdeDocumentRowDto[]> => {
      await pageSession(req);
      const a = await projectAccess(db, req.params.pid, req.user!);
      const tree = await FolderTree.load(db, a.project.id);
      const q = foldTr(req.query.q?.trim() ?? "");
      const folderId = req.query.folderId;
      if (!q && !folderId) return [];
      if (folderId && !tree.byId.has(folderId)) throw notFound(msg("opencde:entities.folder"));
      const rows = await db
        .select()
        .from(files)
        .innerJoin(fileVersions, and(eq(fileVersions.fileId, files.id), eq(fileVersions.version, files.currentVersion)))
        .where(and(eq(files.projectId, a.project.id), isNull(files.deletedAt), ...(folderId && !q ? [eq(files.folderId, folderId)] : [])));
      const scope = folderId && q ? new Set([folderId, ...tree.descendants(folderId)]) : null;
      const visible = rows.filter((r) => {
        if (!tree.byId.has(r.files.folderId)) return false;
        if (scope && !scope.has(r.files.folderId)) return false;
        if (q && !foldTr(r.files.name).includes(q)) return false;
        const perm = tree.permission(a.principal, r.files.folderId);
        return can(perm.level, "view") || (perm.canUpload && r.files.createdBy === req.user!.id);
      });
      const names = await userNames(
        db,
        visible.map((r) => r.file_versions.uploadedBy),
      );
      return visible
        .slice(0, 500)
        .map((r) => {
          const perm = tree.permission(a.principal, r.files.folderId);
          return {
            fileId: r.files.id,
            versionId: r.file_versions.id,
            name: r.files.name,
            folderId: r.files.folderId,
            folderPath: tree
              .ancestry(r.files.folderId)
              .map((id) => tree.get(id).name)
              .join(" / "),
            version: r.file_versions.version,
            size: r.file_versions.size,
            uploadedAt: r.file_versions.uploadedAt.toISOString(),
            uploadedByName: r.file_versions.uploadedBy ? (names.get(r.file_versions.uploadedBy) ?? null) : null,
            canDownload: can(perm.level, "download") || (perm.canUpload && r.files.createdBy === req.user!.id),
          };
        })
        .sort((x, y) => x.folderPath.localeCompare(y.folderPath, "tr") || x.name.localeCompare(y.name, "tr"));
    },
  );

  /** "Gönder" on the upload page: every check of a normal upload, then back to the application. */
  api.post<{ Params: { key: string } }>("/opencde/sessions/:key/upload", async (req): Promise<OpenCdeRedirectDto> => {
    const s = await pageSession(req);
    if (s.kind !== "upload") throw notFound(msg("opencde:entities.link"));
    requireOpen(s);
    const body = uploadInput.parse(req.body);
    const a = await projectAccess(db, body.projectId, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    const rows = await db.select().from(opencdeDocSessionFiles).where(eq(opencdeDocSessionFiles.sessionId, s.id));
    const tl = tReq(req);
    const errors: Record<string, string[]> = {};
    const push = (id: string, m: string) => (errors[id] ??= []).push(m);
    const newFiles = rows.filter((r) => !r.documentId);

    if (newFiles.length) {
      requireAction(tree, a, body.folderId, "upload");
      if ((await folderGate(db, tree, body.folderId)).gated) throw forbidden(GATE_MESSAGE);
    }
    const standard = newFiles.length ? await standardForFolder(db, tree, body.folderId) : null;
    const names = new Map<string, string>();
    const seen = new Set<string>();
    for (const r of newFiles) {
      const name = cleanFileName(body.names[r.id] ?? r.fileName);
      if (!name) {
        push(r.id, tl("opencde:errors.invalidFileName"));
        continue;
      }
      const ext = (n: string) => splitExtension(n).extension.toLowerCase();
      if (ext(name) !== ext(r.fileName)) push(r.id, tl("opencde:errors.extensionChanged", { ext: ext(r.fileName) }));
      if (seen.has(name.toLocaleLowerCase("tr"))) push(r.id, tl("opencde:errors.duplicateName"));
      seen.add(name.toLocaleLowerCase("tr"));
      if (standard) {
        const v = validateName(standard, name, requestLanguage(req));
        if (!v.ok) push(r.id, tl("opencde:errors.namingStandardShort", { errors: v.errors.join("; ") }));
      }
      names.set(r.id, name);
    }

    const attributes: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.attributes ?? {})) if (k.trim() && v.trim()) attributes[k.trim()] = v.trim();
    if (body.revision?.trim()) attributes[OPENCDE_REVISION_KEY] = body.revision.trim();
    if (body.suitability?.trim()) attributes[OPENCDE_SUITABILITY_KEY] = body.suitability.trim();

    // Typed attributes of the target folder: valid values; required ones for new files.
    const defs = newFiles.length ? await effectiveDefinitions(db, tree, body.folderId) : [];
    const attrErrors = [
      ...validateAttributes(defs, attributes, { partial: true, lang: requestLanguage(req) }),
      ...(newFiles.length ? validateAttributes(defs.filter((d) => d.required), attributes, { lang: requestLanguage(req) }) : []),
    ];
    const uniqueAttrErrors = [...new Set(attrErrors.map((e) => e.message))];

    // New versions: the document stays where it is; the same rules as "Yeni Versiyon".
    let existingFolderId: string | null = null;
    for (const r of rows.filter((x) => x.documentId)) {
      const [f] = await db
        .select()
        .from(files)
        .where(and(eq(files.id, r.documentId!), isNull(files.deletedAt)));
      if (!f || f.projectId !== a.project.id || !tree.byId.has(f.folderId)) {
        push(r.id, tl("opencde:errors.documentNotInProject"));
        continue;
      }
      const blocker = await newVersionBlocker(db, tree, a, f, requestLanguage(req));
      if (blocker) push(r.id, blocker);
      const fdefs = await effectiveDefinitions(db, tree, f.folderId);
      for (const e of validateAttributes(fdefs, attributes, { partial: true, lang: requestLanguage(req) })) push(r.id, e.message);
      names.set(r.id, f.name);
      existingFolderId ??= f.folderId;
    }

    if (Object.keys(errors).length || uniqueAttrErrors.length)
      throw new HttpError(400, "bad_request", msg("opencde:errors.fixFields"), {
        files: errors,
        attributes: uniqueAttrErrors,
      });

    const now = new Date();
    await db
      .update(opencdeDocSessions)
      .set({
        status: "ready",
        projectId: a.project.id,
        folderId: newFiles.length ? body.folderId : existingFolderId,
        comment: body.comment?.trim() || null,
        attributes,
        expiresAt: new Date(now.getTime() + OPENCDE_DOCS_LIMITS.sessionSeconds * 1000),
        updatedAt: now,
      })
      .where(eq(opencdeDocSessions.id, s.id));
    for (const r of rows) await db.update(opencdeDocSessionFiles).set({ targetName: names.get(r.id) ?? r.fileName }).where(eq(opencdeDocSessionFiles.id, r.id));
    await audit(db, {
      projectId: a.project.id,
      userId: req.user!.id,
      action: "opencde.upload_prepared",
      targetType: "opencde_session",
      targetId: s.id,
      details: { client: s.clientName, folderId: body.folderId, files: [...names.values()] },
    });
    const url = `${documentsBase(opts, req)}/upload-sessions/${s.id}`;
    return { redirectTo: withParams(s.callbackUrl, { upload_documents_url: url }) };
  });

  /** "Seçimi Gönder" on the select page. */
  api.post<{ Params: { key: string } }>("/opencde/sessions/:key/select", async (req): Promise<OpenCdeRedirectDto> => {
    const s = await pageSession(req);
    if (s.kind !== "select") throw notFound(msg("opencde:entities.link"));
    requireOpen(s);
    const body = z
      .object({ projectId: z.string().uuid(), versionIds: z.array(z.string().uuid()).min(1).max(OPENCDE_DOCS_LIMITS.maxSelected) })
      .parse(req.body);
    const a = await projectAccess(db, body.projectId, req.user!);
    const tree = await FolderTree.load(db, a.project.id);
    const rows = await db
      .select()
      .from(fileVersions)
      .innerJoin(files, eq(files.id, fileVersions.fileId))
      .where(and(inArray(fileVersions.id, body.versionIds), eq(files.projectId, a.project.id), isNull(files.deletedAt)));
    const ok = rows.filter((r) => {
      if (!tree.byId.has(r.files.folderId)) return false;
      const perm = tree.permission(a.principal, r.files.folderId);
      return can(perm.level, "view") || (perm.canUpload && r.files.createdBy === req.user!.id);
    });
    if (ok.length !== new Set(body.versionIds).size) throw badRequest(msg("opencde:errors.selectionMissing"));
    const now = new Date();
    const folderId = ok[0]?.files.folderId ?? null;
    await db
      .update(opencdeDocSessions)
      .set({
        status: "completed",
        projectId: a.project.id,
        folderId,
        selectedVersionIds: [...new Set(body.versionIds)],
        completedAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + OPENCDE_DOCS_LIMITS.sessionSeconds * 1000),
      })
      .where(eq(opencdeDocSessions.id, s.id));
    await audit(db, {
      projectId: a.project.id,
      userId: req.user!.id,
      action: "opencde.documents_selected",
      targetType: "opencde_session",
      targetId: s.id,
      details: { client: s.clientName, files: ok.map((r) => ({ name: r.files.name, version: r.file_versions.version })) },
    });
    const url = `${documentsBase(opts, req)}/selections/${s.id}`;
    return { redirectTo: withParams(s.callbackUrl, { selected_documents_url: url }) };
  });

  /** "İptal": the application is told the user cancelled (spec: user_cancelled_upload / _selection). */
  api.post<{ Params: { key: string } }>("/opencde/sessions/:key/cancel", async (req): Promise<OpenCdeRedirectDto> => {
    const s = await pageSession(req);
    requireOpen(s);
    await db.update(opencdeDocSessions).set({ status: "cancelled", completedAt: new Date(), updatedAt: new Date() }).where(eq(opencdeDocSessions.id, s.id));
    const rows = await db.select({ id: opencdeDocSessionFiles.id }).from(opencdeDocSessionFiles).where(eq(opencdeDocSessionFiles.sessionId, s.id));
    await db.update(opencdeDocSessionFiles).set({ status: "cancelled" }).where(eq(opencdeDocSessionFiles.sessionId, s.id));
    await dropParts(
      db,
      storage,
      rows.map((r) => r.id),
    );
    await audit(db, {
      projectId: s.projectId,
      userId: req.user!.id,
      action: s.kind === "upload" ? "opencde.upload_cancelled" : "opencde.select_cancelled",
      targetType: "opencde_session",
      targetId: s.id,
      details: { client: s.clientName, by: "user" },
    });
    const param = s.kind === "upload" ? "user_cancelled_upload" : "user_cancelled_selection";
    return { redirectTo: withParams(s.callbackUrl, { [param]: "true" }) };
  });
}

