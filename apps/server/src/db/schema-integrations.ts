import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { projects, users } from "./schema.js";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Idempotent, removable presentation-data batches for existing projects. */
export const showcaseBatches = pgTable(
  "showcase_batches",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("showcase_batches_project_key").on(t.projectId, t.key)],
);

export const showcaseRecords = pgTable(
  "showcase_records",
  {
    batchId: uuid("batch_id")
      .notNull()
      .references(() => showcaseBatches.id, { onDelete: "cascade" }),
    nativeType: text("native_type").notNull(),
    nativeId: uuid("native_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("showcase_records_unique").on(t.batchId, t.nativeType, t.nativeId),
    index("showcase_records_native_idx").on(t.nativeType, t.nativeId),
  ],
);
