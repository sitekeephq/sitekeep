/**
 * Invitation API (docs/features/INVITATIONS.md):
 *   project members screen   GET/POST /projects/:pid/invitations, POST …/:id/resend, DELETE …/:id
 *   accept page (public)     POST /invitations/lookup, /invitations/accept, /invitations/google
 *   system setting           GET/PUT /admin/invitations (project administrators may invite: default off)
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { INVITATION_LANGUAGES, PROVISION_PASSWORD, isGroupAddress, type InvitationInfoDto, type InvitationListDto, type InviteResultDto } from "@sitekeep/shared";
import type { ResolvedDeps } from "../app/deps.js";
import { companies, invitations, projectRoles, users } from "../db/schema.js";
import { audit } from "../core/platform/audit.js";
import { HttpError, badRequest, forbidden, notFound } from "../core/platform/http.js";
import { passwordProblem } from "../core/security/auth.js";
import { projectAccess, requireProjectAdmin } from "../core/security/access.js";
import { FailureLimiter } from "../oauth/rate-limit.js";
import { publicBaseUrl } from "../oauth/config.js";
import { fromAcceptLanguage, msg } from "../i18n/index.js";
import { toUserDto } from "./dto.js";
import { createSession } from "./session.js";
import {
  accountFor,
  acceptInvitation,
  addProjectMember,
  deliverInvitation,
  ensurePendingUser,
  findOpenInvitation,
  getInvitationSettings,
  invitationError,
  invitationLanguage,
  invitedProjects,
  issueInvitation,
  listInvitations,
  mailBlocked,
  mayInvite,
  putInvitationSettings,
  renewInvitation,
  revokeInvitation,
} from "./invitations.js";

/** Cookie carrying the invitation token through Google sign-in (only to the Google routes). */
export const INVITATION_COOKIE = "cde_invitation";

/** Invitations (created or resent) per inviter and hour. */
const INVITES_PER_HOUR = 60;
/** Unknown / spent tokens per client IP and 10 minutes on the public routes. */
const TOKEN_FAILURES = 20;

const tokenBody = z.object({ token: z.string().trim().min(1).max(300) });

