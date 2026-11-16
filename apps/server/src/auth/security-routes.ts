/**
 * Sign-in security API (docs/features/SIGN_IN_SECURITY.md):
 *   second step (public)   GET /auth/two-factor/challenge, POST …/challenge/enrol, POST …/challenge/verify
 *   own account            GET /auth/two-factor, POST …/setup, …/enable, …/disable, …/recovery-codes
 *                          GET /auth/sessions, POST /auth/sessions/end-all
 *   system administrators  GET/PUT /admin/sign-in-security, POST /admin/sign-in-security/unlock,
 *                          POST /admin/users/:id/sessions/end, DELETE /admin/users/:id/two-factor
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  SIGN_IN_SECURITY_LIMITS,
  TWO_FACTOR_REQUIREMENTS,
  type SessionDto,
  type SignInSecuritySettings,
  type TwoFactorStatusDto,
} from "@sitekeep/shared";
import type { ResolvedDeps } from "../app/deps.js";
import { SESSION_COOKIE } from "../app/deps.js";
import { audit } from "../core/platform/audit.js";
import { HttpError, badRequest, forbidden, notFound } from "../core/platform/http.js";
import { tokens, users } from "../db/schema.js";
import { msg } from "../i18n/index.js";
import { toUserDto } from "./dto.js";
import { createSession } from "./session.js";
import { endSessions } from "./sign-in-security.js";
import {
  clearChallenge,
  confirmEnrolment,
  readChallenge,
  removeTwoFactor,
  replaceRecoveryCodes,
  startEnrolment,
  twoFactorOf,
  twoFactorRequired,
  verifySecondFactor,
} from "./two-factor.js";

const secondFactor = z
  .object({
    code: z.string().trim().max(20).optional(),
    recoveryCode: z.string().trim().max(40).optional(),
  })
  .refine((b) => !!b.code || !!b.recoveryCode);

const wrongCode = () => new HttpError(401, "two_factor_code_wrong", msg("auth:errors.twoFactorCodeWrong"));
const noChallenge = () => new HttpError(401, "two_factor_no_challenge", msg("auth:errors.twoFactorNoChallenge"));

function requireAdmin(req: FastifyRequest) {
  if (!req.user?.isAdmin) throw forbidden(msg("admin:errors.adminOnly"));
}

export async function signInSecurityRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const { db, secretKey, signInSecurity: security } = deps;

  const activeUser = async (id: string) => {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user && !user.disabled && !user.pending ? user : null;
  };

  // ---- The second step of a sign-in (public: the challenge cookie names the user) ----------------

  api.get("/auth/two-factor/challenge", { config: { public: true } }, async (req) => {
    const c = readChallenge(req, secretKey);
    if (!c) throw noChallenge();
    return { twoFactor: c.mode };
  });

  /** Required and not set up yet: a secret to scan, before the session starts. */
  api.post("/auth/two-factor/challenge/enrol", { config: { public: true } }, async (req) => {
    const c = readChallenge(req, secretKey);
    if (!c || c.mode !== "enrol") throw noChallenge();
    const user = await activeUser(c.userId);
    if (!user) throw noChallenge();
    await security.guard(req, user.email);
    if ((await twoFactorOf(db, user.id))?.enabledAt) throw badRequest(msg("auth:errors.twoFactorAlreadyOn"));
    return startEnrolment(db, secretKey, user);
  });

  api.post("/auth/two-factor/challenge/verify", { config: { public: true } }, async (req, reply) => {
    const c = readChallenge(req, secretKey);
    if (!c) throw noChallenge();
    const body = secondFactor.parse(req.body);
    const user = await activeUser(c.userId);
    if (!user) throw noChallenge();
    await security.guard(req, user.email);
    let recoveryCodes: string[] | null = null;
    let used: "totp" | "recovery" | null;
    if (c.mode === "enrol") {
      recoveryCodes = body.code ? await confirmEnrolment(db, secretKey, user.id, body.code) : null;
      used = recoveryCodes ? "totp" : null;
    } else {
      used = await verifySecondFactor(db, secretKey, user.id, body);
    }
    if (!used) {
      await audit(db, { userId: user.id, action: "auth.login_failed", details: { provider: c.provider === "oidc" ? `oidc:${c.idp}` : c.provider, twoFactor: true } });
      await security.fail(req, { email: user.email, userId: user.id, kind: "two_factor" });
      throw wrongCode();
    }
    security.succeed(user.email);
    clearChallenge(reply);
    await createSession(deps, user.id, reply);
    if (recoveryCodes) await audit(db, { userId: user.id, action: "auth.two_factor_enabled", details: { atSignIn: true } });
    await audit(db, {
      userId: user.id,
      action: c.provider === "oidc" ? "auth.oidc_login" : "auth.login",
      details: {
        ...(c.provider === "google" && { provider: "google" }),
        ...(c.provider === "oidc" && { provider: c.idp }),
        ...(c.invitation && { invitation: true }),
        twoFactor: used,
      },
    });
    return { ...toUserDto(user), ...(recoveryCodes && { recoveryCodes }) };
  });

  // ---- Own account ------------------------------------------------------------------------------

  api.get("/auth/two-factor", async (req): Promise<TwoFactorStatusDto> => {
    const tf = await twoFactorOf(db, req.user!.id);
    return {
      enabled: !!tf?.enabledAt,
      required: twoFactorRequired(await security.settings(), req.user!),
      recoveryCodesLeft: tf?.enabledAt ? tf.recoveryCodes.length : 0,
      enabledAt: tf?.enabledAt?.toISOString() ?? null,
    };
  });

  api.post("/auth/two-factor/setup", async (req) => {
    if ((await twoFactorOf(db, req.user!.id))?.enabledAt) throw badRequest(msg("auth:errors.twoFactorAlreadyOn"));
    return startEnrolment(db, secretKey, req.user!);
  });

  api.post("/auth/two-factor/enable", async (req) => {
    const { code } = z.object({ code: z.string().trim().max(20) }).parse(req.body);
    const user = req.user!;
    const tf = await twoFactorOf(db, user.id);
    if (tf?.enabledAt) throw badRequest(msg("auth:errors.twoFactorAlreadyOn"));
    if (!tf) throw badRequest(msg("auth:errors.twoFactorNoSetup"));
    await security.guard(req, user.email);
    const recoveryCodes = await confirmEnrolment(db, secretKey, user.id, code);
    if (!recoveryCodes) {
      await security.fail(req, { email: user.email, userId: user.id, kind: "two_factor" });
      throw badRequest(msg("auth:errors.twoFactorCodeWrong"));
    }
    await audit(db, { userId: user.id, action: "auth.two_factor_enabled" });
    return { recoveryCodes };
  });

  /** Checks the caller's current code (or a recovery code) before a change to two-factor itself. */
  async function confirmSecondFactor(req: FastifyRequest) {
    const user = req.user!;
    const body = secondFactor.parse(req.body);
    if (!(await twoFactorOf(db, user.id))?.enabledAt) throw badRequest(msg("auth:errors.twoFactorNotOn"));
    await security.guard(req, user.email);
    if (!(await verifySecondFactor(db, secretKey, user.id, body))) {
      await security.fail(req, { email: user.email, userId: user.id, kind: "two_factor" });
      throw badRequest(msg("auth:errors.twoFactorCodeWrong"));
    }
  }

  api.post("/auth/two-factor/disable", async (req) => {
    if (twoFactorRequired(await security.settings(), req.user!)) throw forbidden(msg("auth:errors.twoFactorRequired"));
    await confirmSecondFactor(req);
    await removeTwoFactor(db, req.user!.id);
    await audit(db, { userId: req.user!.id, action: "auth.two_factor_disabled" });
    return { ok: true };
  });

  api.post("/auth/two-factor/recovery-codes", async (req) => {
    await confirmSecondFactor(req);
    const recoveryCodes = await replaceRecoveryCodes(db, req.user!.id);
    await audit(db, { userId: req.user!.id, action: "auth.two_factor_recovery_codes" });
    return { recoveryCodes };
  });

  api.get("/auth/sessions", async (req): Promise<SessionDto[]> => {
    const rows = await db
      .select({ id: tokens.id, createdAt: tokens.createdAt, lastUsedAt: tokens.lastUsedAt, expiresAt: tokens.expiresAt })
      .from(tokens)
      .where(and(eq(tokens.userId, req.user!.id), eq(tokens.kind, "session")))
      .orderBy(desc(tokens.createdAt));
    const out: SessionDto[] = [];
    for (const r of rows) {
      if (r.expiresAt && r.expiresAt.getTime() <= Date.now()) continue;
      if (!(await security.sessionAlive(r.createdAt, r.lastUsedAt))) continue;
      out.push({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
        expiresAt: r.expiresAt?.toISOString() ?? null,
        current: r.id === req.user!.token?.id,
      });
    }
    return out;
  });

  /** "Sign out everywhere": every browser session of the user, this one included. */
  api.post("/auth/sessions/end-all", async (req, reply) => {
    const ended = await endSessions(db, req.user!.id);
    await audit(db, { userId: req.user!.id, action: "auth.sessions_ended", targetType: "user", targetId: req.user!.id, details: { ended } });
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ended };
  });

  // ---- System administrators --------------------------------------------------------------------

  api.get("/admin/sign-in-security", async (req) => {
    requireAdmin(req);
    return security.settings();
  });

  api.put("/admin/sign-in-security", async (req) => {
    requireAdmin(req);
    const range = (k: keyof typeof SIGN_IN_SECURITY_LIMITS) =>
      z.number().int().min(SIGN_IN_SECURITY_LIMITS[k][0]).max(SIGN_IN_SECURITY_LIMITS[k][1]).optional();
    const body = z
      .object({
        failureLimit: range("failureLimit"),
        ipFailureLimit: range("ipFailureLimit"),
        failureWindowMinutes: range("failureWindowMinutes"),
        sessionAbsoluteDays: range("sessionAbsoluteDays"),
        sessionIdleHours: range("sessionIdleHours"),
        requireTwoFactor: z.enum(TWO_FACTOR_REQUIREMENTS as [SignInSecuritySettings["requireTwoFactor"], ...SignInSecuritySettings["requireTwoFactor"][]]).optional(),
      })
      .strict()
      .parse(req.body);
    const before = await security.settings();
    const next = await security.put(body, req.user!.id);
    const changed = Object.fromEntries(
      (Object.keys(next) as (keyof SignInSecuritySettings)[]).filter((k) => next[k] !== before[k]).map((k) => [k, { from: before[k], to: next[k] }]),
    );
    if (Object.keys(changed).length) await audit(db, { userId: req.user!.id, action: "auth.security_settings", details: changed });
    return next;
  });

  api.post("/admin/sign-in-security/unlock", async (req) => {
    requireAdmin(req);
    security.clearLocks();
    await audit(db, { userId: req.user!.id, action: "auth.locks_cleared" });
    return { ok: true };
  });

  const targetUser = async (id: string) => {
    if (!z.string().uuid().safeParse(id).success) throw notFound(msg("auth:entities.user"));
    const [user] = await db.select().from(users).where(eq(users.id, id));
    if (!user) throw notFound(msg("auth:entities.user"));
    return user;
  };

  /** "Sign out everywhere" for another user (or oneself: this session stays). */
  api.post<{ Params: { id: string } }>("/admin/users/:id/sessions/end", async (req) => {
    requireAdmin(req);
    const user = await targetUser(req.params.id);
    const keep = user.id === req.user!.id ? (req.user!.token?.id ?? null) : null;
    const ended = await endSessions(db, user.id, keep);
    await audit(db, { userId: req.user!.id, action: "auth.sessions_ended", targetType: "user", targetId: user.id, details: { ended, byAdmin: true } });
    return { ended };
  });

  /**
   * Reset a user's two-factor (lost phone and recovery codes): it is removed and their sessions end.
   * Where it is required they set it up again at their next sign-in.
   */
  api.delete<{ Params: { id: string } }>("/admin/users/:id/two-factor", async (req) => {
    requireAdmin(req);
    const user = await targetUser(req.params.id);
    const removed = await removeTwoFactor(db, user.id);
    const keep = user.id === req.user!.id ? (req.user!.token?.id ?? null) : null;
    const ended = await endSessions(db, user.id, keep);
    await audit(db, { userId: req.user!.id, action: "auth.two_factor_reset", targetType: "user", targetId: user.id, details: { removed, sessionsEnded: ended } });
    return { ok: true, removed };
  });
}
