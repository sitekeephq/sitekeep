/**
 * ISO 19650-2 §5.8.1 close-out archives (docs/features/CLOSEOUT_ARCHIVE.md): one row per archive
 * a project administrator asked for. The ZIP itself is kept in the storage under DATA_DIR until
 * `expires_at`, then deleted (the row stays, status "expired"). Re-exported from schema.ts;
 * references to core tables are lazy so the circular import is safe.
 */
import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AuditVerifyDto, CloseoutOptions, CloseoutStatus } from "@sitekeep/shared";
import { projects, users } from "./schema.js";

export const closeoutArchives = pgTable(
  "closeout_archives",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status").$type<CloseoutStatus>().notNull().default("queued"),
    options: jsonb("options").$type<CloseoutOptions>().notNull(),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    jobId: uuid("job_id"),
    filesTotal: integer("files_total").notNull().default(0),
    filesDone: integer("files_done").notNull().default(0),
    bytesTotal: bigint("bytes_total", { mode: "number" }).notNull().default(0),
    bytesDone: bigint("bytes_done", { mode: "number" }).notNull().default(0),
    /** The ZIP in the storage (done). */
    storageKey: text("storage_key"),
    size: bigint("size", { mode: "number" }),
    sha256: text("sha256"),
    /** Audit chain check when the archive was built (head hash). */
    auditChain: jsonb("audit_chain").$type<Pick<AuditVerifyDto, "ok" | "checked" | "head" | "broken">>(),
    /** Versions missing from the storage or not matching their stored SHA-256. */
    problems: integer("problems").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [index("closeout_archives_project_idx").on(t.projectId, t.createdAt)],
);
