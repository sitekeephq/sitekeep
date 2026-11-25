/** Tables for Docs depth (Sprint B): typed attribute definitions and their folder bindings. */
import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { AttributeType, DocSearchParams, SavedSearchShareSubject } from "@sitekeep/shared";
import { folders, projects, users } from "./schema.js";

export const attributeDefinitions = pgTable(
  "attribute_definitions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").$type<AttributeType>().notNull(),
    /** Allowed values of a list attribute, in display order. */
    options: jsonb("options").$type<string[]>().notNull().default([]),
    required: boolean("required").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("attribute_definitions_name").on(t.projectId, t.name)],
);

/** A definition bound to a folder applies to the folder and every subfolder. */
export const folderAttributeBindings = pgTable(
  "folder_attribute_bindings",
  {
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => attributeDefinitions.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.folderId, t.definitionId] }), index("folder_attribute_bindings_def_idx").on(t.definitionId)],
);

/**
 * Saved document searches (docs/features/DOCUMENT_SEARCH.md): personal by default; a project
 * administrator shares one with people, companies or the whole project. Only the search
 * parameters are stored: whoever runs it sees what their own permissions allow.
 */
export const savedSearches = pgTable(
  "saved_searches",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    params: jsonb("params").$type<DocSearchParams>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("saved_searches_project_idx").on(t.projectId, t.ownerId)],
);

/** Who a saved search is shared with: a user, a company or the project (subject_id = project id). */
export const savedSearchShares = pgTable(
  "saved_search_shares",
  {
    searchId: uuid("search_id")
      .notNull()
      .references(() => savedSearches.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").$type<SavedSearchShareSubject>().notNull(),
    subjectId: uuid("subject_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.searchId, t.subjectType, t.subjectId] }), index("saved_search_shares_subject_idx").on(t.subjectType, t.subjectId)],
);
