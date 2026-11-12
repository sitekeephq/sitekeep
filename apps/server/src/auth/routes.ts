import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { PROVISION_PASSWORD } from "@sitekeep/shared";
import type { AppDeps } from "../app/deps.js";
import { SESSION_COOKIE } from "../app/deps.js";
import { prefsForPassword, toUserDto } from "./dto.js";
import { audit } from "../core/platform/audit.js";
import { hashPassword, hashToken, newToken, passwordProblem, verifyPassword } from "../core/security/auth.js";
import type { AuthUser } from "../core/security/access.js";
import { getMcpSettings, type McpSettings } from "../ai/settings.js";
import type { Db } from "../db/index.js";
import { projectMembers, projects, tokens, users } from "../db/schema.js";
import { HttpError, badRequest, forbidden, notFound } from "../core/platform/http.js";
import { outboundFetch } from "../privacy/outbound.js";
import { resolveGoogleUser } from "./google-settings.js";
import { msg, render, requestLanguage, type Msg } from "../i18n/index.js";

const SESSION_DAYS = 14;
const GOOGLE_STATE_COOKIE = "cde_google_state";

export async function authRoutes(api: FastifyInstance, { db, secureCookies, googleAuth }: AppDeps) {
  const apiGoogleAuth = googleAuth;
  api.get("/auth/methods", { config: { public: true } }, async () => ({
    password: true,
    google: !!apiGoogleAuth,
  }));

  api.get("/auth/google", { config: { public: true } }, async (_req, reply) => {
    if (!apiGoogleAuth) throw notFound(msg("auth:entities.googleSignIn"));
    const state = randomBytes(32).toString("base64url");
    reply.setCookie(GOOGLE_STATE_COOKIE, state, {
      path: "/api/v1/auth/google",
      httpOnly: true,
      sameSite: "lax",
      secure: !!secureCookies,
      maxAge: 10 * 60,
    });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", apiGoogleAuth.clientId);
    url.searchParams.set("redirect_uri", apiGoogleAuth.callbackUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "select_account");
    return reply.redirect(url.toString());
  });

  api.get("/auth/google/callback", { config: { public: true } }, async (req, reply) => {
    if (!apiGoogleAuth) throw notFound(msg("auth:entities.googleSignIn"));
    const query = z
      .object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() })
      .parse(req.query);
    const expectedState = req.cookies[GOOGLE_STATE_COOKIE];
    reply.clearCookie(GOOGLE_STATE_COOKIE, { path: "/api/v1/auth/google" });
    if (query.error) return reply.redirect("/login?authError=google_cancelled");
    if (!query.code || !query.state || !expectedState || query.state !== expectedState) {
      return reply.redirect("/login?authError=invalid_state");
    }

    try {
      const tokenResponse = await outboundFetch("giris:google", "https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: query.code,
          client_id: apiGoogleAuth.clientId,
          client_secret: apiGoogleAuth.clientSecret,
          redirect_uri: apiGoogleAuth.callbackUrl,
          grant_type: "authorization_code",
        }),
      }, { connection: "google" });
      if (!tokenResponse.ok) throw new Error(`token exchange failed (${tokenResponse.status})`);
      const token = z.object({ access_token: z.string() }).parse(await tokenResponse.json());
      const profileResponse = await outboundFetch("giris:google", "https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { authorization: `Bearer ${token.access_token}` },
      }, { connection: "google" });
      if (!profileResponse.ok) throw new Error(`profile request failed (${profileResponse.status})`);
      const profile = z
        .object({ email: z.string().email(), email_verified: z.boolean(), name: z.string().optional() })
        .parse(await profileResponse.json());
      if (!profile.email_verified) return reply.redirect("/login?authError=email_not_verified");

      const email = profile.email.trim().toLowerCase();
      const resolved = await resolveGoogleUser(db, email, profile.name ?? "");
      if (!resolved) {
        await audit(db, { action: "auth.login_failed", details: { email, provider: "google" } });
        return reply.redirect("/login?authError=account_not_allowed");
      }
      await createSession(db, resolved.user.id, reply, !!secureCookies);
      await audit(db, {
        userId: resolved.user.id,
        action: "auth.login",
        details: { provider: "google", provisioned: resolved.created },
      });
      return reply.redirect("/");
    } catch (error) {
      api.log.warn({ err: error }, "Google login failed");
      return reply.redirect("/login?authError=google_failed");
    }
  });

  api.post("/auth/login", { config: { public: true } }, async (req, reply) => {
    const body = z.object({ email: z.string().trim().email().toLowerCase(), password: z.string() }).parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email));
    if (!user || user.disabled || !(await verifyPassword(body.password, user.passwordHash))) {
      await audit(db, { action: "auth.login_failed", details: { email: body.email } });
      throw new HttpError(401, "invalid_credentials", msg("auth:errors.invalidCredentials"));
    }
    let signedIn = user;
    if (body.password === PROVISION_PASSWORD && !user.prefs?.mustChangePassword) {
      const prefs = prefsForPassword(user.prefs, body.password);
      const [updated] = await db.update(users).set({ prefs }).where(eq(users.id, user.id)).returning();
      if (updated) signedIn = updated;
    }
    await createSession(db, signedIn.id, reply, !!secureCookies);
    await audit(db, { userId: signedIn.id, action: "auth.login" });
    return toUserDto(signedIn);
  });

  api.post("/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await db.delete(tokens).where(eq(tokens.tokenHash, hashToken(token)));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  api.get("/auth/me", async (req) => {
    const { token: _token, ...user } = req.user!;
    return { ...user, mustChangePassword: !!user.mustChangePassword, language: user.language ?? null };
  });

  api.post("/auth/password", async (req) => {
    const body = z.object({ currentPassword: z.string(), newPassword: z.string() }).parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.id, req.user!.id));
    if (!user || !(await verifyPassword(body.currentPassword, user.passwordHash)))
      throw badRequest(msg("auth:errors.currentPasswordWrong"));
    if (body.newPassword === body.currentPassword) throw badRequest(msg("auth:errors.newPasswordSame"));
    if (body.newPassword === PROVISION_PASSWORD) throw badRequest(msg("auth:errors.provisionPassword"));
    const problem = passwordProblem(body.newPassword);
    if (problem) throw badRequest(problem);
    await db
      .update(users)
      .set({
        passwordHash: await hashPassword(body.newPassword),
        prefs: prefsForPassword(user.prefs, body.newPassword),
      })
      .where(eq(users.id, user.id));
    await audit(db, { userId: user.id, action: "auth.password_changed" });
    return { ok: true };
  });

  // API tokens for the MCP server, AECPilot deliveries and scripts.
  api.get("/auth/tokens", async (req) =>
    db
      .select({
        id: tokens.id,
        name: tokens.name,
        scope: tokens.scope,
        projectIds: tokens.projectIds,
        createdAt: tokens.createdAt,
        expiresAt: tokens.expiresAt,
        lastUsedAt: tokens.lastUsedAt,
      })
      .from(tokens)
      .where(and(eq(tokens.userId, req.user!.id), eq(tokens.kind, "api")))
      .orderBy(desc(tokens.createdAt)),
  );

  /** What the caller may create (set by system administrators under integrations.mcp). */
  api.get("/auth/token-policy", async (req) => {
    const s = await getMcpSettings(db);
    const reason = await tokenCreationBlocked(db, req.user!, s);
    return {
      canCreate: !reason,
      reason: reason ? render(requestLanguage(req), reason) : null,
      allowWriteTokens: s.allowWriteTokens,
      maxTokenDays: s.maxTokenDays,
      tokenCreators: s.tokenCreators,
      mcpEnabled: s.enabled,
    };
  });

  api.post("/auth/tokens", async (req) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(100),
        scope: z.enum(["read", "write"]).default("read"),
        projectIds: z.array(z.string().uuid()).min(1).max(200).nullable().optional(),
        /** Lifetime in days; null = never expires (only when the administrator sets no limit). */
        expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
      })
      .parse(req.body);
    const user = req.user!;
    const s = await getMcpSettings(db);
    const blocked = await tokenCreationBlocked(db, user, s);
    if (blocked) throw forbidden(blocked);
    if (body.scope === "write" && !s.allowWriteTokens)
      throw forbidden(msg("auth:errors.writeTokensDisabled"));

    let days = body.expiresInDays;
    if (s.maxTokenDays !== null) {
      if (days === undefined) days = s.maxTokenDays;
      if (days === null || days > s.maxTokenDays)
        throw badRequest(msg("auth:errors.tokenTooLong", { days: s.maxTokenDays }));
    }
    const expiresAt = days ? new Date(Date.now() + days * 86400_000) : null;

    const projectIds = body.projectIds ? [...new Set(body.projectIds)] : null;
    if (projectIds && !user.isAdmin) {
      const mine = await db
        .select({ id: projectMembers.projectId })
        .from(projectMembers)
        .where(and(eq(projectMembers.userId, user.id), inArray(projectMembers.projectId, projectIds)));
      if (mine.length !== projectIds.length) throw badRequest(msg("auth:errors.tokenProjectsNotMember"));
    } else if (projectIds) {
      const found = await db.select({ id: projects.id }).from(projects).where(inArray(projects.id, projectIds));
      if (found.length !== projectIds.length) throw badRequest(msg("errors:notFound", { what: msg("auth:entities.project") }));
    }

    const token = newToken("api");
    const [row] = await db
      .insert(tokens)
      .values({ userId: user.id, kind: "api", name: body.name, tokenHash: hashToken(token), scope: body.scope, projectIds, expiresAt })
      .returning({ id: tokens.id });
    await audit(db, {
      userId: user.id,
      action: "auth.token_created",
      details: { name: body.name, scope: body.scope, projectIds, expiresAt: expiresAt?.toISOString() ?? null },
    });
    // The plain token is returned once and never stored.
    return { id: row!.id, name: body.name, scope: body.scope, projectIds, expiresAt, token };
  });

  api.delete<{ Params: { id: string } }>("/auth/tokens/:id", async (req) => {
    const deleted = await db
      .delete(tokens)
      .where(and(eq(tokens.id, req.params.id), eq(tokens.userId, req.user!.id), eq(tokens.kind, "api")))
      .returning({ id: tokens.id });
    if (!deleted.length) throw notFound(msg("auth:entities.accessToken"));
    return { ok: true };
  });
}
async function createSession(db: Db, userId: string, reply: FastifyReply, secure: boolean) {
  const token = newToken("s");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.insert(tokens).values({ userId, kind: "session", tokenHash: hashToken(token), expiresAt });
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    expires: expiresAt,
  });
}

/** Reason the user may not create API tokens, or null when allowed. */
async function tokenCreationBlocked(db: Db, user: AuthUser, s: McpSettings): Promise<Msg | null> {
  if (user.isAdmin || s.tokenCreators === "everyone") return null;
  if (s.tokenCreators === "admins") return msg("auth:errors.tokensAdminsOnly");
  const [admin] = await db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(and(eq(projectMembers.userId, user.id), eq(projectMembers.isProjectAdmin, true)))
    .limit(1);
  return admin ? null : msg("auth:errors.tokensProjectAdminsOnly");
}
