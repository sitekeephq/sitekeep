/**
 * OAuth2 authorization server for OpenCDE clients (Foundation API 1.1): scopes, client types and
 * the DTOs of the admin page ("OAuth Uygulamaları"), the consent page and "Bağlı Uygulamalar".
 * See docs/features/OPENCDE.md.
 */
import { SHARED_DEFAULT_LANGUAGE, sharedText } from "./i18n.js";

/**
 * - `read` / `write`: the existing /api/v1 with the user's own permissions (write includes read);
 * - `bcf`: the OpenCDE BCF API 3.0 (checked by that API);
 * - `documents`: OpenCDE Documents API 1.0, select, download and upload (what authoring tools
 *   such as AEC Pilot ask for); `documents:read`: select and download only (see opencde-documents.ts).
 */
export const OAUTH_SCOPES = ["bcf", "documents", "documents:read", "read", "write"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export const OAUTH_SCOPE_LABELS_TR: Record<OAuthScope, string> = {
  bcf: "BCF Sorunları",
  documents: "OpenCDE Dokümanları",
  "documents:read": "OpenCDE Doküman Okuma",
  read: "Okuma",
  write: "Yazma",
};

/** What a scope lets the application do: a sentence on the consent page. */
export function oauthScopeHint(scope: OAuthScope, lang: string = SHARED_DEFAULT_LANGUAGE): string {
  return sharedText(lang, `oauth.scopeHints.${scope === "documents:read" ? "documentsRead" : scope}`);
}

export type OAuthClientType = "public" | "confidential";

export const OAUTH_CLIENT_TYPE_LABELS_TR: Record<OAuthClientType, string> = {
  public: "Açık İstemci",
  confidential: "Gizli İstemci",
};

/** Who a client type is for (admin page, new application). */
export function oauthClientTypeHint(type: OAuthClientType, lang: string = SHARED_DEFAULT_LANGUAGE): string {
  return sharedText(lang, `oauth.clientTypeHints.${type}`);
}

/** Space-separated scope parameter (RFC 6749 §3.3) → distinct values in request order. */
export function parseOAuthScopes(value: string | null | undefined): string[] {
  return [...new Set((value ?? "").split(/\s+/).filter(Boolean))];
}

/** Known scopes only, in the fixed OAUTH_SCOPES order. */
export function normalizeOAuthScopes(scopes: readonly string[]): OAuthScope[] {
  return OAUTH_SCOPES.filter((s) => scopes.includes(s));
}

/** Access to the existing /api/v1 that the granted scopes give: write includes read; null = none. */
export function oauthApiAccess(scopes: readonly string[]): "read" | "write" | null {
  if (scopes.includes("write")) return "write";
  if (scopes.includes("read")) return "read";
  return null;
}

/** A registered OAuth client as the admin page sees it (the secret is never returned). */
export interface OAuthClientDto {
  id: string;
  clientId: string;
  name: string;
  description: string | null;
  type: OAuthClientType;
  redirectUris: string[];
  scopes: OAuthScope[];
  enabled: boolean;
  /** Confidential clients: when the current secret was created. */
  secretSetAt: string | null;
  createdAt: string;
  /** Users who approved the client. */
  userCount: number;
  lastUsedAt: string | null;
}

export interface OAuthClientInput {
  name: string;
  description?: string | null;
  type: OAuthClientType;
  redirectUris: string[];
  scopes: OAuthScope[];
}

export interface OAuthClientPatch {
  name?: string;
  description?: string | null;
  redirectUris?: string[];
  scopes?: OAuthScope[];
  enabled?: boolean;
}

/** Addresses an OpenCDE client needs (Solibri private connection form and others). */
export interface OAuthEndpointsDto {
  /** Root address the user enters in the client; /foundation/versions lives under it. */
  baseUrl: string;
  versionsUrl: string;
  foundationUrl: string;
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  /** True when CDE_PUBLIC_URL is set (otherwise the addresses come from the request host). */
  configured: boolean;
}

/** The consent page: who asks for what. */
export interface OAuthConsentDto {
  client: { clientId: string; name: string; description: string | null; type: OAuthClientType };
  scopes: OAuthScope[];
  redirectUri: string;
  /** Host (or scheme for app links) the browser returns to. */
  redirectTarget: string;
}

/** "Hesabım → Bağlı Uygulamalar". */
export interface ConnectedAppDto {
  /** OAuth client record id (not the public client_id). */
  id: string;
  clientId: string;
  name: string;
  scopes: OAuthScope[];
  consentedAt: string | null;
  lastUsedAt: string | null;
  /** Access or refresh tokens that still work. */
  active: boolean;
}
