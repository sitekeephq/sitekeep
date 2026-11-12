/** Yönetim → Kullanıcılar → İzinli Alan Adı. Google ile giriş; OpenCDE OAuth değil. */

export interface GoogleAuthSettings {
  /** Kapalıysa (varsayılan) yalnız kayıtlı CDE kullanıcısı girer. */
  domainAllowlistEnabled: boolean;
  /** `@` olmadan, küçük harf. Örn. `7dimensions.eu`. */
  domains: string[];
}

export const GOOGLE_AUTH_DEFAULTS: GoogleAuthSettings = {
  domainAllowlistEnabled: false,
  domains: [],
};

/** `@Ornek-Insaat.com.tr.` → `ornek-insaat.com.tr`. Geçersizse null. */
export function normalizeGoogleDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (value.startsWith("@")) value = value.slice(1);
  value = value.replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(value)) return null;
  return value;
}

export function emailMatchesGoogleDomains(email: string, domains: readonly string[]): boolean {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return false;
  const host = email.slice(at + 1).toLowerCase();
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
