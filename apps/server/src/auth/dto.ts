import { PROVISION_PASSWORD, type UserPrefs } from "@sitekeep/shared";
import type { users } from "../db/schema.js";

export function toUserDto(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    isAdmin: u.isAdmin,
    companyId: u.companyId,
    mustChangePassword: !!u.prefs?.mustChangePassword,
    language: u.prefs?.language ?? null,
  };
}

export function prefsForPassword(prefs: UserPrefs | null | undefined, password: string): UserPrefs {
  const next: UserPrefs = { ...(prefs ?? {}) };
  if (password === PROVISION_PASSWORD) next.mustChangePassword = true;
  else delete next.mustChangePassword;
  return next;
}
