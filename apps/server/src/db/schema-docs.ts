/** Tables for Docs depth (Sprint B): typed attribute definitions and their folder bindings. */
import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { AttributeType } from "@sitekeep/shared";
import { folders, projects } from "./schema.js";

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
