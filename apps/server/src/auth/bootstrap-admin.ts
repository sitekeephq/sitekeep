import { PROVISION_PASSWORD, type UserPrefs } from "@sitekeep/shared";
import { passwordProblem } from "../core/security/auth.js";
import { msg, type Msg } from "../i18n/index.js";

/**
 * Why ADMIN_PASSWORD cannot start the installation, or null. The temporary provisioning password
 * ("1234567890") is for people an administrator adds with "change at first sign-in"; the first
 * administrator may not use it, nor any password the normal rules refuse (G-5).
 */
export function adminPasswordProblem(password: string, email: string): Msg | null {
  if (password === PROVISION_PASSWORD) return msg("auth:errors.provisionPassword");
  return passwordProblem(password, { email });
}

/**
 * Whether the first administrator must change the password at first sign-in. On unless
 * ADMIN_MUST_CHANGE_PASSWORD is 0 / false / no / off (the installer sets 0 for a password the person chose
 * themselves; development and the e2e suite switch it off).
 */
export function adminMustChangePassword(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(env.ADMIN_MUST_CHANGE_PASSWORD?.trim() ?? "");
}

export function adminPrefs(env: Record<string, string | undefined> = process.env): UserPrefs {
  return adminMustChangePassword(env) ? { mustChangePassword: true } : {};
}
