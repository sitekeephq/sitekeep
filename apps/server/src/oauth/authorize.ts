/**
 * Validation of an authorization request (GET /oauth2/authorize and the consent page). Problems
 * with client_id or redirect_uri are shown to the user and never redirected (RFC 6749 §4.1.2.1);
 * all other problems go back to the registered redirect URI with error and state.
 */
import { normalizeOAuthScopes, parseOAuthScopes, type OAuthScope } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { matchRegisteredRedirect, withParams } from "./redirect.js";
import { findClient, PKCE_VALUE, type OAuthClientRow } from "./service.js";
import { msg, type Msg } from "../i18n/index.js";

export interface AuthorizeRequest {
  client: OAuthClientRow;
  redirectUri: string;
  scopes: OAuthScope[];
  state: string | null;
  codeChallenge: string | null;
  prompt: string | null;
}

export type AuthorizeCheck =
  | { ok: true; request: AuthorizeRequest }
  /** Shown to the user; the client is unknown or the redirect URI is not trusted. */
  | { ok: false; redirectTo: null; message: Msg }
  /** Sent back to the client (error_description is ASCII, RFC 6749 §4.1.2.1). */
  | { ok: false; redirectTo: string; error: string; message: string };

const PARAMS = [
  "client_id",
  "redirect_uri",
  "redirect_url",
  "response_type",
  "state",
  "scope",
  "code_challenge",
  "code_challenge_method",
  "prompt",
] as const;

export async function checkAuthorizeRequest(db: Db, raw: Record<string, unknown>): Promise<AuthorizeCheck> {
  const one = (k: string) => {
    const v = raw[k];
    return typeof v === "string" ? v : undefined;
  };
  const page = (message: Msg): AuthorizeCheck => ({ ok: false, redirectTo: null, message });

  const clientId = one("client_id");
  if (Array.isArray(raw.client_id) || !clientId) return page(msg("oauth:errors.clientIdMissing"));
  const client = await findClient(db, clientId);
  if (!client) return page(msg("oauth:errors.clientNotRegistered"));
  if (!client.enabled) return page(msg("oauth:errors.clientDisabled", { name: client.name }));

  if (Array.isArray(raw.redirect_uri) || Array.isArray(raw.redirect_url)) return page(msg("oauth:errors.redirectRepeated"));
  const uri = one("redirect_uri");
  const url = one("redirect_url");
  if (uri && url && uri !== url) return page(msg("oauth:errors.redirectMismatch"));
  // The bSI example calls it redirect_url; it may be omitted when only one address is registered.
  let redirectUri = uri || url;
  if (!redirectUri) {
    if (client.redirectUris.length !== 1) return page(msg("oauth:errors.redirectMissing"));
    redirectUri = client.redirectUris[0]!;
  }
  if (!matchRegisteredRedirect(client.redirectUris, redirectUri))
    return page(msg("oauth:errors.redirectNotRegistered"));

  // From here on, errors are returned to the (trusted) redirect URI.
  const state = one("state") ?? null;
  const back = (error: string, description: string): AuthorizeCheck => ({
    ok: false,
    error,
    message: description,
    redirectTo: withParams(redirectUri, { error, error_description: description, state }),
  });

  const repeated = PARAMS.find((k) => Array.isArray(raw[k]));
  if (repeated) return back("invalid_request", `Parameter ${repeated} was sent more than once.`);
  if (state !== null && (state.length > 2048 || /[\u0000-\u001f]/.test(state))) return back("invalid_request", "Invalid state parameter.");
  if (one("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");

  const requested = normalizeOAuthScopes(parseOAuthScopes(one("scope")));
  const denied = requested.filter((s) => !client.scopes.includes(s));
  if (denied.length) return back("invalid_scope", `Scope not allowed for this client: ${denied.join(" ")}.`);
  // No (known) scope asked: everything the client is registered for.
  const scopes = requested.length ? requested : normalizeOAuthScopes(client.scopes);
  if (!scopes.length) return back("invalid_scope", "The client has no scopes.");

  const challenge = one("code_challenge") ?? null;
  const method = one("code_challenge_method");
  if (challenge) {
    if (method !== "S256") return back("invalid_request", "Only code_challenge_method=S256 is supported.");
    if (!PKCE_VALUE.test(challenge)) return back("invalid_request", "Invalid code_challenge.");
  } else {
    if (method) return back("invalid_request", "code_challenge_method without code_challenge.");
    if (client.type === "public") return back("invalid_request", "PKCE (code_challenge with S256) is required for public clients.");
    // Without PKCE the client relies on state against CSRF.
    if (!state) return back("invalid_request", "state is required when PKCE is not used.");
  }

  const prompt = one("prompt") ?? null;
  return { ok: true, request: { client, redirectUri, scopes, state, codeChallenge: challenge, prompt } };
}

/** Normalised parameters for the consent page (checked again when the user decides). */
export function consentParams(r: AuthorizeRequest): Record<string, string> {
  const p: Record<string, string> = {
    client_id: r.client.clientId,
    redirect_uri: r.redirectUri,
    response_type: "code",
    scope: r.scopes.join(" "),
  };
  if (r.state !== null) p.state = r.state;
  if (r.codeChallenge) {
    p.code_challenge = r.codeChallenge;
    p.code_challenge_method = "S256";
  }
  return p;
}
