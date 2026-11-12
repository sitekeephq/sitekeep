import {
  GOOGLE_AUTH_DEFAULTS,
  emailMatchesGoogleDomains,
  normalizeGoogleDomain,
  type GoogleAuthSettings,
} from "@sitekeep/shared";
import { eq } from "drizzle-orm";
import { getSetting, putSetting } from "../ai/settings.js";
import { audit } from "../core/platform/audit.js";
import { hashPassword, newToken } from "../core/security/auth.js";
import type { Db } from "../db/index.js";
import { users } from "../db/schema.js";
import { refreshSeats } from "../license/state.js";

export const GOOGLE_AUTH_SETTINGS_KEY = "auth.google";

export async function getGoogleAuthSettings(db: Db): Promise<GoogleAuthSettings> {
  const stored = await getSetting<Partial<GoogleAuthSettings>>(db, GOOGLE_AUTH_SETTINGS_KEY, {});
  const seen = new Set<string>();
  const domains: string[] = [];
  for (const raw of Array.isArray(stored.domains) ? stored.domains : []) {
    const domain = typeof raw === "string" ? normalizeGoogleDomain(raw) : null;
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }
  return {
    domainAllowlistEnabled: !!stored.domainAllowlistEnabled,
    domains,
  };
}

export async function putGoogleAuthSettings(
  db: Db,
  next: GoogleAuthSettings,
  userId: string | null,
): Promise<GoogleAuthSettings> {
  const value: GoogleAuthSettings = {
    domainAllowlistEnabled: next.domainAllowlistEnabled,
    domains: next.domains,
  };
  await putSetting(db, GOOGLE_AUTH_SETTINGS_KEY, value, userId);
  return value;
}

export function googleDisplayName(email: string, name?: string | null): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed.slice(0, 200);
  const local = email.split("@")[0]?.trim();
  return (local || email).slice(0, 200);
}

/**
 * Existing open user, or a new non-admin user when the allowlist is on and the
 * e-mail domain matches. Disabled accounts stay blocked.
 */
export async function resolveGoogleUser(
  db: Db,
  email: string,
  name: string,
): Promise<{ user: typeof users.$inferSelect; created: boolean } | null> {
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) return existing.disabled ? null : { user: existing, created: false };

  const settings = await getGoogleAuthSettings(db);
  if (!settings.domainAllowlistEnabled || !emailMatchesGoogleDomains(email, settings.domains)) return null;

  try {
    const [created] = await db
      .insert(users)
      .values({
        email,
        name: googleDisplayName(email, name),
        passwordHash: await hashPassword(newToken("secret")),
        isAdmin: false,
      })
      .returning();
    if (!created) return null;
    await refreshSeats(db);
    await audit(db, {
      userId: created.id,
      action: "user.created",
      targetType: "user",
      targetId: created.id,
      details: { provider: "google", domain: email.slice(email.lastIndexOf("@") + 1) },
    });
    return { user: created, created: true };
  } catch {
    const [again] = await db.select().from(users).where(eq(users.email, email));
    return again && !again.disabled ? { user: again, created: false } : null;
  }
}
