/**
 * Tables the core no longer owns but the SDK still exports for modules built against older SDK
 * versions. They are outside src/db/schema*.ts on purpose: drizzle-kit does not see them, so the
 * core's migrations never create, alter or drop them (the owning module's migrations do).
 */
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ReportQueryRef, ReportSharing } from "@sitekeep/shared";
import { projects, users } from "../db/schema.js";

/** Report dashboards: owned by the Platform module (sitekeep-ee-platform, table "dashboards"). */
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
    html: text("html").notNull(),
    sharing: text("sharing").$type<ReportSharing>().notNull().default("private"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dashboards_project_idx").on(t.projectId, t.ownerId)],
);
