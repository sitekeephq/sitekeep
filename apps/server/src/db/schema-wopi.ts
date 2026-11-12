/** Browser editing through WOPI (ONLYOFFICE Docs / Collabora Online): access tokens and file locks. */
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { files, projects, users } from "./schema.js";

/** What the user could do when the token was issued (re-checked on every WOPI call). */
export interface WopiPermissionSnapshot {
  level: string;
  canUpload: boolean;
  canDownload: boolean;
}

/**
 * Short-lived WOPI access tokens. Only the SHA-256 of the token is stored. A token is bound to
 * one user, one file and its project; it is never accepted by the /api/v1 session auth.
 */
export const wopiTokens = pgTable(
  "wopi_tokens",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    /** "edit" tokens may save (still re-checked per call); "view" tokens never. */
    mode: text("mode").$type<"edit" | "view">().notNull(),
    permission: jsonb("permission").$type<WopiPermissionSnapshot>().notNull(),
    /** Browser origin of the host page (CheckFileInfo PostMessageOrigin). */
    postMessageOrigin: text("post_message_origin"),
    editor: text("editor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("wopi_tokens_file_idx").on(t.fileId), index("wopi_tokens_expires_idx").on(t.expiresAt)],
);

/** WOPI lock of a file (one per file). A lock older than its expiry counts as no lock. */
export const wopiLocks = pgTable("wopi_locks", {
  fileId: uuid("file_id")
    .primaryKey()
    .references(() => files.id, { onDelete: "cascade" }),
  /** Lock string chosen by the editor (up to 1024 characters). */
  lockId: text("lock_id").notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  editor: text("editor"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** Kept for "X düzenliyor" when the lock was refreshed by someone else. */
  refreshedBy: uuid("refreshed_by").references(() => users.id, { onDelete: "set null" }),
});
