/**
 * /api/v1 routes of the OAuth server, for the web app:
 *   GET  /oauth/authorize-info, POST /oauth/consent     consent page (browser session only)
 *   GET  /auth/oauth-apps, DELETE /auth/oauth-apps/:id  Hesabım → Bağlı Uygulamalar
 *   /admin/oauth-clients …                              Yönetim → OAuth Uygulamaları
 */
import { randomBytes } from "node:crypto";
import { and, asc, count, eq, gt, isNull, max } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  normalizeOAuthScopes,
  OAUTH_SCOPES,
  type ConnectedAppDto,
  type OAuthClientDto,
  type OAuthConsentDto,
} from "@sitekeep/shared";
import type { ResolvedDeps } from "../app/deps.js";
import { audit } from "../core/platform/audit.js";
import { hashToken, newToken } from "../core/security/auth.js";
import { oauthClients, oauthConsents, oauthRefreshTokens, tokens } from "../db/schema.js";
import { HttpError, badRequest, forbidden, notFound } from "../core/platform/http.js";
import { checkAuthorizeRequest } from "./authorize.js";
import { oauthEndpoints } from "./config.js";
import { redirectTarget, redirectUriProblem, withParams } from "./redirect.js";
import { issueCode, rememberConsent, revokeUserClient, type OAuthClientRow } from "./service.js";
import { DEFAULT_LANGUAGE, msg, render } from "../i18n/index.js";

function requireSession(req: FastifyRequest) {
  if (req.user?.token?.kind !== "session") throw forbidden(msg("oauth:errors.sessionRequired"));
}

