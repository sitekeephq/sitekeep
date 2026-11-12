/** Model coordination (Sprint E): model sets, saved views and IDS reports. Clash tests are the Coordinate module's. */
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type {
  ClashGroupBy,
  ClashRunStats,
  ClashRunStatus,
  ClashSelection,
  ClashStatus,
  ClashType,
  IdsReportStatus,
  IdsSpecResult,
  ModelSetItem,
  ModelSetViewState,
} from "@sitekeep/shared";
import { companies, fileVersions, issues, projects, users } from "./schema.js";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** A saved federation: IFC files (latest or pinned version each). */
export const modelSets = pgTable(
  "model_sets",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    items: jsonb("items").$type<ModelSetItem[]>().notNull().default([]),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("model_sets_name").on(t.projectId, t.name)],
);

/** Saved view of a model set: camera, hidden files and class visibility / colour rules. */
export const modelSetViews = pgTable(
  "model_set_views",
  {
    id: id(),
    modelSetId: uuid("model_set_id")
      .notNull()
      .references(() => modelSets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    state: jsonb("state").$type<ModelSetViewState>().notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("model_set_views_set_idx").on(t.modelSetId)],
);

/** IDS check of one IFC version against one IDS file version. */
export const idsReports = pgTable(
  "ids_reports",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    idsVersionId: uuid("ids_version_id")
      .notNull()
      .references(() => fileVersions.id, { onDelete: "cascade" }),
    ifcVersionId: uuid("ifc_version_id")
      .notNull()
      .references(() => fileVersions.id, { onDelete: "cascade" }),
    status: text("status").$type<IdsReportStatus>().notNull().default("queued"),
    error: text("error"),
    title: text("title"),
    specs: jsonb("specs").$type<IdsSpecResult[]>().notNull().default([]),
    totals: jsonb("totals").$type<{ specs: number; passed: number; failed: number; skipped: number; elementsChecked: number }>(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("ids_reports_project_idx").on(t.projectId, t.createdAt)],
);
