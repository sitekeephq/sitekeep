/**
 * OAuth2 endpoints outside /api/v1 (docs/features/OPENCDE.md):
 *   GET  /oauth2/authorize  authorization code flow with PKCE (S256); consent page in the web app
 *   POST /oauth2/token      grant_type=authorization_code | refresh_token (rotation, reuse detection)
 *   POST /oauth2/revoke     RFC 7009 token revocation
 * No implicit grant, no password grant, no client credentials.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { normalizeOAuthScopes, parseOAuthScopes } from "@sitekeep/shared";
import type { ResolvedDeps } from "../app/deps.js";
import { audit } from "../core/platform/audit.js";
import { hashToken } from "../core/security/auth.js";
import type { Db } from "../db/index.js";
import { oauthCodes, oauthRefreshTokens, users } from "../db/schema.js";
import { checkAuthorizeRequest, consentParams } from "./authorize.js";
import { withParams } from "./redirect.js";
import { setOpenCdeCors } from "./cors.js";
import { msg, render, requestLanguage, tFor, type Msg } from "../i18n/index.js";
import {
  allowedScopes,
  consentCovers,
  findClient,
  issueCode,
  issueTokens,
  OAuthError,
  PKCE_VALUE,
  pkceS256,
  revokeFamily,
  revokePresentedToken,
  safeEqual,
  type OAuthClientRow,
  type TokenResponse,
} from "./service.js";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Plain page for requests that must not be redirected (unknown client, unregistered redirect URI). */
export function errorPage(lang: string, message: Msg | string): string {
  const t = tFor(lang);
  return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(t("oauth:errorPage.title"))}</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f7f9;color:#111827;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:24px;max-width:480px}h1{font-size:18px;margin:0 0 12px}p{line-height:1.5;margin:0}</style></head>
