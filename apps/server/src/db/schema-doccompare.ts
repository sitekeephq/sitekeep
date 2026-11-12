/** Document revision comparison: cached text diff, change regions and AI summary per version pair. */
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { DocAiStatus, DocCompareResult, DocCompareStatus, PageRegions, SummaryBullet } from "@sitekeep/shared";
import { fileVersions, projects, users } from "./schema.js";

export const docComparisons = pgTable(
  "doc_comparisons",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fromVersionId: uuid("from_version_id")
      .notNull()
      .references(() => fileVersions.id, { onDelete: "cascade" }),
    toVersionId: uuid("to_version_id")
      .notNull()
      .references(() => fileVersions.id, { onDelete: "cascade" }),
    /** Text diff (server side). */
    status: text("status").$type<DocCompareStatus>().notNull().default("running"),
    error: text("error"),
    result: jsonb("result").$type<DocCompareResult>(),
    /** Change regions from the browser's pixel diff. */
    regions: jsonb("regions").$type<PageRegions[]>(),
    regionsAt: timestamp("regions_at", { withTimezone: true }),
    aiStatus: text("ai_status").$type<DocAiStatus>().notNull().default("none"),
    aiBullets: jsonb("ai_bullets").$type<SummaryBullet[]>(),
    aiModel: text("ai_model"),
    aiError: text("ai_error"),
    aiStartedAt: timestamp("ai_started_at", { withTimezone: true }),
    aiFinishedAt: timestamp("ai_finished_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("doc_comparisons_pair").on(t.fromVersionId, t.toVersionId),
    index("doc_comparisons_project_idx").on(t.projectId),
  ],
);
