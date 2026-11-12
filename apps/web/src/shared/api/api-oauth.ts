/**
 * OAuth2 server for OpenCDE clients (docs/features/OPENCDE.md): consent page, Hesabım → Bağlı Uygulamalar
 * and Yönetim → OAuth Uygulamaları.
 */
import type {
  ConnectedAppDto,
  OAuthClientDto,
  OAuthClientInput,
  OAuthClientPatch,
  OAuthConsentDto,
  OAuthEndpointsDto,
} from "@sitekeep/shared";
import { request } from "./client";

export const oauthApi = {
  consentInfo: (query: string) => request<OAuthConsentDto>("GET", `/oauth/authorize-info?${query}`),
  decide: (params: Record<string, string>, approve: boolean) =>
    request<{ redirectTo: string }>("POST", "/oauth/consent", { params, approve }),

  connectedApps: () => request<ConnectedAppDto[]>("GET", "/auth/oauth-apps"),
  revokeApp: (id: string) => request<{ ok: true }>("DELETE", `/auth/oauth-apps/${id}`),

  clients: () => request<{ clients: OAuthClientDto[]; endpoints: OAuthEndpointsDto }>("GET", "/admin/oauth-clients"),
  createClient: (input: OAuthClientInput) =>
    request<{ client: OAuthClientDto; clientSecret: string | null }>("POST", "/admin/oauth-clients", input),
  updateClient: (id: string, patch: OAuthClientPatch) => request<OAuthClientDto>("PATCH", `/admin/oauth-clients/${id}`, patch),
  rotateSecret: (id: string) => request<{ client: OAuthClientDto; clientSecret: string }>("POST", `/admin/oauth-clients/${id}/secret`, {}),
  deleteClient: (id: string) => request<{ ok: true }>("DELETE", `/admin/oauth-clients/${id}`),
};

/**
 * The `next` address of /login after an OAuth authorization request: only the server's own
 * /oauth2/authorize on this origin (no open redirect), else null.
 */
export function safeOAuthNext(next: string | null, origin: string): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return null;
  try {
    const u = new URL(next, origin);
    if (u.origin !== origin || u.pathname !== "/oauth2/authorize") return null;
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}
