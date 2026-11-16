import { sql } from "drizzle-orm";
import { bigint, bigserial, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Truncations of the audit log by its retention period (docs/features/AUDIT_LOG.md#retention-and-truncation):
 * one row per run of the daily job that deleted the oldest rows. The new first chained row points to
 * `removed_head_hash` (the hash of the last deleted chained row); the chained row `audit.truncated`
 * records the same values, so `audit:verify` can start the chain there. Append-only (migration 0054).
 */
export const auditTruncations = pgTable("audit_truncation", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  userId: uuid("user_id"),
  /** Rows written before this time were deleted. */
  before: timestamp("before", { withTimezone: true }).notNull(),
  retentionYears: integer("retention_years").notNull(),
  removedRows: integer("removed_rows").notNull(),
  removedPersonal: integer("removed_personal").notNull(),
  /** Deleted id range (rows from before the chain included). */
  removedFromId: bigint("removed_from_id", { mode: "number" }).notNull(),
  removedToId: bigint("removed_to_id", { mode: "number" }).notNull(),
  /** Hash of the last deleted chained row: prev_hash of the new first chained row (null: no chained row went). */
  removedHeadHash: text("removed_head_hash"),
  /** First chained row after the truncation. */
  newFirstId: bigint("new_first_id", { mode: "number" }).notNull(),
});

/**
 * Disposal record ("imha kaydı", KVKK periodic destruction): what the retention jobs deleted, by
 * category, with counts and the time span of the deleted records, never the records themselves.
 * Append-only. Exported as CSV (Privacy Centre → Retention).
 */
export const disposalLog = pgTable(
  "disposal_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** One run of the daily job (several categories). */
    runId: uuid("run_id").notNull(),
    /** "trash_files", "audit_log", "sessions", … (DisposalCategory). */
    category: text("category").notNull(),
    count: integer("count").notNull(),
    /** Time span of the deleted records (their time, deletion or expiry), when known. */
    oldest: timestamp("oldest", { withTimezone: true }),
    newest: timestamp("newest", { withTimezone: true }),
    /** The rule that applied, e.g. "trashPurgeDays=90", "expired". */
    basis: text("basis").notNull(),
    /** "delete" (rows removed) or "delete+storage" (rows and stored files removed). */
    method: text("method").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (t) => [index("disposal_log_at_idx").on(t.at)],
);
