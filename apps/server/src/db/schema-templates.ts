/**
 * Project templates: company role slots of a project, where the project came from, and folders
 * that are created only when their first file arrives (virtual children of a real folder).
 */
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { Party, VirtualFolderSpec } from "@sitekeep/shared";
import { companies, folders, projects } from "./schema.js";

/** Company role slots ("Yüklenici", "Müşavir" …) and the company each is mapped to. */
export const projectSlots = pgTable(
  "project_slots",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    party: text("party").$type<Party>(),
    /** Company code used by naming standards ({slot:key}). */
    code: text("code"),
    description: text("description"),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.key] }), index("project_slots_company_idx").on(t.companyId)],
);

/** The template a project was created from. */
export const projectTemplateOrigins = pgTable("project_template_origins", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  /** Built-in template id, or null for an uploaded template JSON. */
  templateId: text("template_id"),
  templateName: text("template_name").notNull(),
  dimensions: jsonb("dimensions").$type<Record<string, string[]>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Children of a folder that are created on demand (first file / materialize). */
export const folderVirtualChildren = pgTable("folder_virtual_children", {
  folderId: uuid("folder_id")
    .primaryKey()
    .references(() => folders.id, { onDelete: "cascade" }),
  children: jsonb("children").$type<VirtualFolderSpec[]>().notNull(),
});
