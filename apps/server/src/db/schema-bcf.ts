/**
 * BCF (docs/features/BCF.md): viewpoints after an issue's first one and related topics. The first viewpoint
 * stays in issues.viewpoint, so every screen that shows one viewpoint keeps working.
 */
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { IssueViewpoint } from "@sitekeep/shared";
import { issues, users } from "./schema.js";

/** Further viewpoints of an issue (BCF topics may have several), in BCF index order. */
export const issueViewpoints = pgTable(
  "issue_viewpoints",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    /** BCF viewpoint GUID (also viewpoint.guid). */
    guid: text("guid").notNull(),
    /** Sort order after the primary viewpoint (1, 2, …). */
    idx: integer("idx").notNull().default(1),
    /** Same shape as issues.viewpoint, snapshot (data URL) included. */
    viewpoint: jsonb("viewpoint").$type<IssueViewpoint>().notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("issue_viewpoints_guid").on(t.issueId, t.guid), index("issue_viewpoints_issue_idx").on(t.issueId, t.idx)],
);

/**
 * BCF related topics, by topic GUID: the related topic may not be in this project (yet); the GUID
 * resolves to an issue through issues.guid when it is.
 */
export const issueRelatedTopics = pgTable(
  "issue_related_topics",
  {
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    relatedGuid: text("related_guid").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.relatedGuid] })],
);
