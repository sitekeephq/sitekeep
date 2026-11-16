import { sql } from "drizzle-orm";
import { bigint, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./schema.js";

/**
 * Two-factor authentication (TOTP, RFC 6238) of a user (docs/features/SIGN_IN_SECURITY.md). The
 * secret is encrypted with the installation's secret key (core/platform/secrets.ts); recovery codes
 * are stored as SHA-256 hashes and removed when used. `enabled_at` is null while the user is still
 * setting it up (the secret was shown, no code confirmed yet).
 */
export const userTwoFactor = pgTable("user_two_factor", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** aesgcm1:… (encryptSecret) of the base32 secret. */
  secret: text("secret").notNull(),
  enabledAt: timestamp("enabled_at", { withTimezone: true }),
  /** The last accepted time step: a code is accepted once (no replay). */
  lastStep: bigint("last_step", { mode: "number" }),
  recoveryCodes: text("recovery_codes").array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
