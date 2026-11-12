/** Document intelligence: title-block extraction per version and specification submittal registers. */
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AntetResult, ExtractionStatus, RevisionInfo, RevisionWarning, SubmittalRegisterItem } from "@sitekeep/shared";
import { fileVersions, projects, users } from "./schema.js";

/** One row per PDF version: what was read from its first page. */
export const docExtractions = pgTable(
  "doc_extractions",
  {
    versionId: uuid("version_id")
      .primaryKey()
      .references(() => fileVersions.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status").$type<ExtractionStatus>().notNull().default("pending"),
    error: text("error"),
    antet: jsonb("antet").$type<AntetResult>(),
    revision: jsonb("revision").$type<RevisionInfo>(),
    /** Revision recorded for this version (detected, else the attribute at extraction time). */
    effectiveRevision: text("effective_revision"),
    warnings: jsonb("warnings").$type<RevisionWarning[]>().notNull().default([]),
    pageCount: integer("page_count"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("doc_extractions_project_idx").on(t.projectId)],
);

/** Draft submittal register built from a specification PDF version. */
export const specRegisters = pgTable(
  "spec_registers",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .unique()
      .references(() => fileVersions.id, { onDelete: "cascade" }),
    items: jsonb("items").$type<SubmittalRegisterItem[]>().notNull().default([]),
    sectionCount: integer("section_count").notNull().default(0),
    pageCount: integer("page_count").notNull().default(0),
    usedAi: boolean("used_ai").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("spec_registers_project_idx").on(t.projectId)],
);
