/**
 * Audit log API (docs/features/AUDIT_LOG.md; ISO 19650-1 §12, ISO 19650-2 §5.1.7):
 *   GET /projects/:pid/audit           project administrators; filters, cursor pages
 *   GET /projects/:pid/audit.csv       the same filters, every row, streamed
 *   GET /projects/:pid/files/:id/history  people who may view the file; its rows and its versions'
 *   GET /admin/audit, /admin/audit.csv system administrators; all projects and system rows
 *   GET /admin/audit/verify            system administrators; walks the hash chain
 * IP address and user agent (D-9) are shown to administrators only, from audit_personal while it is
 * kept (P1-5); afterwards the row says they were deleted.
 */
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SQL } from "drizzle-orm";
import type { AuditPageDto, Principal } from "@sitekeep/shared";
import type { AppDeps } from "../app/deps.js";
import type { Db } from "../db/index.js";
import { FolderTree, projectAccess, requireProjectAdmin } from "../core/security/access.js";
import { forbidden } from "../core/platform/http.js";
import { audit } from "../core/platform/audit.js";
import { msg, supportedLanguage, tFor, tReq } from "../i18n/index.js";
import { CSV_BOM, csvLine } from "../docintel/export.js";
import { loadFile, requireView } from "../modules/documents/files.js";
import { auditPage, auditQuery, auditRows, auditWhere, fileHistoryWhere, toAuditDtos, verifyAuditChain } from "./query.js";

function requireSystemAdmin(req: FastifyRequest) {
  if (!req.user?.isAdmin) throw forbidden(msg("admin:errors.adminOnly"));
}

const CSV_COLUMNS = ["id", "time", "project", "user", "action", "targetType", "targetId", "target", "ip", "userAgent", "details", "hash"] as const;

/** Streams every row of a query as CSV, newest first. */
async function sendCsv(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  where: SQL | undefined,
  fileName: string,
  projectId: string | null,
  viewer?: { tree: FolderTree; principal: Principal },
) {
  // A link cannot send the interface language as a header: `lang` in the query wins (column names).
  const asked = supportedLanguage((req.query as { lang?: string }).lang);
  const t = asked ? tFor(asked) : tReq(req);
  async function* lines() {
    yield CSV_BOM + csvLine(CSV_COLUMNS.map((c) => t(`audit:csv.columns.${c}`)));
    for await (const rows of auditRows(db, where)) {
      for (const e of await toAuditDtos(db, rows, { client: true, projectCodes: true, viewer }))
        yield csvLine([
          e.id,
          e.at,
          e.projectCode ?? "",
          e.userName ?? e.userId ?? "",
          e.action,
          e.targetType ?? "",
          e.targetId ?? "",
          e.targetName ?? "",
          e.ip ?? (e.personalRemoved ? t(`audit:csv.personalRemoved.${e.personalRemoved}`) : ""),
          e.userAgent ?? (e.personalRemoved ? t(`audit:csv.personalRemoved.${e.personalRemoved}`) : ""),
          e.details ? JSON.stringify(e.details) : "",
          e.hash ?? "",
        ]);
    }
  }
  // Taking the log out is itself on the record.
  await audit(db, { projectId, userId: req.user!.id, action: "audit.exported", details: { query: req.query as Record<string, unknown> } });
  reply.header("Content-Type", "text/csv; charset=utf-8");
  reply.header("Content-Disposition", `attachment; filename="${fileName}"`);
  reply.header("Cache-Control", "no-store");
  return reply.send(Readable.from(lines()));
}

const stamp = () => new Date().toISOString().slice(0, 10);

export async function auditRoutes(api: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  api.get("/projects/:pid/audit", async (req): Promise<AuditPageDto> => {
    const a = await projectAccess(db, (req.params as { pid: string }).pid, req.user!);
    requireProjectAdmin(a);
    const q = auditQuery.parse(req.query);
    const page = await auditPage(db, auditWhere(q, { projectId: a.project.id }), q.limit, q.cursor);
    const viewer = { tree: await FolderTree.load(db, a.project.id), principal: a.principal };
    return { entries: await toAuditDtos(db, page.rows, { client: true, viewer }), nextCursor: page.nextCursor };
  });

  api.get("/projects/:pid/audit.csv", async (req, reply) => {
    const a = await projectAccess(db, (req.params as { pid: string }).pid, req.user!);
    requireProjectAdmin(a);
    const q = auditQuery.parse(req.query);
    const viewer = { tree: await FolderTree.load(db, a.project.id), principal: a.principal };
    return sendCsv(db, req, reply, auditWhere(q, { projectId: a.project.id }), `audit-${a.project.code}-${stamp()}.csv`.replace(/[^\w.-]/g, "_"), a.project.id, viewer);
  });

  api.get<{ Params: { pid: string; id: string } }>("/projects/:pid/files/:id/history", async (req): Promise<AuditPageDto> => {
    const { a, file, tree } = await loadFile(db, req.params.pid, req.params.id, req.user!);
    requireView(tree, a, file);
    const q = auditQuery.pick({ cursor: true, limit: true }).parse(req.query);
    const page = await auditPage(db, await fileHistoryWhere(db, a.project.id, file.id), q.limit, q.cursor);
    return { entries: await toAuditDtos(db, page.rows, { client: a.isProjectAdmin }), nextCursor: page.nextCursor };
  });

  api.get("/admin/audit", async (req): Promise<AuditPageDto> => {
    requireSystemAdmin(req);
    const q = auditQuery.parse(req.query);
    const page = await auditPage(db, auditWhere(q), q.limit, q.cursor);
    return { entries: await toAuditDtos(db, page.rows, { client: true, projectCodes: true }), nextCursor: page.nextCursor };
  });

  api.get("/admin/audit.csv", async (req, reply) => {
    requireSystemAdmin(req);
    const q = auditQuery.parse(req.query);
    return sendCsv(db, req, reply, auditWhere(q), `audit-${stamp()}.csv`, null);
  });

  api.get("/admin/audit/verify", async (req) => {
    requireSystemAdmin(req);
    return verifyAuditChain(db);
  });
}
