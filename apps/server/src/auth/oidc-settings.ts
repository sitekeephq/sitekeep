/**
 * OpenID Connect providers (docs/features/OIDC_SIGN_IN.md), stored in system_settings ("auth.oidc.providers").
 * The client secret is encrypted with the installation's secret key (core/platform/secrets.ts) and never
 * sent back to the browser.
 */
import {
  OIDC_DEFAULTS,
  OIDC_ID,
  normalizeIssuer,
  normalizeOidcDomains,
  normalizeOidcScopes,
  validOidcClaim,
  validOidcColor,
  type OidcProviderDto,
  type OidcProviderInput,
} from "@sitekeep/shared";
import { getSetting, putSetting } from "../ai/settings.js";
import { decryptSecret, encryptSecret } from "../core/platform/secrets.js";
import { badRequest } from "../core/platform/http.js";
import type { Db } from "../db/index.js";
import { msg } from "../i18n/index.js";

export const OIDC_SETTINGS_KEY = "auth.oidc.providers";
export const OIDC_MAX_PROVIDERS = 20;

export type StoredOidcProvider = Omit<OidcProviderDto, "hasClientSecret" | "redirectUri"> & {
  /** aesgcm1:… (encryptSecret); null for public clients (PKCE only). */
  clientSecretEnc: string | null;
};

export async function getOidcProviders(db: Db): Promise<StoredOidcProvider[]> {
  const list = await getSetting<StoredOidcProvider[]>(db, OIDC_SETTINGS_KEY, []);
  return Array.isArray(list) ? list.map((p) => ({ ...OIDC_DEFAULTS, ...p })) : [];
}

export async function getOidcProvider(db: Db, id: string): Promise<StoredOidcProvider | null> {
  return (await getOidcProviders(db)).find((p) => p.id === id) ?? null;
}

export async function putOidcProviders(db: Db, list: StoredOidcProvider[], userId: string | null): Promise<void> {
  await putSetting(db, OIDC_SETTINGS_KEY, list, userId);
}

export function oidcClientSecret(key: Buffer, p: StoredOidcProvider): string | null {
  return p.clientSecretEnc ? decryptSecret(key, p.clientSecretEnc) : null;
}

export function toOidcProviderDto(p: StoredOidcProvider, redirectBase: string): OidcProviderDto {
  const { clientSecretEnc, ...rest } = p;
  return { ...rest, hasClientSecret: !!clientSecretEnc, redirectUri: oidcRedirectUri(redirectBase, p.id) };
}

export function oidcRedirectUri(base: string, id: string): string {
  return `${base.replace(/\/+$/, "")}/api/v1/auth/oidc/${id}/callback`;
}

/**
 * Checks and cleans an administrator's input; `previous` is the stored provider when it is edited
 * (its secret stays unless a new one is given; an empty string removes it).
 */
export function cleanOidcInput(key: Buffer, input: OidcProviderInput, previous: StoredOidcProvider | null): StoredOidcProvider {
  const field = (name: string) => badRequest(msg("auth:errors.oidcField", { field: name }));
  if (!OIDC_ID.test(input.id)) throw field("id");
  const issuer = normalizeIssuer(input.issuer);
  if (!issuer) throw badRequest(msg("auth:errors.oidcIssuer"));
  const allowedDomains = normalizeOidcDomains(input.allowedDomains ?? []);
  if (!allowedDomains) throw field("allowedDomains");
  for (const c of ["emailClaim", "nameClaim", "groupsClaim"] as const) if (!validOidcClaim(input[c])) throw field(c);
  if (!validOidcColor(input.buttonColor)) throw field("buttonColor");
  const adminGroup = input.adminGroup?.trim() || null;
  const clientSecretEnc =
    input.clientSecret === undefined || input.clientSecret === null
      ? (previous?.clientSecretEnc ?? null)
      : input.clientSecret.trim()
        ? encryptSecret(key, input.clientSecret.trim())
        : null;
  return {
    id: input.id,
    name: input.name.trim().slice(0, 100),
    enabled: input.enabled,
    issuer,
    clientId: input.clientId.trim(),
    clientSecretEnc,
    scopes: normalizeOidcScopes(input.scopes),
    buttonLabel: input.buttonLabel.trim().slice(0, 100),
    buttonColor: input.buttonColor.toLowerCase(),
    allowedDomains,
    createAccounts: input.createAccounts,
    defaultCompanyId: input.defaultCompanyId ?? null,
    emailClaim: input.emailClaim,
    nameClaim: input.nameClaim,
    trustUnverifiedEmail: input.trustUnverifiedEmail,
    trustProviderMfa: input.trustProviderMfa,
    groupsClaim: input.groupsClaim,
    adminGroup: adminGroup?.slice(0, 200) ?? null,
  };
}
