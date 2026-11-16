/**
 * OpenID Connect relying party (docs/features/OIDC_SIGN_IN.md): discovery, the authorization code flow
 * with PKCE (S256), state and nonce, and ID token validation (iss, aud/azp, exp/iat, nonce and the
 * signature against the provider's JWKS, with an allow-list of asymmetric algorithms). Signature checks
 * use `jose` (MIT, also used by the MCP SDK).
 *
 * Every call to the provider goes through outboundFetch with the provider's own connection
 * "oidc:<id>" (Privacy Centre → External Connections); switched off, the button disappears and every
 * step is refused.
 */
import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { z } from "zod";
import { normalizeIssuer } from "@sitekeep/shared";
import { decryptSecret, encryptSecret } from "../core/platform/secrets.js";
import type { Db } from "../db/index.js";
import type { Msg } from "../i18n/index.js";
import { outboundFetch, outboundRefusalMsg } from "../privacy/outbound.js";
import { refreshPrivacyState } from "../privacy/settings.js";
import type { StoredOidcProvider } from "./oidc-settings.js";

export const OIDC_PURPOSE = "giris:oidc";
/** Asymmetric signatures only: never "none", never HS* (the client secret is not a signing key here). */
export const OIDC_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"] as const;
const DISCOVERY_TTL_MS = 60 * 60_000;
const JWKS_TTL_MS = 60 * 60_000;
/** A key id the cached set does not know triggers a new download at most this often. */
const JWKS_REFRESH_MS = 30_000;
const TIMEOUT_MS = 10_000;
const CLOCK_TOLERANCE_S = 60;

/** A failure of the protocol (logged; the person sees "sign-in failed"). */
export class OidcError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** The connection id of a provider in the Privacy Centre. */
export function oidcConnectionId(id: string): string {
  return `oidc:${id}`;
}

/** Why sign-in with this provider is refused right now (its connection off, kill switch), or null. */
export async function oidcRefusal(db: Db, p: Pick<StoredOidcProvider, "id" | "issuer">): Promise<Msg | null> {
  await refreshPrivacyState(db);
  return outboundRefusalMsg(p.issuer, oidcConnectionId(p.id), OIDC_PURPOSE);
}

/** Every request to the provider: its own connection, a timeout, no redirects. */
function oidcFetch(p: StoredOidcProvider, url: string, init: RequestInit = {}): Promise<Response> {
  return outboundFetch(OIDC_PURPOSE, url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) }, { connection: `oidc:${p.id}`, details: { provider: p.id } });
}

