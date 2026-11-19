/**
 * Full project export and restore (docs/features/PROJECT_EXPORT.md). `project_exports`: one row per
 * export a project administrator asked for; the ZIP is kept in the storage under DATA_DIR until
 * `expires_at` (the close-out limits apply), then deleted (status "expired"). `project_imports`: one
 * row per uploaded package a system administrator restores as a new project. Re-exported from
 * schema.ts; references to core tables are lazy so the circular import is safe.
 */
import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ProjectExportCounts, ProjectExportScope, ProjectImportReport, ProjectTransferStatus } from "@sitekeep/shared";
import { projects, users } from "./schema.js";

export const projectExports = pgTable(
  "project_exports",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status").$type<ProjectTransferStatus>().notNull().default("queued"),
    scope: text("scope").$type<ProjectExportScope>().notNull(),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    jobId: uuid("job_id"),
    filesTotal: integer("files_total").notNull().default(0),
    filesDone: integer("files_done").notNull().default(0),
    bytesTotal: bigint("bytes_total", { mode: "number" }).notNull().default(0),
    bytesDone: bigint("bytes_done", { mode: "number" }).notNull().default(0),
    counts: jsonb("counts").$type<ProjectExportCounts>(),
    storageKey: text("storage_key"),
    size: bigint("size", { mode: "number" }),
    sha256: text("sha256"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [index("project_exports_project_idx").on(t.projectId, t.createdAt)],
);

export const projectImports = pgTable(
  "project_imports",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    status: text("status").$type<ProjectTransferStatus>().notNull().default("queued"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    jobId: uuid("job_id"),
    fileName: text("file_name"),
    /** The uploaded package in the storage; removed when the restore ends. */
    uploadKey: text("upload_key"),
    size: bigint("size", { mode: "number" }),
    sha256: text("sha256"),
    /** Code and name of the new project (name null = the package's). */
    code: text("code").notNull(),
    name: text("name"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    phase: text("phase").$type<"verify" | "import">(),
    filesTotal: integer("files_total").notNull().default(0),
    filesDone: integer("files_done").notNull().default(0),
    report: jsonb("report").$type<ProjectImportReport>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("project_imports_created_idx").on(t.createdAt)],
);
