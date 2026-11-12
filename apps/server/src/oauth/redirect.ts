/**
 * Redirect URI rules of the OAuth server: exact match, except loopback http URIs of desktop
 * clients, which match on any port (RFC 8252 §7.3). No open redirects: an unregistered URI is
 * never redirected to.
 */

import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function parse(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

/** http://127.0.0.1, http://localhost or http://[::1] (any port). */
export function isLoopbackUri(u: URL): boolean {
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
}

/**
 * Why a redirect URI cannot be registered, or null. Allowed: https, loopback http (desktop
 * clients) and private-use schemes in reverse domain form such as com.example.app:/callback
 * (RFC 8252 §7.1). No fragments, no user info.
 */
export function redirectUriProblem(uri: string, lang: string = DEFAULT_LANGUAGE): string | null {
  const t = tFor(lang);
  if (uri.length > 2000) return t("oauth:errors.redirectTooLong");
  const u = parse(uri);
  if (!u) return t("oauth:errors.redirectInvalid", { uri });
  if (u.hash || uri.includes("#")) return t("oauth:errors.redirectFragment", { uri });
  if (u.username || u.password) return t("oauth:errors.redirectUserInfo", { uri });
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:") {
    return isLoopbackUri(u) ? null : t("oauth:errors.redirectHttpLoopback", { uri });
  }
  const scheme = u.protocol.slice(0, -1);
  if (/^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+$/.test(scheme)) return null;
  return t("oauth:errors.redirectScheme", { uri });
}

/** The requested redirect URI is registered for the client (loopback: any port). */
export function matchRegisteredRedirect(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const want = parse(requested);
  if (!want || !isLoopbackUri(want) || requested.includes("#") || want.username || want.password) return false;
  return registered.some((r) => {
    const reg = parse(r);
    return (
      !!reg &&
      isLoopbackUri(reg) &&
      reg.hostname === want.hostname &&
      reg.pathname === want.pathname &&
      reg.search === want.search
    );
  });
}

/** The redirect URI with parameters added (code, state, error …); undefined values are skipped. */
export function withParams(redirectUri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return u.toString();
}

/** Where the browser returns, for the consent page: host, or the scheme of an app link. */
export function redirectTarget(redirectUri: string): string {
  const u = parse(redirectUri);
  if (!u) return redirectUri;
  if (u.protocol === "http:" || u.protocol === "https:") return isLoopbackUri(u) ? `${u.hostname} (bu bilgisayar)` : u.host;
  return u.protocol.slice(0, -1);
}
