/**
 * Data subject rights (issue #85 P1-1…P1-3, docs/features/DATA_SUBJECT_RIGHTS.md):
 *
 *   POST /admin/users/:id/data-exports          { includeFiles? } queue a personal data export (system administrators)
 *   GET  /admin/users/:id/data-exports          that person's exports
 *   GET  /admin/data-exports/:eid/download      the ZIP (audited user.data_export_downloaded)
 *   POST /admin/users/:id/anonymise             { confirmEmail } irreversible pseudonymisation (user.anonymised)
 *   PUT  /admin/users/:id/email                 { email } correct the address (user.email_changed)
 *   POST /me/data-exports, GET /me/data-exports, GET /me/data-exports/:eid/download
 *                                               the same export, requested by the person (My account)
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PersonalDataExportDto } from "@sitekeep/shared";
import type { ResolvedDeps } from "../../app/deps.js";
import { audit, auditEmailHash } from "../../core/platform/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../../core/platform/http.js";
import { invitations, jobs, tokens, users } from "../../db/schema.js";
import { msg } from "../../i18n/index.js";
import { toUserDto } from "../../auth/dto.js";
import { AnonymiseRefused, anonymiseUser, isAnonymised } from "./anonymise.js";
import { PERSONAL_EXPORT_JOB, getPersonalExport, listPersonalExports, runPersonalExportJob, toExportDto, type PersonalExportPayload } from "./export.js";

function requireAdmin(req: FastifyRequest) {
  if (!req.user?.isAdmin) throw forbidden(msg("admin:errors.adminOnly"));
}

const uuid = z.string().uuid();

export async function dataSubjectRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const { db, storage } = deps;
  deps.jobs.register(PERSONAL_EXPORT_JOB, (job) => runPersonalExportJob(db, storage, job));

  async function loadUser(id: string) {
    const [u] = await db.select().from(users).where(eq(users.id, uuid.parse(id)));
    if (!u) throw notFound(msg("admin:entities.user"));
    return u;
  }

  async function requestExport(subjectId: string, requestedBy: string, includeFiles: boolean, self: boolean): Promise<PersonalDataExportDto> {
    // One export in progress per person.
    const [busy] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.kind, PERSONAL_EXPORT_JOB), inArray(jobs.status, ["queued", "running"]), sql`${jobs.payload}->>'subjectId' = ${subjectId}`));
    if (busy) throw conflict(msg("privacy:errors.exportRunning"));
    const payload: PersonalExportPayload = { subjectId, requestedBy, includeFiles, self };
    const id = await deps.jobs.enqueue(PERSONAL_EXPORT_JOB, payload as unknown as Record<string, unknown>);
    const row = await getPersonalExport(db, id);
    return toExportDto(row!);
  }

  async function sendExport(req: FastifyRequest, reply: FastifyReply, eid: string, ownerId?: string) {
    const row = await getPersonalExport(db, uuid.parse(eid));
    const p = row?.payload as unknown as PersonalExportPayload | undefined;
    if (!row || !p || (ownerId && p.subjectId !== ownerId)) throw notFound(msg("privacy:entities.export"));
    if (row.status !== "done" || !p.resultKey) throw conflict(msg("privacy:errors.exportNotReady"));
    await audit(db, { userId: req.user!.id, action: "user.data_export_downloaded", targetType: "user", targetId: p.subjectId, details: { exportId: row.id } });
    const day = (row.finishedAt ?? row.createdAt).toISOString().slice(0, 10);
    reply.header("content-type", "application/zip");
    reply.header("content-disposition", `attachment; filename="personal-data-${p.subjectId.slice(0, 8)}-${day}.zip"`);
    reply.header("cache-control", "no-store");
    return reply.send(storage.get(p.resultKey));
  }

  const exportBody = z.object({ includeFiles: z.boolean().optional() }).default({});

  // ---- Administrator -------------------------------------------------------------------------

  api.post<{ Params: { id: string } }>("/admin/users/:id/data-exports", async (req) => {
    requireAdmin(req);
    const u = await loadUser(req.params.id);
    if (isAnonymised(u)) throw conflict(msg("privacy:errors.anonymised"));
    const body = exportBody.parse(req.body ?? {});
    return requestExport(u.id, req.user!.id, !!body.includeFiles, false);
  });

  api.get<{ Params: { id: string } }>("/admin/users/:id/data-exports", async (req) => {
    requireAdmin(req);
    return listPersonalExports(db, uuid.parse(req.params.id));
  });

  api.get<{ Params: { eid: string } }>("/admin/data-exports/:eid/download", async (req, reply) => {
    requireAdmin(req);
    return sendExport(req, reply, req.params.eid);
  });

  api.post<{ Params: { id: string } }>("/admin/users/:id/anonymise", async (req) => {
    requireAdmin(req);
    const u = await loadUser(req.params.id);
    const body = z.object({ confirmEmail: z.string().trim().toLowerCase() }).parse(req.body);
    // The second step: the administrator types the address of the account.
    if (body.confirmEmail !== u.email.trim().toLowerCase()) throw badRequest(msg("privacy:errors.anonymiseConfirm"));
    try {
      return await anonymiseUser(db, storage, u.id, { userId: req.user!.id });
    } catch (e) {
      if (e instanceof AnonymiseRefused)
        throw e.reason === "self" ? badRequest(msg("privacy:errors.anonymiseSelf")) : e.reason === "already" ? conflict(msg("privacy:errors.anonymised")) : notFound(msg("admin:entities.user"));
      throw e;
    }
  });

  api.put<{ Params: { id: string } }>("/admin/users/:id/email", async (req) => {
    requireAdmin(req);
    const u = await loadUser(req.params.id);
    if (isAnonymised(u)) throw conflict(msg("privacy:errors.anonymised"));
    const { email } = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()) }).parse(req.body);
    if (email.endsWith(".invalid")) throw badRequest(msg("admin:errors.invalidEmail"));
    if (email === u.email.toLowerCase()) return toUserDto(u);
    const [other] = await db.select({ id: users.id }).from(users).where(and(sql`lower(${users.email}) = ${email}`, ne(users.id, u.id)));
    if (other) throw conflict(msg("privacy:errors.emailInUse"));
    const [row] = await db.transaction(async (tx) => {
      const updated = await tx.update(users).set({ email }).where(eq(users.id, u.id)).returning();
      // Open invitations follow the account's address (Google acceptance compares it).
      await tx
        .update(invitations)
        .set({ email })
        .where(and(eq(invitations.userId, u.id), sql`${invitations.acceptedAt} IS NULL`, sql`${invitations.revokedAt} IS NULL`));
      // Signed-in sessions end: the person signs in again with the new address (or Google account).
      await tx.delete(tokens).where(and(eq(tokens.userId, u.id), eq(tokens.kind, "session")));
      return updated;
    });
    // The new address goes to the personal part of the log (details.email); the old one only as its hash.
    await audit(db, {
      userId: req.user!.id,
      action: "user.email_changed",
      targetType: "user",
      targetId: u.id,
      details: { email, previousEmailHash: auditEmailHash(u.email) },
    });
    return toUserDto(row!);
  });

  // ---- The person themselves (My account) ----------------------------------------------------

  api.post("/me/data-exports", async (req) => {
    const body = exportBody.parse(req.body ?? {});
    return requestExport(req.user!.id, req.user!.id, !!body.includeFiles, true);
  });

  api.get("/me/data-exports", async (req) => listPersonalExports(db, req.user!.id));

  api.get<{ Params: { eid: string } }>("/me/data-exports/:eid/download", async (req, reply) => sendExport(req, reply, req.params.eid, req.user!.id));
}
