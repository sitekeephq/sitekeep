/** OpenID Connect sign-in providers (docs/features/OIDC_SIGN_IN.md): Administration → Sign-in Security. */
import type { OidcProviderDto, OidcProviderInput } from "@sitekeep/shared";
import { del, get, post, put } from "./client";

export interface OidcTestResult {
  ok: true;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string | null;
  algorithms: string[];
}

export const oidcApi = {
  list: () => get<OidcProviderDto[]>("/admin/oidc-providers"),
  create: (p: OidcProviderInput) => post<OidcProviderDto[]>("/admin/oidc-providers", p),
  update: (id: string, p: OidcProviderInput) => put<OidcProviderDto[]>(`/admin/oidc-providers/${encodeURIComponent(id)}`, p),
  remove: (id: string) => del<OidcProviderDto[]>(`/admin/oidc-providers/${encodeURIComponent(id)}`),
  test: (id: string) => post<OidcTestResult>(`/admin/oidc-providers/${encodeURIComponent(id)}/test`),
};