function requireAdmin(req: FastifyRequest) {
  if (!req.user?.isAdmin) throw forbidden(msg("oauth:errors.adminRequired"));
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const redirectUris = z
  .array(z.string().trim().min(1).max(2000))
  .min(1, render(DEFAULT_LANGUAGE, msg("oauth:errors.redirectUriRequired")))
  .max(20)
  .transform((list, ctx) => {
    const unique = [...new Set(list)];
    for (const uri of unique) {
      const problem = redirectUriProblem(uri);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }
    return unique;
  });
const scopes = z
  .array(z.enum(OAUTH_SCOPES))
  .min(1, render(DEFAULT_LANGUAGE, msg("oauth:errors.scopeRequired")))
  .transform((s) => normalizeOAuthScopes(s));
const name = z.string().trim().min(1).max(100);
const description = z
  .string()
  .trim()
  .max(500)
  .nullable()
  .optional()
  .transform((v) => (v === undefined ? undefined : v || null));

export async function oauthApiRoutes(api: FastifyInstance, deps: ResolvedDeps) {
  const { db, oauth: opts } = deps;

  // ---- Consent page ---------------------------------------------------------------------------

  api.get("/oauth/authorize-info", async (req): Promise<OAuthConsentDto> => {
    requireSession(req);
    const check = await checkAuthorizeRequest(db, req.query as Record<string, unknown>);
    if (!check.ok) throw new HttpError(400, "invalid_request", check.redirectTo ? msg("oauth:errors.invalidClientRequest") : check.message, { redirectTo: check.redirectTo });
    const { client, redirectUri, scopes: granted } = check.request;
    return {
      client: { clientId: client.clientId, name: client.name, description: client.description, type: client.type },
      scopes: granted,
      redirectUri,
      redirectTarget: redirectTarget(redirectUri),
    };
  });

  api.post("/oauth/consent", async (req) => {
    requireSession(req);
    const body = z.object({ params: z.record(z.string(), z.string()), approve: z.boolean() }).parse(req.body);
    const user = req.user!;
    const check = await checkAuthorizeRequest(db, body.params);
    if (!check.ok) {
      if (check.redirectTo) return { redirectTo: check.redirectTo };
      throw badRequest(check.message);
    }
    const r = check.request;
    const target = { targetType: "oauth_client", targetId: r.client.id };
    if (!body.approve) {
      await audit(db, { userId: user.id, action: "oauth.consent_denied", ...target, details: { clientId: r.client.clientId, scopes: r.scopes } });
      return { redirectTo: withParams(r.redirectUri, { error: "access_denied", error_description: "The user denied access.", state: r.state }) };
    }
    await rememberConsent(db, user.id, r.client.id, r.scopes);
    const code = await issueCode(db, opts, { client: r.client, userId: user.id, redirectUri: r.redirectUri, scopes: r.scopes, codeChallenge: r.codeChallenge });
    await audit(db, { userId: user.id, action: "oauth.consent_granted", ...target, details: { clientId: r.client.clientId, scopes: r.scopes } });
    await audit(db, { userId: user.id, action: "oauth.authorize", ...target, details: { clientId: r.client.clientId, scopes: r.scopes, remembered: false } });
    return { redirectTo: withParams(r.redirectUri, { code, state: r.state }) };
  });

  // ---- Hesabım → Bağlı Uygulamalar --------------------------------------------------------------

  api.get("/auth/oauth-apps", async (req): Promise<ConnectedAppDto[]> => {
    const userId = req.user!.id;
    const now = new Date();
    const consents = await db
      .select({ client: oauthClients, scopes: oauthConsents.scopes, consentedAt: oauthConsents.createdAt, lastUsedAt: oauthConsents.lastUsedAt })
      .from(oauthConsents)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthConsents.clientId))
      .where(eq(oauthConsents.userId, userId));
    const access = await db
      .select({ clientId: tokens.oauthClientId, last: max(tokens.lastUsedAt) })
      .from(tokens)
      .where(and(eq(tokens.userId, userId), eq(tokens.kind, "oauth"), gt(tokens.expiresAt, now)))
      .groupBy(tokens.oauthClientId);
    const refresh = await db
      .select({ clientId: oauthRefreshTokens.clientId })
      .from(oauthRefreshTokens)
      .where(
        and(
          eq(oauthRefreshTokens.userId, userId),
          isNull(oauthRefreshTokens.usedAt),
          isNull(oauthRefreshTokens.revokedAt),
          gt(oauthRefreshTokens.expiresAt, now),
        ),
      )
      .groupBy(oauthRefreshTokens.clientId);
    const lastAccess = new Map(access.map((a) => [a.clientId, a.last]));
    const active = new Set([...access.map((a) => a.clientId), ...refresh.map((r) => r.clientId)]);
    const latest = (a: Date | null, b: Date | null | undefined) => (!a ? (b ?? null) : !b ? a : a > b ? a : b);
    const apps = consents.map(
      (c): ConnectedAppDto => ({
        id: c.client.id,
        clientId: c.client.clientId,
        name: c.client.name,
        scopes: normalizeOAuthScopes(c.scopes),
        consentedAt: iso(c.consentedAt),
        lastUsedAt: iso(latest(c.lastUsedAt, lastAccess.get(c.client.id))),
        active: active.has(c.client.id),
      }),
    );
    // Tokens without a remembered consent (should not happen, but they must be revocable too).
    const orphan = [...active].filter((id): id is string => !!id && !apps.some((a) => a.id === id));
    if (orphan.length) {
      const rows = await db.select().from(oauthClients);
      for (const c of rows.filter((r) => orphan.includes(r.id))) {
        apps.push({ id: c.id, clientId: c.clientId, name: c.name, scopes: [], consentedAt: null, lastUsedAt: iso(lastAccess.get(c.id)), active: true });
      }
    }
    return apps.sort((a, b) => a.name.localeCompare(b.name, "tr"));
  });

  api.delete<{ Params: { id: string } }>("/auth/oauth-apps/:id", async (req) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw notFound(msg("oauth:entities.connectedApp"));
    const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, id.data));
    if (!client) throw notFound(msg("oauth:entities.connectedApp"));
    await revokeUserClient(db, req.user!.id, client.id);
    await audit(db, { userId: req.user!.id, action: "oauth.revoked", targetType: "oauth_client", targetId: client.id, details: { clientId: client.clientId, via: "user" } });
    return { ok: true };
  });

  // ---- Yönetim → OAuth Uygulamaları -------------------------------------------------------------

  async function toDtos(rows: OAuthClientRow[]): Promise<OAuthClientDto[]> {
    const stats = await db
      .select({ clientId: oauthConsents.clientId, users: count(), last: max(oauthConsents.lastUsedAt) })
      .from(oauthConsents)
      .groupBy(oauthConsents.clientId);
    const byClient = new Map(stats.map((s) => [s.clientId, s]));
    return rows.map((c) => ({
      id: c.id,
      clientId: c.clientId,
      name: c.name,
      description: c.description,
      type: c.type,
      redirectUris: c.redirectUris,
      scopes: normalizeOAuthScopes(c.scopes),
      enabled: c.enabled,
      secretSetAt: iso(c.secretSetAt),
      createdAt: c.createdAt.toISOString(),
      userCount: Number(byClient.get(c.id)?.users ?? 0),
      lastUsedAt: iso(byClient.get(c.id)?.last ?? null),
    }));
  }

  async function loadClient(id: string): Promise<OAuthClientRow> {
    const parsed = z.string().uuid().safeParse(id);
    const [client] = parsed.success ? await db.select().from(oauthClients).where(eq(oauthClients.id, parsed.data)) : [];
    if (!client) throw notFound(msg("oauth:entities.client"));
    return client;
  }

  const one = async (c: OAuthClientRow) => (await toDtos([c]))[0]!;

  api.get("/admin/oauth-clients", async (req) => {
    requireAdmin(req);
    const rows = await db.select().from(oauthClients).orderBy(asc(oauthClients.name));
    return { clients: await toDtos(rows), endpoints: oauthEndpoints(opts, req) };
  });

  api.post("/admin/oauth-clients", async (req) => {
    requireAdmin(req);
    const body = z
      .object({ name, description, type: z.enum(["public", "confidential"]), redirectUris, scopes })
      .parse(req.body);
    const secret = body.type === "confidential" ? newToken("secret") : null;
    const [row] = await db
      .insert(oauthClients)
      .values({
        clientId: `cde-${randomBytes(10).toString("hex")}`,
        name: body.name,
        description: body.description ?? null,
        type: body.type,
        secretHash: secret ? hashToken(secret) : null,
        secretSetAt: secret ? new Date() : null,
        redirectUris: body.redirectUris,
        scopes: body.scopes,
        createdBy: req.user!.id,
      })
      .returning();
    await audit(db, {
      userId: req.user!.id,
      action: "oauth.client_created",
      targetType: "oauth_client",
      targetId: row!.id,
      details: { clientId: row!.clientId, name: row!.name, type: row!.type, scopes: row!.scopes, redirectUris: row!.redirectUris },
    });
    // The secret is returned once and only its hash is stored.
    return { client: await one(row!), clientSecret: secret };
  });

  api.patch<{ Params: { id: string } }>("/admin/oauth-clients/:id", async (req) => {
    requireAdmin(req);
    const client = await loadClient(req.params.id);
    const body = z
      .object({ name: name.optional(), description, redirectUris: redirectUris.optional(), scopes: scopes.optional(), enabled: z.boolean().optional() })
      .parse(req.body);
    const [row] = await db
      .update(oauthClients)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.redirectUris !== undefined && { redirectUris: body.redirectUris }),
        ...(body.scopes !== undefined && { scopes: body.scopes }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        updatedAt: new Date(),
      })
      .where(eq(oauthClients.id, client.id))
      .returning();
    const action = body.enabled === false && client.enabled ? "oauth.client_disabled" : body.enabled === true && !client.enabled ? "oauth.client_enabled" : "oauth.client_updated";
    await audit(db, { userId: req.user!.id, action, targetType: "oauth_client", targetId: client.id, details: { clientId: client.clientId, changes: Object.keys(body) } });
    return one(row!);
  });

  api.post<{ Params: { id: string } }>("/admin/oauth-clients/:id/secret", async (req) => {
    requireAdmin(req);
    const client = await loadClient(req.params.id);
    if (client.type !== "confidential") throw badRequest(msg("oauth:errors.publicClientNoSecret"));
    const secret = newToken("secret");
    const [row] = await db
      .update(oauthClients)
      .set({ secretHash: hashToken(secret), secretSetAt: new Date(), updatedAt: new Date() })
      .where(eq(oauthClients.id, client.id))
      .returning();
    await audit(db, { userId: req.user!.id, action: "oauth.client_secret_rotated", targetType: "oauth_client", targetId: client.id, details: { clientId: client.clientId } });
    return { client: await one(row!), clientSecret: secret };
  });

  api.delete<{ Params: { id: string } }>("/admin/oauth-clients/:id", async (req) => {
    requireAdmin(req);
    const client = await loadClient(req.params.id);
    // Consents, codes, refresh and access tokens go with it (foreign keys cascade).
    await db.delete(oauthClients).where(eq(oauthClients.id, client.id));
    await audit(db, { userId: req.user!.id, action: "oauth.client_deleted", targetType: "oauth_client", targetId: client.id, details: { clientId: client.clientId, name: client.name } });
    return { ok: true };
  });
}
