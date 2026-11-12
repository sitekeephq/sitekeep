/**
 * OAuth2 authorization server core: authorization codes, access and refresh tokens, token
 * families and revocation. Access tokens are rows of `tokens` (kind "oauth"), so they go through
 * the same Bearer authentication and permission checks as API tokens (app.ts, token-scope.ts).
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";
import { normalizeOAuthScopes, oauthApiAccess, type OAuthScope } from "@sitekeep/shared";
import { hashToken, newToken } from "../core/security/auth.js";
import type { Db } from "../db/index.js";
import { oauthClients, oauthCodes, oauthConsents, oauthRefreshTokens, tokens } from "../db/schema.js";
import type { ResolvedOAuthOptions } from "./config.js";

export type OAuthClientRow = typeof oauthClients.$inferSelect;

/** Protocol error of the token / revocation endpoints (RFC 6749 §5.2). */
export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly description: string,
    /** The client tried HTTP Basic: answer 401 with WWW-Authenticate. */
    readonly basic = false,
  ) {
    super(description);
  }
}

/** PKCE code_verifier / code_challenge: 43–128 unreserved characters (RFC 7636 §4.1). */
export const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Scopes the client still may use (an administrator can narrow them later). */
export function allowedScopes(client: OAuthClientRow, scopes: readonly string[]): OAuthScope[] {
  return normalizeOAuthScopes(scopes.filter((s) => client.scopes.includes(s as OAuthScope)));
}

export async function findClient(db: Db, clientId: string): Promise<OAuthClientRow | undefined> {
  const [client] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
  return client;
}

/** Issues a one-time authorization code bound to client, user, redirect URI and PKCE challenge. */
export async function issueCode(
  db: Db,
  opts: ResolvedOAuthOptions,
  input: { client: OAuthClientRow; userId: string; redirectUri: string; scopes: OAuthScope[]; codeChallenge: string | null },
): Promise<string> {
  const now = Date.now();
  // Old codes are only needed for reuse detection while they could still be exchanged.
  await db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, new Date(now - 86400_000)));
  const code = newToken("code");
  await db.insert(oauthCodes).values({
    codeHash: hashToken(code),
    clientId: input.client.id,
    userId: input.userId,
    redirectUri: input.redirectUri,
    scopes: input.scopes,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallenge ? "S256" : null,
    familyId: randomUUID(),
    expiresAt: new Date(now + opts.codeSeconds * 1000),
  });
  await touchConsent(db, input.userId, input.client.id);
  return code;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** New access token (tokens table, kind "oauth") and refresh token of the same family. */
export async function issueTokens(
  db: Db,
  opts: ResolvedOAuthOptions,
  input: { client: OAuthClientRow; userId: string; scopes: OAuthScope[]; familyId: string },
): Promise<TokenResponse> {
  const now = Date.now();
  const access = newToken("oauth");
  const refresh = newToken("refresh");
  await db.transaction(async (tx) => {
    // Expired access tokens of this user and client are no longer useful.
    await tx
      .delete(tokens)
      .where(
        and(
          eq(tokens.userId, input.userId),
          eq(tokens.oauthClientId, input.client.id),
          eq(tokens.kind, "oauth"),
          lt(tokens.expiresAt, new Date(now - 86400_000)),
        ),
      );
    await tx.insert(tokens).values({
      userId: input.userId,
      kind: "oauth",
      name: input.client.name,
      tokenHash: hashToken(access),
      expiresAt: new Date(now + opts.accessTokenSeconds * 1000),
      scope: oauthApiAccess(input.scopes) ?? "read",
      oauthClientId: input.client.id,
      oauthFamilyId: input.familyId,
      oauthScopes: input.scopes,
    });
    await tx.insert(oauthRefreshTokens).values({
      tokenHash: hashToken(refresh),
      familyId: input.familyId,
      clientId: input.client.id,
      userId: input.userId,
      scopes: input.scopes,
      expiresAt: new Date(now + opts.refreshTokenDays * 86400_000),
    });
  });
  await touchConsent(db, input.userId, input.client.id);
  return { access_token: access, token_type: "Bearer", expires_in: opts.accessTokenSeconds, refresh_token: refresh, scope: input.scopes.join(" ") };
}