<body><main><h1>${escapeHtml(t("oauth:errorPage.heading"))}</h1><p>${escapeHtml(render(lang, message))}</p></main></body></html>`;
}

/** Query string and form/JSON body parameters; a parameter may appear only once. */
function readParams(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (src: unknown) => {
    if (!src || typeof src !== "object") return;
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      if (Array.isArray(v)) throw new OAuthError(400, "invalid_request", `Parameter ${k} was sent more than once.`);
      const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;
      if (s === undefined) continue;
      if (out[k] !== undefined && out[k] !== s) throw new OAuthError(400, "invalid_request", `Parameter ${k} differs between query and body.`);
      out[k] = s;
    }
  };
  add(req.query);
  add(req.body);
  return out;
}

/** HTTP Basic client credentials (RFC 6749 §2.3.1: form-urlencoded id and secret). */
function parseBasic(header: string | undefined): { id: string; secret: string } | null | "bad" {
  const m = header ? /^Basic\s+(\S+)\s*$/i.exec(header) : null;
  if (!m) return null;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return "bad";
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, " "));
    } catch {
      return s;
    }
  };
  return { id: dec(decoded.slice(0, i)), secret: dec(decoded.slice(i + 1)) };
}

/** Client authentication: HTTP Basic or client_secret_post; public clients send only client_id. */
async function authenticateClient(db: Db, req: FastifyRequest, p: Record<string, string>): Promise<OAuthClientRow> {
  const basic = parseBasic(req.headers.authorization);
  const usedBasic = basic !== null;
  const invalid = (d: string) => new OAuthError(401, "invalid_client", d, usedBasic);
  if (basic === "bad") throw invalid("Malformed HTTP Basic credentials.");
  if (basic && p.client_secret !== undefined) throw new OAuthError(400, "invalid_request", "Use one client authentication method.");
  if (basic && p.client_id !== undefined && p.client_id !== basic.id) throw invalid("client_id does not match the credentials.");
  const id = basic ? basic.id : p.client_id;
  const secret = basic ? basic.secret : p.client_secret;
  if (!id) throw invalid("Client authentication is required.");
  const client = await findClient(db, id);
  if (!client) throw invalid("Unknown client.");
  if (!client.enabled) throw invalid("The client is disabled.");
  if (client.type === "confidential") {
    if (!secret || !client.secretHash || !safeEqual(hashToken(secret), client.secretHash)) throw invalid("Client authentication failed.");
  } else if (secret) {
    throw invalid("Public clients have no secret.");
  }
  return client;
}

async function activeUser(db: Db, userId: string): Promise<boolean> {
  const [u] = await db.select({ disabled: users.disabled }).from(users).where(eq(users.id, userId));
  return !!u && !u.disabled;
}

export async function oauthServerRoutes(app: FastifyInstance, deps: ResolvedDeps) {
  const { db, oauth: opts, oauthLimiter: limiter } = deps;

  app.get("/oauth2/authorize", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const check = await checkAuthorizeRequest(db, req.query as Record<string, unknown>);
    if (!check.ok) {
      if (check.redirectTo) return reply.redirect(check.redirectTo);
      return reply.status(400).type("text/html; charset=utf-8").send(errorPage(requestLanguage(req), check.message));
    }
    const r = check.request;
    // Only a browser session may authorize; Bearer tokens never mint OAuth codes.
    const user = req.user?.token?.kind === "session" ? req.user : null;
    if (!user) {
      if (r.prompt === "none") return reply.redirect(withParams(r.redirectUri, { error: "login_required", state: r.state }));
      return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);
    }
    if (r.prompt !== "consent" && (await consentCovers(db, user.id, r.client.id, r.scopes))) {
      const code = await issueCode(db, opts, { client: r.client, userId: user.id, redirectUri: r.redirectUri, scopes: r.scopes, codeChallenge: r.codeChallenge });
      await audit(db, {
        userId: user.id,
        action: "oauth.authorize",
        targetType: "oauth_client",
        targetId: r.client.id,
        details: { clientId: r.client.clientId, scopes: r.scopes, remembered: true },
      });
      return reply.redirect(withParams(r.redirectUri, { code, state: r.state }));
    }
    if (r.prompt === "none") return reply.redirect(withParams(r.redirectUri, { error: "consent_required", state: r.state }));
    return reply.redirect(`/oauth/consent?${new URLSearchParams(consentParams(r)).toString()}`);
  });

  await app.register(async (scope) => {
    // Form bodies only here: the rest of the API keeps refusing them (no cross-site form posts).
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 64 * 1024 }, (_req, body, done) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of new URLSearchParams(body as string)) {
        const prev = out[k];
        out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
      }
      done(null, out);
    });

    for (const path of ["/oauth2/token", "/oauth2/revoke"]) {
      scope.options(path, async (_req, reply) => {
        setOpenCdeCors(reply);
        return reply.status(204).send();
      });
    }

    /** Runs an endpoint with rate limiting of failures and RFC 6749 error bodies. */
    async function guarded(req: FastifyRequest, reply: FastifyReply, endpoint: string, run: () => Promise<unknown>) {
      setOpenCdeCors(reply);
      reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
      const wait = limiter.retryAfter(req.ip);
      if (wait) {
        return reply
          .status(429)
          .header("Retry-After", String(wait))
          .send({ error: "temporarily_unavailable", error_description: "Too many failed requests. Try again later.", message: render(requestLanguage(req), msg("oauth:errors.tooManyAttempts")) });
      }
      try {
        return await run();
      } catch (err) {
        if (!(err instanceof OAuthError)) throw err;
        limiter.fail(req.ip);
        const p = (req.query ?? {}) as Record<string, unknown>;
        const b = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
        const grant = typeof b.grant_type === "string" ? b.grant_type : typeof p.grant_type === "string" ? p.grant_type : undefined;
        await audit(db, {
          action: `oauth.${endpoint}_failed`,
          details: { error: err.error, reason: err.description, grantType: grant?.slice(0, 50), ip: req.ip },
        });
        if (err.basic && err.status === 401) reply.header("WWW-Authenticate", 'Basic realm="SiteKeep"');
        return reply.status(err.status).send({ error: err.error, error_description: err.description, message: err.description });
      }
    }

    scope.post("/oauth2/token", async (req, reply) =>
      guarded(req, reply, "token", async () => {
        const p = readParams(req);
        const client = await authenticateClient(db, req, p);
        if (p.grant_type === "authorization_code") return exchangeCode(client, p);
        if (p.grant_type === "refresh_token") return refresh(client, p);
        if (!p.grant_type) throw new OAuthError(400, "invalid_request", "grant_type is required.");
        throw new OAuthError(400, "unsupported_grant_type", "Supported: authorization_code, refresh_token.");
      }),
    );

    scope.post("/oauth2/revoke", async (req, reply) =>
      guarded(req, reply, "revoke", async () => {
        const p = readParams(req);
        const client = await authenticateClient(db, req, p);
        if (!p.token) throw new OAuthError(400, "invalid_request", "token is required.");
        const kind = await revokePresentedToken(db, client, p.token);
        if (kind) await audit(db, { action: "oauth.revoked", targetType: "oauth_client", targetId: client.id, details: { clientId: client.clientId, via: "client", token: kind } });
        // RFC 7009: unknown tokens are answered the same way.
        return {};
      }),
    );
  });

  async function exchangeCode(client: OAuthClientRow, p: Record<string, string>): Promise<TokenResponse> {
    if (!p.code) throw new OAuthError(400, "invalid_request", "code is required.");
    const hash = hashToken(p.code);
    const now = new Date();
    // One-time: claim the code first; any later failure leaves it used.
    const [row] = await db
      .update(oauthCodes)
      .set({ usedAt: now })
      .where(and(eq(oauthCodes.codeHash, hash), isNull(oauthCodes.usedAt)))
      .returning();
    if (!row) {
      const [used] = await db.select().from(oauthCodes).where(eq(oauthCodes.codeHash, hash));
      if (used && used.clientId === client.id) {
        // RFC 6749 §4.1.2: a reused code revokes the tokens issued for it.
        await revokeFamily(db, used.familyId);
        await audit(db, { userId: used.userId, action: "oauth.code_reused", targetType: "oauth_client", targetId: client.id, details: { clientId: client.clientId } });
      }
      throw new OAuthError(400, "invalid_grant", "The authorization code is invalid or was already used.");
    }
    if (row.clientId !== client.id) throw new OAuthError(400, "invalid_grant", "The authorization code was issued to another client.");
    if (row.expiresAt.getTime() <= now.getTime()) throw new OAuthError(400, "invalid_grant", "The authorization code has expired.");
    const redirect = p.redirect_uri ?? p.redirect_url;
    if (p.redirect_uri !== undefined && p.redirect_url !== undefined && p.redirect_uri !== p.redirect_url)
      throw new OAuthError(400, "invalid_request", "redirect_uri and redirect_url differ.");
    if (redirect !== undefined && redirect !== row.redirectUri) throw new OAuthError(400, "invalid_grant", "redirect_uri does not match the authorization request.");
    const verifier = p.code_verifier;
    if (row.codeChallenge) {
      if (!verifier) throw new OAuthError(400, "invalid_grant", "code_verifier is required.");
      if (!PKCE_VALUE.test(verifier) || !safeEqual(pkceS256(verifier), row.codeChallenge)) throw new OAuthError(400, "invalid_grant", "PKCE verification failed.");
    } else if (verifier) {
      throw new OAuthError(400, "invalid_grant", "code_verifier sent but the authorization request had no code_challenge.");
    }
    if (!(await activeUser(db, row.userId))) throw new OAuthError(400, "invalid_grant", "The user account is disabled.");
    const scopes = allowedScopes(client, row.scopes);
    if (!scopes.length) throw new OAuthError(400, "invalid_scope", "No scope left for this client.");
    const res = await issueTokens(db, opts, { client, userId: row.userId, scopes, familyId: row.familyId });
    await audit(db, { userId: row.userId, action: "oauth.token_issued", targetType: "oauth_client", targetId: client.id, details: { clientId: client.clientId, grantType: "authorization_code", scopes } });
    return res;
  }

  async function refresh(client: OAuthClientRow, p: Record<string, string>): Promise<TokenResponse> {
    if (!p.refresh_token) throw new OAuthError(400, "invalid_request", "refresh_token is required.");
    const [row] = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.tokenHash, hashToken(p.refresh_token)));
    if (!row || row.clientId !== client.id) throw new OAuthError(400, "invalid_grant", "Invalid refresh token.");
    if (row.revokedAt) throw new OAuthError(400, "invalid_grant", "The refresh token was revoked.");
    const reused = async () => {
      // A rotated token came back: someone else may hold a copy. Revoke the whole family.
      await revokeFamily(db, row.familyId);
      await audit(db, { userId: row.userId, action: "oauth.refresh_reused", targetType: "oauth_client", targetId: client.id, details: { clientId: client.clientId } });
      return new OAuthError(400, "invalid_grant", "The refresh token was already used; the token family is revoked.");
    };
    if (row.usedAt) throw await reused();
    if (row.expiresAt.getTime() <= Date.now()) throw new OAuthError(400, "invalid_grant", "The refresh token has expired.");
    let scopes = row.scopes;
    if (p.scope !== undefined) {
      const asked = normalizeOAuthScopes(parseOAuthScopes(p.scope));
      if (!asked.length || asked.some((s) => !row.scopes.includes(s))) throw new OAuthError(400, "invalid_scope", "The scope may only narrow the original grant.");
      scopes = asked;
    }
    const [claimed] = await db
      .update(oauthRefreshTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(oauthRefreshTokens.id, row.id), isNull(oauthRefreshTokens.usedAt), isNull(oauthRefreshTokens.revokedAt)))
      .returning({ id: oauthRefreshTokens.id });
    if (!claimed) throw await reused();
    if (!(await activeUser(db, row.userId))) throw new OAuthError(400, "invalid_grant", "The user account is disabled.");
    scopes = allowedScopes(client, scopes);
    if (!scopes.length) throw new OAuthError(400, "invalid_scope", "No scope left for this client.");
    const res = await issueTokens(db, opts, { client, userId: row.userId, scopes, familyId: row.familyId });
    await audit(db, { userId: row.userId, action: "oauth.token_refreshed", targetType: "oauth_client", targetId: client.id, details: { clientId: client.clientId, scopes } });
    return res;
  }
}
