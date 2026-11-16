/**
 * Sign-in with OpenID Connect (docs/features/OIDC_SIGN_IN.md): providers a system administrator adds
 * under Administration → Sign-in Security (Entra ID, Keycloak, Okta, Google Workspace, Authentik …).
 * Each provider is its own outbound connection "oidc:<id>" in the Privacy Centre.
 */
import { emailMatchesGoogleDomains, normalizeGoogleDomain } from "./google-auth.js";

/** A provider as the administrator sees it (the client secret is never sent back). */
export interface OidcProviderDto {
  /** Short id in the URLs and the connection id ("entra" → /api/v1/auth/oidc/entra/start, "oidc:entra"). */
  id: string;
  /** Shown in the Privacy Centre and the audit log ("Contoso Entra ID"). */
  name: string;
  enabled: boolean;
  /** Issuer URL; discovery is read from <issuer>/.well-known/openid-configuration. */
  issuer: string;
  clientId: string;
  /** A client secret is stored (encrypted). */
  hasClientSecret: boolean;
  /** Space-separated; "openid" is always sent. */
  scopes: string;
  /** Text of the sign-in button ("Sign in with Contoso"). */
  buttonLabel: string;
  /** Colour of the button's icon, #rrggbb. */
  buttonColor: string;
  /** Only addresses in these domains (and their subdomains) may sign in; empty = any domain. */
  allowedDomains: string[];
  /** Create an account at the first sign-in (off: only existing and invited users). */
  createAccounts: boolean;
  /** Company of accounts created at sign-in. */
  defaultCompanyId: string | null;
  /** Claim with the e-mail address (default "email"). */
  emailClaim: string;
  /** Claim with the display name (default "name"). */
  nameClaim: string;
  /** Accept addresses the provider has not marked as verified (email_verified). Off by default. */
  trustUnverifiedEmail: boolean;
  /** Skip SiteKeep's own two-factor step when the provider asserts multi-factor sign-in (amr). Off by default. */
  trustProviderMfa: boolean;
  /** Claim with the user's groups (default "groups"). */
  groupsClaim: string;
  /** Members of this group become system administrators at sign-in; null = off (default). */
  adminGroup: string | null;
  /** Address to register at the provider as the redirect URI. */
  redirectUri: string;
}

/** POST / PUT body: the DTO without the computed fields; clientSecret undefined keeps the stored one. */
export type OidcProviderInput = Omit<OidcProviderDto, "hasClientSecret" | "redirectUri"> & { clientSecret?: string | null };

/** A button on the sign-in page (GET /auth/methods). */
export interface OidcButtonDto {
  id: string;
  label: string;
  color: string;
}

export const OIDC_DEFAULTS = {
  enabled: true,
  scopes: "openid email profile",
  buttonColor: "#2563eb",
  allowedDomains: [] as string[],
  createAccounts: false,
  defaultCompanyId: null as string | null,
  emailClaim: "email",
  nameClaim: "name",
  trustUnverifiedEmail: false,
  trustProviderMfa: false,
  groupsClaim: "groups",
  adminGroup: null as string | null,
};

export const OIDC_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const CLAIM = /^[A-Za-z0-9_:./-]{1,100}$/;
const COLOR = /^#[0-9a-f]{6}$/i;

/** "https://login.example.com/realms/x/" → "https://login.example.com/realms/x"; null when not a usable issuer. */
export function normalizeIssuer(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.search || url.hash || url.username || url.password) return null;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  // Plain http only on this machine (development, tests); everything else must use TLS.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  return url.toString().replace(/\/+$/, "");
}

/** Space-separated scopes with "openid" first, duplicates removed. */
export function normalizeOidcScopes(raw: string): string {
  const seen = new Set<string>(["openid"]);
  for (const s of raw.split(/[\s,]+/)) if (/^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/.test(s)) seen.add(s);
  return [...seen].slice(0, 20).join(" ");
}

export function validOidcClaim(name: string): boolean {
  return CLAIM.test(name);
}

export function validOidcColor(color: string): boolean {
  return COLOR.test(color);
}

/** Domains in lower case without "@", duplicates removed; null when one is not a domain. */
export function normalizeOidcDomains(list: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const raw of list) {
    if (!raw.trim()) continue;
    const d = normalizeGoogleDomain(raw);
    if (!d) return null;
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

/** The address may use this provider (no list = any domain; subdomains match). */
export function emailAllowedForOidc(email: string, domains: readonly string[]): boolean {
  return !domains.length || emailMatchesGoogleDomains(email, domains);
}

/**
 * The provider asserts a multi-factor sign-in (RFC 8176 `amr`): the value "mfa", or two different
 * methods of which one is not just something known ("pwd" + "otp", "hwk" + "pin"; not "pwd" + "kba").
 */
export function amrShowsMfa(amr: unknown): boolean {
  if (!Array.isArray(amr)) return false;
  const values = new Set(amr.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase()));
  const knowledge = new Set(["pwd", "pin", "kba"]);
  return values.has("mfa") || (values.size >= 2 && [...values].some((v) => !knowledge.has(v)));
}
