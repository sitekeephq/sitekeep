/**
 * Audit log API (docs/features/AUDIT_LOG.md; ISO 19650-1 §12, ISO 19650-2 §5.1.7):
 *   GET /projects/:pid/audit           project administrators; filters, cursor pages
 *   GET /projects/:pid/audit.csv       the same filters, every row, streamed
 *   GET /projects/:pid/files/:id/history  people who may view the file; its rows and its versions'
 *   GET /admin/audit, /admin/audit.csv system administrators and auditors; all projects and system rows
 *   GET /admin/audit/projects          system administrators and auditors; every project (the filter)
 *   GET /admin/audit/verify            system administrators and auditors; walks the hash chain
 * The security log and its alerts: security-log-routes.ts.
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
import { requireSecurityReader } from "../core/security/system-roles.js";
import { audit } from "../core/platform/audit.js";
import { asc } from "drizzle-orm";
import { projects } from "../db/schema.js";
import { securityLogRoutes } from "./security-log-routes.js";
import { supportedLanguage, tFor, tReq } from "../i18n/index.js";
import { loadFile, requireView } from "../modules/documents/files.js";
import { auditCsvLines } from "./csv.js";
import { auditPage, auditQuery, auditWhere, fileHistoryWhere, toAuditDtos, verifyAuditChain } from "./query.js";

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
  const lines = () => auditCsvLines(db, where, t, { client: true, viewer });
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
    requireSecurityReader(req);
    const q = auditQuery.parse(req.query);
    const page = await auditPage(db, auditWhere(q), q.limit, q.cursor);
    return { entries: await toAuditDtos(db, page.rows, { client: true, projectCodes: true }), nextCursor: page.nextCursor };
  });

  api.get("/admin/audit.csv", async (req, reply) => {
    requireSecurityReader(req);
    const q = auditQuery.parse(req.query);
    return sendCsv(db, req, reply, auditWhere(q), `audit-${stamp()}.csv`, null);
  });

  api.get("/admin/audit/projects", async (req) => {
    requireSecurityReader(req);
    return db.select({ id: projects.id, code: projects.code, name: projects.name }).from(projects).orderBy(asc(projects.code));
  });

  api.get("/admin/audit/verify", async (req) => {
    requireSecurityReader(req);
    return verifyAuditChain(db);
  });

  await securityLogRoutes(api, deps);
}