export async function invitationRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const { db } = deps;
  const inviteLimiter = new FailureLimiter(INVITES_PER_HOUR, 60 * 60_000);
  const tokenLimiter = new FailureLimiter(TOKEN_FAILURES, 10 * 60_000);

  /** Counts one invitation of the caller; 429 above the hourly limit. */
  const countInvite = (userId: string) => {
    const wait = inviteLimiter.retryAfter(userId);
    if (wait) throw new HttpError(429, "rate_limited", msg("auth:errors.invitationRateLimited", { seconds: wait }));
    inviteLimiter.fail(userId);
  };
  /** Runs a public token route; a bad token counts against the client IP. */
  const withToken = async <T>(req: FastifyRequest, fn: () => Promise<T>): Promise<T> => {
    const wait = tokenLimiter.retryAfter(req.ip);
    if (wait) throw new HttpError(429, "rate_limited", msg("auth:errors.tooManyAttempts", { seconds: wait }));
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpError && err.code.startsWith("invitation_")) tokenLimiter.fail(req.ip);
      throw err;
    }
  };

  // ---- System setting ------------------------------------------------------------------------

  api.get("/admin/invitations", async (req) => {
    if (!req.user!.isAdmin) throw forbidden();
    return getInvitationSettings(db);
  });

  api.put("/admin/invitations", async (req) => {
    if (!req.user!.isAdmin) throw forbidden();
    const body = z.object({ projectAdminsMayInvite: z.boolean() }).parse(req.body);
    const next = await putInvitationSettings(db, body, req.user!.id);
    await audit(db, { userId: req.user!.id, action: "invitation.settings", details: { ...next } });
    return next;
  });

  // ---- Project members screen ------------------------------------------------------------------

  api.get<{ Params: { pid: string } }>("/projects/:pid/invitations", async (req): Promise<InvitationListDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const blocked = await mailBlocked(db, deps.mailer);
    return {
      canInvite: await mayInvite(db, a.user, a.isProjectAdmin),
      mail: { configured: !!deps.mailer, enabled: !blocked },
      invitations: await listInvitations(db, a.project.id),
    };
  });

  api.post<{ Params: { pid: string } }>("/projects/:pid/invitations", async (req): Promise<InviteResultDto> => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const body = z
      .object({
        email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
        name: z.string().trim().max(200).optional(),
        companyId: z.string().uuid().nullable().optional(),
        roleIds: z.array(z.string().uuid()).max(50).optional(),
        isProjectAdmin: z.boolean().optional(),
        language: z.enum(INVITATION_LANGUAGES).optional(),
      })
      .parse(req.body);
    if (isGroupAddress(body.email)) throw badRequest(msg("auth:errors.invitationGroupAddress", { email: body.email }));
    const roleIds = [...new Set(body.roleIds ?? [])];
    if (roleIds.length) {
      const found = await db
        .select({ id: projectRoles.id })
        .from(projectRoles)
        .where(and(eq(projectRoles.projectId, a.project.id), inArray(projectRoles.id, roleIds)));
      if (found.length !== roleIds.length) throw badRequest(msg("auth:errors.roleNotInProject"));
    }
    if (body.companyId) {
      const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, body.companyId));
      if (!company) throw notFound(msg("auth:entities.company"));
    }
    const isProjectAdmin = !!body.isProjectAdmin;
    const account = await accountFor(db, body.email);
    if (account.kind === "disabled") throw badRequest(msg("auth:errors.accountDisabled", { email: body.email }));
    if (account.kind === "active") {
      // An existing account is simply added, as the members screen does.
      const companyId = body.companyId ?? account.user.companyId;
      await addProjectMember(db, a.project, { userId: account.user.id, companyId, roleIds, isProjectAdmin });
      await audit(db, {
        projectId: a.project.id,
        userId: a.user.id,
        action: "member.added",
        targetType: "user",
        targetId: account.user.id,
        details: { email: body.email, companyId, roleIds, isProjectAdmin },
      });
      return { status: "added", userId: account.user.id };
    }
    if (!(await mayInvite(db, a.user, a.isProjectAdmin))) throw forbidden(msg("auth:errors.invitationsNotAllowed"));
    countInvite(a.user.id);
    const language = invitationLanguage(body.language);
    const created = await db.transaction(async (tx) => {
      const txDb = tx as unknown as typeof db;
      const user = await ensurePendingUser(txDb, { email: body.email, name: body.name, companyId: body.companyId ?? null, invitedBy: a.user.id });
      const companyId = body.companyId ?? user.companyId;
      await addProjectMember(txDb, a.project, { userId: user.id, companyId, roleIds, isProjectAdmin });
      const invitation = await issueInvitation(txDb, {
        userId: user.id,
        email: body.email,
        projectId: a.project.id,
        companyId,
        roleIds,
        isProjectAdmin,
        language,
        invitedBy: a.user.id,
      });
      return { user, invitation };
    });
    const delivery = await deliverInvitation(db, deps.mailer, {
      ...created.invitation,
      email: body.email,
      name: created.user.name,
      language,
      inviterName: a.user.name,
      projectName: a.project.name,
      baseUrl: publicBaseUrl(deps.oauth, req),
    });
    return { status: "invited", userId: created.user.id, invitation: delivery };
  });

  api.post<{ Params: { pid: string; id: string } }>("/projects/:pid/invitations/:id/resend", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    if (!(await mayInvite(db, a.user, a.isProjectAdmin))) throw forbidden(msg("auth:errors.invitationsNotAllowed"));
    const body = z.object({ language: z.enum(INVITATION_LANGUAGES).optional() }).parse(req.body ?? {});
    const row = await invitationOf(a.project.id, req.params.id);
    if (row.acceptedAt || row.revokedAt) throw badRequest(msg("auth:errors.invitationNotOpen"));
    countInvite(a.user.id);
    const renewed = await renewInvitation(db, row, a.user.id, body.language);
    const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.userId));
    return deliverInvitation(db, deps.mailer, {
      id: row.id,
      token: renewed.token,
      expiresAt: renewed.expiresAt,
      email: row.email,
      name: user?.name ?? row.email,
      language: renewed.language,
      inviterName: a.user.name,
      projectName: a.project.name,
      baseUrl: publicBaseUrl(deps.oauth, req),
    });
  });

  api.delete<{ Params: { pid: string; id: string } }>("/projects/:pid/invitations/:id", async (req) => {
    const a = await projectAccess(db, req.params.pid, req.user!);
    requireProjectAdmin(a);
    const row = await invitationOf(a.project.id, req.params.id);
    if (row.acceptedAt || row.revokedAt) throw badRequest(msg("auth:errors.invitationClosed"));
    await revokeInvitation(db, row, a.user.id);
    return { ok: true };
  });

  async function invitationOf(projectId: string, id: string) {
    if (!z.string().uuid().safeParse(id).success) throw notFound(msg("auth:entities.invitation"));
    const [row] = await db.select().from(invitations).where(and(eq(invitations.id, id), eq(invitations.projectId, projectId)));
    if (!row) throw notFound(msg("auth:entities.invitation"));
    return row;
  }

  // ---- Accept page (public) --------------------------------------------------------------------

  api.post("/invitations/lookup", { config: { public: true } }, async (req): Promise<InvitationInfoDto> =>
    withToken(req, async () => {
      const { token } = tokenBody.parse(req.body);
      const found = await findOpenInvitation(db, token);
      if (!found.ok) throw invitationError(found.problem);
      const [inviter] = found.invitation.invitedBy
        ? await db.select({ name: users.name }).from(users).where(eq(users.id, found.invitation.invitedBy))
        : [];
      return {
        email: found.user.email,
        name: found.user.name,
        projects: await invitedProjects(db, found.user.id),
        invitedBy: inviter?.name ?? null,
        expiresAt: found.invitation.expiresAt.toISOString(),
        language: found.invitation.language,
        google: !!deps.googleAuth,
      };
    }),
  );

  api.post("/invitations/accept", { config: { public: true } }, async (req, reply) =>
    withToken(req, async () => {
      const body = tokenBody.extend({ name: z.string().trim().min(1).max(200), password: z.string().max(200) }).parse(req.body);
      if (body.password === PROVISION_PASSWORD) throw badRequest(msg("auth:errors.provisionPassword"));
      const problem = passwordProblem(body.password);
      if (problem) throw badRequest(problem);
      const user = await acceptInvitation(db, body.token, {
        name: body.name,
        password: body.password,
        provider: "password",
        language: fromAcceptLanguage(req.headers["accept-language"]),
      });
      await createSession(db, user.id, reply, !!deps.secureCookies);
      await audit(db, { userId: user.id, action: "auth.login", details: { invitation: true } });
      return toUserDto(user);
    }),
  );

  /** Google sign-in for an invitation: the token rides in a short cookie to the callback, which accepts it for the same address. */
  api.post("/invitations/google", { config: { public: true } }, async (req, reply) =>
    withToken(req, async () => {
      if (!deps.googleAuth) throw notFound(msg("auth:entities.googleSignIn"));
      const { token } = tokenBody.parse(req.body);
      const found = await findOpenInvitation(db, token);
      if (!found.ok) throw invitationError(found.problem);
      reply.setCookie(INVITATION_COOKIE, token, {
        path: "/api/v1/auth/google",
        httpOnly: true,
        sameSite: "lax",
        secure: !!deps.secureCookies,
        maxAge: 10 * 60,
      });
      return { url: "/api/v1/auth/google" };
    }),
  );
}
