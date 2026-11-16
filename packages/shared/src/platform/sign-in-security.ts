/**
 * Administration → Sign-in security (docs/features/SIGN_IN_SECURITY.md): failed sign-in limits,
 * session lifetimes and who must use two-factor authentication.
 */

/** Who must use two-factor authentication (TOTP) to sign in. */
export type TwoFactorRequirement = "off" | "admins" | "all";

export interface SignInSecuritySettings {
  /** Failed attempts per account (e-mail address) in the window before it is locked. */
  failureLimit: number;
  /** Failed attempts per client IP address in the window before it is locked (a whole office may share one). */
  ipFailureLimit: number;
  /** Length of the sliding window, minutes; a lock ends when the oldest failure leaves it. */
  failureWindowMinutes: number;
  /** A browser session ends this many days after sign-in, however active (absolute timeout). */
  sessionAbsoluteDays: number;
  /** A browser session ends after this many hours without a request (idle timeout); 0 = off. */
  sessionIdleHours: number;
  /** "admins": system administrators; "all": everyone. They enrol at their next sign-in. */
  requireTwoFactor: TwoFactorRequirement;
}

export const SIGN_IN_SECURITY_DEFAULTS: SignInSecuritySettings = {
  failureLimit: 10,
  ipFailureLimit: 50,
  failureWindowMinutes: 15,
  sessionAbsoluteDays: 14,
  sessionIdleHours: 12,
  requireTwoFactor: "off",
};

/** Allowed range of each number (inclusive). */
export const SIGN_IN_SECURITY_LIMITS = {
  failureLimit: [3, 100],
  ipFailureLimit: [10, 1000],
  failureWindowMinutes: [1, 1440],
  sessionAbsoluteDays: [1, 90],
  sessionIdleHours: [0, 720],
} as const satisfies Record<Exclude<keyof SignInSecuritySettings, "requireTwoFactor">, readonly [number, number]>;

export const TWO_FACTOR_REQUIREMENTS: readonly TwoFactorRequirement[] = ["off", "admins", "all"];

/** Stored (possibly partial or out-of-range) settings → complete settings within the limits. */
export function normalizeSignInSecurity(stored: Partial<SignInSecuritySettings> | null | undefined): SignInSecuritySettings {
  const out: SignInSecuritySettings = { ...SIGN_IN_SECURITY_DEFAULTS };
  for (const [key, [min, max]] of Object.entries(SIGN_IN_SECURITY_LIMITS) as [keyof typeof SIGN_IN_SECURITY_LIMITS, readonly [number, number]][]) {
    const v = stored?.[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = Math.min(max, Math.max(min, Math.round(v)));
  }
  if (stored?.requireTwoFactor && TWO_FACTOR_REQUIREMENTS.includes(stored.requireTwoFactor)) out.requireTwoFactor = stored.requireTwoFactor;
  return out;
}

/** The answer of POST /auth/login (and the other first steps) when a second step is needed. */
export interface TwoFactorChallengeDto {
  /** "verify": enter a code from the app; "enrol": two-factor is required and not set up yet. */
  twoFactor: "verify" | "enrol";
}

/** A new authenticator secret: the QR code (an SVG data URL, made on the server) and the same secret as text. */
export interface TwoFactorSetupDto {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

/** GET /auth/two-factor */
export interface TwoFactorStatusDto {
  enabled: boolean;
  /** Required for this account by the administrator (it cannot be turned off). */
  required: boolean;
  recoveryCodesLeft: number;
  enabledAt: string | null;
}

/** One browser session of the signed-in user (GET /auth/sessions). */
export interface SessionDto {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  current: boolean;
}
