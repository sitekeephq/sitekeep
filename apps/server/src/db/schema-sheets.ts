/**
 * Drawing sheets (FP-2, docs/features/SHEETS.md): sheets per page of a drawing version, the
 * project's sheet settings, sheet sets and their published snapshots. Re-exported from schema.ts;
 * references to core tables are lazy so the circular import is safe.
 */
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { CdeState, SheetNumberSource, SheetSetPublicationItem } from "@sitekeep/shared";
import { fileVersions, files, projects, users } from "./schema.js";

/** One row per page of a drawing version (PDF page; DWG/DXF: page 1). */
export const drawingSheets = pgTable(
  "drawing_sheets",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => fileVersions.id, { onDelete: "cascade" }),
    page: integer("page").notNull(),
    pageCount: integer("page_count").notNull().default(1),
    number: text("number").notNull(),
    /** sheetKey(number): links a sheet across versions, files and sets. */
    numberKey: text("number_key").notNull(),
    numberSource: text("number_source").$type<SheetNumberSource>().notNull(),
    title: text("title"),
    discipline: text("discipline"),
    /** Revision read from the title block (the version's revision code wins when shown). */
    revision: text("revision"),
    /** Issue date YYYY-MM-DD from the title block. */
    sheetDate: text("sheet_date"),
    /** Edited by a person: re-extraction keeps number, title and discipline. */
    edited: boolean("edited").notNull().default(false),
    editedBy: uuid("edited_by").references(() => users.id, { onDelete: "set null" }),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("drawing_sheets_version_page").on(t.versionId, t.page),
    index("drawing_sheets_project_key_idx").on(t.projectId, t.numberKey),
    index("drawing_sheets_file_idx").on(t.fileId),
  ],
);

/** Which folders a project scans for sheets; a project without a row uses Shared and Published. */
export const drawingSheetSettings = pgTable("drawing_sheet_settings", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  states: jsonb("states").$type<CdeState[]>().notNull().default(["shared", "published"]),
  folderIds: jsonb("folder_ids").$type<string[]>().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A named collection of sheets ("Tender set", "Construction issue 03"). */
export const sheetSets = pgTable(
  "sheet_sets",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sheet_sets_project_name").on(t.projectId, sql`lower(${t.name})`)],
);

/** Members of a set by sheet number: the set follows the latest sheet with that number. */
export const sheetSetItems = pgTable(
  "sheet_set_items",
  {
    setId: uuid("set_id")
      .notNull()
      .references(() => sheetSets.id, { onDelete: "cascade" }),
    numberKey: text("number_key").notNull(),
    /** The number as it was when added (shown when no sheet carries it any more). */
    number: text("number").notNull(),
    position: integer("position").notNull().default(0),
    addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.setId, t.numberKey] })],
);

/** A published issue of a set: the exact sheet versions it held. */
export const sheetSetPublications = pgTable(
  "sheet_set_publications",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    setId: uuid("set_id")
      .notNull()
      .references(() => sheetSets.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    issue: integer("issue").notNull(),
    note: text("note"),
    items: jsonb("items").$type<SheetSetPublicationItem[]>().notNull().default([]),
    publishedBy: uuid("published_by").references(() => users.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sheet_set_publications_issue").on(t.setId, t.issue)],
);
