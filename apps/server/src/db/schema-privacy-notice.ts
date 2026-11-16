import { integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./schema.js";

/**
 * Acceptances of the privacy notice on the sign-in and invitation pages
 * (docs/features/PRIVACY_NOTICE.md): who ticked "I have read it" for which version of the text, when
 * and on which page. One row per person and version; written once, never changed (migration 0057).
 */
export const privacyNoticeAcceptances = pgTable(
  "privacy_notice_acceptances",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    /** "password", "google", "invitation", "invitation_google". */
    via: text("via").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.version] })],
);