async function readJson(res: Response, what: string): Promise<unknown> {
  if (!res.ok) throw new OidcError(`${what}_http_${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new OidcError(`${what}_not_json`);
  }
}

// ---- Discovery and keys ------------------------------------------------------------------------

const endpoint = z.string().url();
const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: endpoint,
  token_endpoint: endpoint,
  jwks_uri: endpoint,
  userinfo_endpoint: endpoint.optional(),
  id_token_signing_alg_values_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});
export type OidcDiscovery = z.infer<typeof discoverySchema>;

const discoveryCache = new Map<string, { at: number; value: OidcDiscovery }>();
const jwksCache = new Map<string, { at: number; keys: JSONWebKeySet }>();
/** Last download forced by an unknown key id, per provider: at most one per JWKS_REFRESH_MS. */
const jwksForced = new Map<string, number>();

/** Forget cached documents of a provider (after it was changed or removed); no id = all. */
export function forgetOidcCache(id?: string): void {
  for (const map of [discoveryCache, jwksCache, jwksForced] as Map<string, unknown>[]) {
    if (!id) map.clear();
    else for (const k of map.keys()) if (k.startsWith(`${id}|`)) map.delete(k);
  }
}

/** An endpoint uses TLS, or plain http on this machine (a local development provider). */
function secureEndpoint(url: string): boolean {
  const u = new URL(url);
  return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
}

/** The provider's discovery document (cached for an hour); its issuer must be the configured one. */
export async function oidcDiscovery(p: StoredOidcProvider, now = Date.now()): Promise<OidcDiscovery> {
  const key = `${p.id}|${p.issuer}`;
  const hit = discoveryCache.get(key);
  if (hit && now - hit.at < DISCOVERY_TTL_MS) return hit.value;
  const parsed = discoverySchema.safeParse(await readJson(await oidcFetch(p, `${p.issuer}/.well-known/openid-configuration`), "discovery"));
  if (!parsed.success) throw new OidcError("discovery_invalid");
  const d = parsed.data;
  if (normalizeIssuer(d.issuer) !== p.issuer) throw new OidcError("discovery_issuer_mismatch");
  for (const url of [d.authorization_endpoint, d.token_endpoint, d.jwks_uri, d.userinfo_endpoint].filter((u): u is string => !!u))
    if (!secureEndpoint(url)) throw new OidcError("discovery_insecure_endpoint");
  if (d.code_challenge_methods_supported && !d.code_challenge_methods_supported.includes("S256")) throw new OidcError("discovery_no_pkce_s256");
  discoveryCache.set(key, { at: now, value: d });
  return d;
}

async function downloadJwks(p: StoredOidcProvider, d: OidcDiscovery): Promise<JSONWebKeySet> {
  const parsed = z.object({ keys: z.array(z.record(z.string(), z.unknown())) }).safeParse(await readJson(await oidcFetch(p, d.jwks_uri), "jwks"));
  if (!parsed.success) throw new OidcError("jwks_invalid");
  const keys = parsed.data as unknown as JSONWebKeySet;
  jwksCache.set(`${p.id}|${d.jwks_uri}`, { at: Date.now(), keys });
  return keys;
}

async function jwks(p: StoredOidcProvider, d: OidcDiscovery, fresh: boolean): Promise<JSONWebKeySet> {
  const key = `${p.id}|${d.jwks_uri}`;
  const hit = jwksCache.get(key);
  if (hit && !fresh && Date.now() - hit.at < JWKS_TTL_MS) return hit.keys;
  if (hit && fresh) {
    if (Date.now() - (jwksForced.get(key) ?? 0) < JWKS_REFRESH_MS) return hit.keys;
    jwksForced.set(key, Date.now());
  }
  return downloadJwks(p, d);
}

/** The algorithms accepted for this provider: our allow-list, narrowed by what it says it uses. */
export function oidcAlgorithms(d: OidcDiscovery): string[] {
  const offered = d.id_token_signing_alg_values_supported;
  const allowed = OIDC_ALGORITHMS.filter((a) => !offered || offered.includes(a));
  return allowed.length ? allowed : ["RS256"];
}

// ---- The flow ----------------------------------------------------------------------------------

/** What the browser carries from the start to the callback (in an encrypted cookie). */
export interface OidcFlow {
  /** Provider id. */
  p: string;
  state: string;
  nonce: string;
  verifier: string;
  /** Expiry, ms since the epoch. */
  exp: number;
}

export const OIDC_FLOW_COOKIE = "cde_oidc";
export const OIDC_FLOW_PATH = "/api/v1/auth/oidc";
export const OIDC_FLOW_SECONDS = 10 * 60;

function flowKey(secretKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", secretKey, Buffer.alloc(0), "sitekeep.auth.oidc-flow.v1", 32));
}

export function sealFlow(secretKey: Buffer, flow: OidcFlow): string {
  return Buffer.from(encryptSecret(flowKey(secretKey), JSON.stringify(flow))).toString("base64url");
}

export function openFlow(secretKey: Buffer, sealed: string | undefined, now = Date.now()): OidcFlow | null {
  if (!sealed || sealed.length > 4000) return null;
  try {
    const f = JSON.parse(decryptSecret(flowKey(secretKey), Buffer.from(sealed, "base64url").toString("utf8"))) as OidcFlow;
    if (typeof f.p !== "string" || typeof f.state !== "string" || typeof f.nonce !== "string" || typeof f.verifier !== "string") return null;
    return typeof f.exp === "number" && f.exp > now ? f : null;
  } catch {
    return null;
  }
}

/** A new flow and the provider's authorization URL to send the browser to. */
export async function startOidcFlow(p: StoredOidcProvider, redirectUri: string): Promise<{ url: string; flow: OidcFlow }> {
  const d = await oidcDiscovery(p);
  const flow: OidcFlow = {
    p: p.id,
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    verifier: randomBytes(48).toString("base64url"),
    exp: Date.now() + OIDC_FLOW_SECONDS * 1000,
  };
  const url = new URL(d.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", p.scopes);
  url.searchParams.set("state", flow.state);
  url.searchParams.set("nonce", flow.nonce);
  url.searchParams.set("code_challenge", createHash("sha256").update(flow.verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), flow };
}

/** The claims the sign-in uses, from the validated ID token (and userinfo when it lacked the address). */
export type OidcClaims = JWTPayload & Record<string, unknown>;

/**
 * Exchanges the code (with the PKCE verifier) and validates the ID token. Returns its claims, completed
 * from the userinfo endpoint when the ID token has no e-mail claim (same `sub` required).
 */
export async function finishOidcFlow(
  p: StoredOidcProvider,
  clientSecret: string | null,
  flow: OidcFlow,
  code: string,
  redirectUri: string,
): Promise<OidcClaims> {
  const d = await oidcDiscovery(p);
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: flow.verifier });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const methods = d.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  if (clientSecret && !methods.includes("client_secret_post")) {
    // RFC 6749 §2.3.1: both parts form-encoded before Basic.
    const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, "+");
    headers.authorization = `Basic ${Buffer.from(`${enc(p.clientId)}:${enc(clientSecret)}`).toString("base64")}`;
  } else {
    body.set("client_id", p.clientId);
    if (clientSecret) body.set("client_secret", clientSecret);
  }
  const tokenRes = await oidcFetch(p, d.token_endpoint, { method: "POST", headers, body });
  const token = z
    .object({ id_token: z.string(), access_token: z.string().optional(), token_type: z.string().optional() })
    .safeParse(await readJson(tokenRes, "token"));
  if (!token.success) throw new OidcError("token_no_id_token");

  const claims = await verifyIdToken(p, d, token.data.id_token, flow.nonce);
  if (claims[p.emailClaim] === undefined && d.userinfo_endpoint && token.data.access_token) {
    const info = await readJson(await oidcFetch(p, d.userinfo_endpoint, { headers: { authorization: `Bearer ${token.data.access_token}`, accept: "application/json" } }), "userinfo");
    if (!info || typeof info !== "object" || (info as { sub?: unknown }).sub !== claims.sub) throw new OidcError("userinfo_sub_mismatch");
    // The ID token's own claims win (they are signed).
    return { ...(info as Record<string, unknown>), ...claims };
  }
  return claims;
}

export async function verifyIdToken(p: StoredOidcProvider, d: OidcDiscovery, idToken: string, nonce: string): Promise<OidcClaims> {
  const options = { issuer: d.issuer, audience: p.clientId, algorithms: oidcAlgorithms(d), clockTolerance: CLOCK_TOLERANCE_S, requiredClaims: ["sub", "exp", "iat"] };
  let result;
  try {
    result = await jwtVerify(idToken, createLocalJWKSet(await jwks(p, d, false)), options);
  } catch (err) {
    // A key the cached set does not have: the provider rotated its keys; download them again once.
    if (!(err instanceof joseErrors.JWKSNoMatchingKey)) throw new OidcError("id_token_invalid", (err as Error).message);
    try {
      result = await jwtVerify(idToken, createLocalJWKSet(await jwks(p, d, true)), options);
    } catch (again) {
      throw new OidcError("id_token_invalid", (again as Error).message);
    }
  }
  const claims = result.payload as OidcClaims;
  // Several audiences: this client must be the authorized party (OIDC Core §3.1.3.7).
  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== p.clientId) throw new OidcError("id_token_azp");
  if (claims.azp !== undefined && claims.azp !== p.clientId) throw new OidcError("id_token_azp");
  if (claims.nonce !== nonce) throw new OidcError("id_token_nonce");
  return claims;
}

/** A claim as text ("email", or a dotted path "extension.mail"). */
export function claimText(claims: Record<string, unknown>, name: string): string | null {
  let v: unknown = claims[name];
  if (v === undefined && name.includes(".")) v = name.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), claims);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** A claim as a list of strings (groups: an array, or a single string). */
export function claimList(claims: Record<string, unknown>, name: string): string[] {
  const v = claims[name];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" ? [v] : [];
}

/** email_verified is true (some providers send the string "true"). */
export function emailVerified(claims: Record<string, unknown>): boolean {
  return claims.email_verified === true || claims.email_verified === "true";
}
