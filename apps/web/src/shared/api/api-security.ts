/** Sign-in security (docs/features/SIGN_IN_SECURITY.md): two-factor, sessions, the administrator's settings. */
import type {
  SessionDto,
  SignInSecuritySettings,
  TwoFactorChallengeDto,
  TwoFactorSetupDto,
  TwoFactorStatusDto,
  UserDto,
} from "@sitekeep/shared";
import { del, get, post, put } from "./client";

export type SecondFactor = { code: string } | { recoveryCode: string };

/** The answer of a first sign-in step: the user (session started) or the second step. */
export type SignInResult = UserDto | TwoFactorChallengeDto;

export function isChallenge(r: SignInResult): r is TwoFactorChallengeDto {
  return "twoFactor" in r && (r.twoFactor === "verify" || r.twoFactor === "enrol");
}

export const securityApi = {
  // Second step of a sign-in (the server keeps the step in a short cookie).
  challenge: () => get<TwoFactorChallengeDto>("/auth/two-factor/challenge"),
  challengeEnrol: () => post<TwoFactorSetupDto>("/auth/two-factor/challenge/enrol"),
  challengeVerify: (f: SecondFactor) => post<UserDto & { recoveryCodes?: string[] }>("/auth/two-factor/challenge/verify", f),

  // Own account.
  twoFactor: () => get<TwoFactorStatusDto>("/auth/two-factor"),
  setupTwoFactor: () => post<TwoFactorSetupDto>("/auth/two-factor/setup"),
  enableTwoFactor: (code: string) => post<{ recoveryCodes: string[] }>("/auth/two-factor/enable", { code }),
  disableTwoFactor: (f: SecondFactor) => post("/auth/two-factor/disable", f),
  newRecoveryCodes: (f: SecondFactor) => post<{ recoveryCodes: string[] }>("/auth/two-factor/recovery-codes", f),
  sessions: () => get<SessionDto[]>("/auth/sessions"),
  endAllSessions: () => post<{ ended: number }>("/auth/sessions/end-all"),

  // System administrators.
  settings: () => get<SignInSecuritySettings>("/admin/sign-in-security"),
  updateSettings: (s: Partial<SignInSecuritySettings>) => put<SignInSecuritySettings>("/admin/sign-in-security", s),
  unlock: () => post("/admin/sign-in-security/unlock"),
  endUserSessions: (userId: string) => post<{ ended: number }>(`/admin/users/${userId}/sessions/end`),
  resetTwoFactor: (userId: string) => del(`/admin/users/${userId}/two-factor`),
};