/** Revokes every access and refresh token of a family (code or refresh token reuse). */
export async function revokeFamily(db: Db, familyId: string): Promise<void> {
  await db.delete(tokens).where(and(eq(tokens.kind, "oauth"), eq(tokens.oauthFamilyId, familyId)));
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauthRefreshTokens.familyId, familyId), isNull(oauthRefreshTokens.revokedAt)));
}

/** "Erişimi Kaldır": consent, tokens and pending codes of one user for one client. */
export async function revokeUserClient(db: Db, userId: string, clientRowId: string): Promise<void> {
  await db.delete(tokens).where(and(eq(tokens.userId, userId), eq(tokens.kind, "oauth"), eq(tokens.oauthClientId, clientRowId)));
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauthRefreshTokens.userId, userId), eq(oauthRefreshTokens.clientId, clientRowId), isNull(oauthRefreshTokens.revokedAt)));
  await db
    .update(oauthCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(oauthCodes.userId, userId), eq(oauthCodes.clientId, clientRowId), isNull(oauthCodes.usedAt)));
  await db.delete(oauthConsents).where(and(eq(oauthConsents.userId, userId), eq(oauthConsents.clientId, clientRowId)));
}

/** Remembered consent of the user for the client, if it covers the scopes. */
export async function consentCovers(db: Db, userId: string, clientRowId: string, scopes: readonly OAuthScope[]): Promise<boolean> {
  const [c] = await db
    .select({ scopes: oauthConsents.scopes })
    .from(oauthConsents)
    .where(and(eq(oauthConsents.userId, userId), eq(oauthConsents.clientId, clientRowId)));
  return !!c && scopes.every((s) => c.scopes.includes(s));
}

/** Records "Onayla": the consent covers the union of earlier and new scopes. */
export async function rememberConsent(db: Db, userId: string, clientRowId: string, scopes: readonly OAuthScope[]): Promise<void> {
  const [c] = await db
    .select({ scopes: oauthConsents.scopes })
    .from(oauthConsents)
    .where(and(eq(oauthConsents.userId, userId), eq(oauthConsents.clientId, clientRowId)));
  const now = new Date();
  if (c) {
    await db
      .update(oauthConsents)
      .set({ scopes: normalizeOAuthScopes([...c.scopes, ...scopes]), updatedAt: now })
      .where(and(eq(oauthConsents.userId, userId), eq(oauthConsents.clientId, clientRowId)));
  } else {
    await db.insert(oauthConsents).values({ userId, clientId: clientRowId, scopes: normalizeOAuthScopes(scopes) });
  }
}

async function touchConsent(db: Db, userId: string, clientRowId: string): Promise<void> {
  await db
    .update(oauthConsents)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(oauthConsents.userId, userId), eq(oauthConsents.clientId, clientRowId)));
}

/** Refresh or access token presented by the client for revocation (RFC 7009). */
export async function revokePresentedToken(db: Db, client: OAuthClientRow, token: string): Promise<"refresh" | "access" | null> {
  const hash = hashToken(token);
  const [rt] = await db
    .select({ familyId: oauthRefreshTokens.familyId })
    .from(oauthRefreshTokens)
    .where(and(eq(oauthRefreshTokens.tokenHash, hash), eq(oauthRefreshTokens.clientId, client.id)));
  if (rt) {
    await revokeFamily(db, rt.familyId);
    return "refresh";
  }
  const gone = await db
    .delete(tokens)
    .where(and(eq(tokens.tokenHash, hash), eq(tokens.kind, "oauth"), eq(tokens.oauthClientId, client.id)))
    .returning({ id: tokens.id });
  return gone.length ? "access" : null;
}
