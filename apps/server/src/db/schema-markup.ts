/** PDF markups, issue links and IFC element indexes for version comparison (Sprint B / E). */
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { IssueLinkKind, MarkupShape } from "@sitekeep/shared";
import { fileVersions, issues, users } from "./schema.js";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Markups on one page of a (PDF) file version. Coordinates are PDF user space. */
export const fileMarkups = pgTable(
  "file_markups",
  {
    id: id(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => fileVersions.id, { onDelete: "cascade" }),
    page: integer("page").notNull(),
    shapes: jsonb("shapes").$type<MarkupShape[]>().notNull(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    /** Drafts are visible only to their author. */
    published: boolean("published").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("file_markups_version_idx").on(t.versionId, t.page)],
);

/** Links an issue to a markup or a file version, without touching the issues table. */
export const issueLinks = pgTable(
  "issue_links",
  {
    id: id(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    kind: text("kind").$type<IssueLinkKind>().notNull(),
    targetId: uuid("target_id").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("issue_links_unique").on(t.issueId, t.kind, t.targetId),
    index("issue_links_target_idx").on(t.kind, t.targetId),
  ],
);

/** GlobalId → {class, name, propsHash} index of an IFC version, stored as JSON in storage. */
export const versionIndexes = pgTable("version_indexes", {
  versionId: uuid("version_id")
    .primaryKey()
    .references(() => fileVersions.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull(),
  elementCount: integer("element_count").notNull(),
  createdAt: createdAt(),
});
