/** In-browser viewers: preview derivatives per version (office PDF, sheet JSON, DXF) and extracted text. */
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { PreviewKind, PreviewMeta, PreviewStatus } from "@sitekeep/shared";
import { fileVersions, projects } from "./schema.js";

/**
 * One row per version and preview kind. Kept apart from file_versions.derivative_* (the IFC →
 * Fragments derivative) so both can exist and evolve separately.
 */
export const versionPreviews = pgTable(
  "version_previews",
  {
    versionId: uuid("version_id")
      .notNull()
      .references(() => fileVersions.id, { onDelete: "cascade" }),
    kind: text("kind").$type<PreviewKind>().notNull(),
    status: text("status").$type<PreviewStatus>().notNull().default("pending"),
    /** Stored derivative (null for text-only previews and DXF originals). */
    storageKey: text("storage_key"),
    error: text("error"),
    meta: jsonb("meta").$type<PreviewMeta>().notNull().default({}),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.versionId, t.kind] })],
);

/** Plain text of a version for search and the "Sor" assistant (office, sheets, drawings, PDF, text). */
export const versionTexts = pgTable(
  "version_texts",
  {
    versionId: uuid("version_id")
      .primaryKey()
      .references(() => fileVersions.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Where the text came from: "office", "sheet", "cad", "pdf", "text". */
    source: text("source").notNull(),
    content: text("content").notNull(),
    truncated: boolean("truncated").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("version_texts_project_idx").on(t.projectId)],
);
