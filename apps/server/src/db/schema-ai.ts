import { boolean, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { projects, users } from "./schema.js";

/**
 * The AI module's own tables (task queue, personal keys) are in its package (docs/modules/ai.md).
 *
 * System-wide settings managed by system administrators (AI mode, AI providers, MCP policy).
 * Keys: "integrations.mcp", "ai.mode", "ai.providers", "ai.defaultProviderId".
 * Provider API keys inside "ai.providers" are stored encrypted (AES-256-GCM), never in plain text.
 */
export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Per-project AI policy, set by project admins. It can never exceed the system mode. */
export const projectAiSettings = pgTable("project_ai_settings", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(true),
  /** Provider id from "ai.providers"; null = system default. */
  providerId: text("provider_id"),
  /** Project consents to external (cloud) providers; effective only when the system mode allows it. */
  allowExternal: boolean("allow_external").notNull().default(false),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
