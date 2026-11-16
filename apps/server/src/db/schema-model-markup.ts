/**
 * Model markups (FP-3, docs/features/MODEL_MARKUP.md): pins and drawings on an IFC model view,
 * stored with a BCF-style viewpoint, and their comment threads.
 */
import { sql } from "drizzle-orm";
import { type AnyPgColumn, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type {
  IssueViewpoint,
  MarkupShape,
  ModelMarkupAnchor,
  ModelMarkupKind,
  ModelMarkupStatus,
  ModelMarkupVisibility,
} from "@sitekeep/shared";
import { fileVersions, files, issues, projects, users } from "./schema.js";

export const modelMarkups = pgTable(
  "model_markups",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The file and version the markup belongs to (permissions and "from an older version"). */
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => fileVersions.id, { onDelete: "cascade" }),
    /** Every model version of the view (also viewpoint.fileVersionIds). */
    versionIds: jsonb("version_ids").$type<string[]>().notNull(),
    kind: text("kind").$type<ModelMarkupKind>().notNull(),
    title: text("title").notNull().default(""),
    color: text("color").notNull(),
    status: text("status").$type<ModelMarkupStatus>().notNull().default("open"),
    visibility: text("visibility").$type<ModelMarkupVisibility>().notNull().default("private"),
    /** Same shape as issues.viewpoint; the snapshot has the drawing burnt in. */
    viewpoint: jsonb("viewpoint").$type<IssueViewpoint>().notNull(),
    anchor: jsonb("anchor").$type<ModelMarkupAnchor>(),
    /** Drawing in view units (packages/shared model-markup.ts). */
    shapes: jsonb("shapes").$type<MarkupShape[]>().notNull().default(sql`'[]'::jsonb`),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    /** Issue created from the markup. */
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    carriedFromId: uuid("carried_from_id").references((): AnyPgColumn => modelMarkups.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("model_markups_file_idx").on(t.projectId, t.fileId),
    index("model_markups_version_idx").on(t.versionId),
    index("model_markups_carried_idx").on(t.carriedFromId),
  ],
);

export const modelMarkupComments = pgTable(
  "model_markup_comments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    markupId: uuid("markup_id")
      .notNull()
      .references(() => modelMarkups.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("model_markup_comments_markup_idx").on(t.markupId, t.createdAt)],
);
