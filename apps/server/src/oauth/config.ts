/**
 * OAuth2 / OpenCDE settings. Defaults come from the environment (docs/features/OPENCDE.md):
 *   CDE_PUBLIC_URL        public root address, e.g. https://cde.musteri.local (else the request host)
 *   CDE_OAUTH_AUTH_URL    authorization endpoint advertised by /foundation/1.1/auth (future external IdP)
 *   CDE_OAUTH_TOKEN_URL   token endpoint advertised by /foundation/1.1/auth (future external IdP)
 *   CDE_OPENCDE_APIS      extra OpenCDE APIs to advertise once they exist: "bcf" (comma separated; Documents 1.0 is always on)
 */
import type { FastifyRequest } from "fastify";
import type { OAuthEndpointsDto } from "@sitekeep/shared";

export interface OAuthOptions {
  publicUrl?: string | null;
  authUrl?: string | null;
  tokenUrl?: string | null;
  /** Feature flags of OpenCDE APIs in /foundation/versions (see opencde/apis.ts). */
  apis?: string[];
  accessTokenSeconds?: number;
  refreshTokenDays?: number;
  codeSeconds?: number;
  /** Failed /oauth2/token requests per client IP and window before 429. */
  tokenFailureLimit?: number;
  tokenFailureWindowMs?: number;
}

export interface ResolvedOAuthOptions {
  publicUrl: string | null;
  authUrl: string | null;
  tokenUrl: string | null;
  apis: string[];
  accessTokenSeconds: number;
  refreshTokenDays: number;
  codeSeconds: number;
  tokenFailureLimit: number;
  tokenFailureWindowMs: number;
}

/** http(s) URL without a trailing slash, or null when empty or invalid. */
function cleanUrl(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return v.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function resolveOAuthOptions(input: OAuthOptions = {}, env: NodeJS.ProcessEnv = process.env): ResolvedOAuthOptions {
  const pick = <T>(v: T | undefined, fallback: T) => (v === undefined ? fallback : v);
  return {
    publicUrl: cleanUrl(pick(input.publicUrl, env.CDE_PUBLIC_URL)),
    authUrl: cleanUrl(pick(input.authUrl, env.CDE_OAUTH_AUTH_URL)),
    tokenUrl: cleanUrl(pick(input.tokenUrl, env.CDE_OAUTH_TOKEN_URL)),
    apis: input.apis ?? (env.CDE_OPENCDE_APIS ?? "").split(/[\s,]+/).filter(Boolean),
    accessTokenSeconds: input.accessTokenSeconds ?? 3600,
    refreshTokenDays: input.refreshTokenDays ?? 30,
    codeSeconds: input.codeSeconds ?? 60,
    tokenFailureLimit: input.tokenFailureLimit ?? 20,
    tokenFailureWindowMs: input.tokenFailureWindowMs ?? 10 * 60_000,
  };
}

/** Root address for absolute URLs: CDE_PUBLIC_URL, else the address the request came to. */
export function publicBaseUrl(opts: ResolvedOAuthOptions, req: FastifyRequest): string {
  if (opts.publicUrl) return opts.publicUrl;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim();
  const proto = first(req.headers["x-forwarded-proto"]) || req.protocol;
  const host = first(req.headers["x-forwarded-host"]) || req.headers.host || "localhost";
  return `${proto === "https" ? "https" : "http"}://${host}`;
}

export function oauthEndpoints(opts: ResolvedOAuthOptions, req: FastifyRequest): OAuthEndpointsDto {
  const base = publicBaseUrl(opts, req);
  return {
    baseUrl: base,
    versionsUrl: `${base}/foundation/versions`,
    foundationUrl: `${base}/foundation/1.1`,
    authUrl: opts.authUrl ?? `${base}/oauth2/authorize`,
    tokenUrl: opts.tokenUrl ?? `${base}/oauth2/token`,
    revokeUrl: `${base}/oauth2/revoke`,
    configured: !!opts.publicUrl,
  };
}
