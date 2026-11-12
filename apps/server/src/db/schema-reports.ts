import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ReportQueryRef, ReportSharing } from "@sitekeep/shared";
import { projects, users } from "./schema.js";

/** Personal report dashboards: AI- or user-authored HTML plus the queries feeding it. */
export const dashboards = pgTable(
  "dashboards",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    description: text("description"),
    queries: jsonb("queries").$type<ReportQueryRef[]>().notNull().default([]),
    /** Dashboard HTML (≤ 500 KB), rendered in a sandboxed iframe. */
    html: text("html").notNull(),
    sharing: text("sharing").$type<ReportSharing>().notNull().default("private"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dashboards_project_idx").on(t.projectId, t.ownerId)],
);

/** Every saved state of a dashboard (version 1 = as created). */
export const dashboardVersions = pgTable(
  "dashboard_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    dashboardId: uuid("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    queries: jsonb("queries").$type<ReportQueryRef[]>().notNull(),
    html: text("html").notNull(),
    sharing: text("sharing").$type<ReportSharing>().notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("dashboard_versions_unique").on(t.dashboardId, t.version)],
);

/**
 * Data change stamps for live report refresh: one counter per project and scope (works, files,
 * forms …). Statement-level triggers (migration 0020) bump it on every INSERT / UPDATE / DELETE of
 * the scope's tables, whatever wrote the rows (REST, MCP, jobs, imports). Reads never touch it.
 * No foreign key: a deleted project's rows are harmless and cleaned up with the project's data.
 */
export const reportChangeStamps = pgTable(
  "report_change_stamps",
  {
    projectId: uuid("project_id").notNull(),
    scope: text("scope").notNull(),
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.scope] })],
);
