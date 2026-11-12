/**
 * The simple project screen (docs/product/SADELESTIRME.md): saved views of the İşler hub and the cached
 * "Günün Özeti" (AI summary of the project Bugün page) per user.
 */
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { TodaySummaryBullet } from "@sitekeep/shared";
import { projects, users } from "./schema.js";

/**
 * "Görünümü Kaydet": a hub view with its filters, per user per project. Project administrators
 * may share a view with every member of the project.
 */
export const savedViews = pgTable(
  "saved_views",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Hub view key (HUB_VIEW_KEYS). */
    view: text("view").notNull(),
    /** URL filters of the view: search, status, due, grouping… */
    params: jsonb("params").$type<Record<string, string>>().notNull().default({}),
    shared: boolean("shared").notNull().default(false),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("saved_views_project_owner_idx").on(t.projectId, t.ownerId)],
);

/**
 * "Günün Özeti": the last AI summary of one user's Bugün page in one project. `stamp` is the hash of
 * the compact input it was written from; a new one is written when the data changed, at most every
 * 15 minutes (TODAY_SUMMARY_MIN_INTERVAL_MS). Only its owner ever reads it.
 */
export const todaySummaries = pgTable(
  "today_summaries",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    stamp: text("stamp"),
    bullets: jsonb("bullets").$type<TodaySummaryBullet[]>(),
    model: text("model"),
    /** "provider" (configured model) or "queue" (Yapay Zekâya Gönder). */
    source: text("source"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    /** Last background run start (success or failure): the 15-minute limit counts from here. */
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    error: text("error"),
    errorAt: timestamp("error_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.projectId] })],
);
