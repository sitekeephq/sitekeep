import { bigint, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

// The dashboards and dashboard_versions tables (report builder) belong to the Platform module
// (sitekeep-ee-platform, its own migrations; docs/modules/platform.md). The core's migrations created
// them before the split and never drop them: migration 0046 removed the generated DROP statements.

/**
 * Data change stamps for live report refresh: one counter per project and scope (works, files,
 * forms …). Statement-level triggers (migration 0020) bump it on every INSERT / UPDATE / DELETE of
 * the scope's tables, whatever wrote the rows (REST, MCP, jobs, imports). Reads never touch it.
 * No foreign key: a deleted project's rows are harmless and cleaned up with the project's data.
 */
export const reportChangeStamps = pgTable(
  "report_change_stamps",
  {
    projectId: uuid("project_id").notNull(),
    scope: text("scope").notNull(),
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.scope] })],
);
