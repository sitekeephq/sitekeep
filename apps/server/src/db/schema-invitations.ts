import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies, projects, users } from "./schema.js";

/**
 * Invitations of people without an account (docs/features/INVITATIONS.md). The invited person is a
 * pending user (users.pending) who is already a member of the project with the chosen company,
 * roles and task team; accepting the invitation activates the account. Only the SHA-256 of the
 * token is stored; a token is single-use and expires (14 days). Resending replaces the token.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** The pending user the invitation activates. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    /** Language of the e-mail and of the new account ("en", "tr"). */
    language: text("language").notNull(),
    /** What the invitation gave in the project (shown in the list; the membership is written at once). */
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    roleIds: uuid("role_ids").array().notNull().default(sql`'{}'::uuid[]`),
    isProjectAdmin: boolean("is_project_admin").notNull().default(false),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Last time the invitation e-mail was sent (null: the link was handed to the inviter). */
    mailedAt: timestamp("mailed_at", { withTimezone: true }),
    /** Times the invitation was issued (1 + resends). */
    sendCount: integer("send_count").notNull().default(1),
  },
  (t) => [index("invitations_project_idx").on(t.projectId, t.createdAt), index("invitations_user_idx").on(t.userId)],
);
