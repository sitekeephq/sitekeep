import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Outbound connection log (Gizlilik Merkezi → Giden Bağlantı Kaydı): one row per server-side call
 * to another host (AI provider, SMTP, office editor/converter…), written by privacy/outbound.ts.
 * Never content: only purpose, host, sizes, status and timing. Rows older than the retention
 * setting (default 90 days) are removed by a daily job.
 */
export const outboundLog = pgTable(
  "outbound_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** "yapay_zeka:deepseek", "eposta", "ofis:onlyoffice" … */
    purpose: text("purpose").notNull(),
    /** Connection id of the registry ("ai:<providerId>", "smtp", "office:editor", "office:converter"). */
    connection: text("connection"),
    host: text("host").notNull(),
    method: text("method").notNull(),
    /** The host is inside the customer's network (private range or the "iç ağ" list). */
    local: boolean("local").notNull(),
    /** Refused before connecting (kill switch or a disabled connection). */
    blocked: boolean("blocked").notNull().default(false),
    bytesOut: integer("bytes_out"),
    bytesIn: integer("bytes_in"),
    /** HTTP status (null: no answer, SMTP). */
    status: integer("status"),
    /** Short error code ("blocked", "timeout", "network"…); never content. */
    error: text("error"),
    durationMs: integer("duration_ms"),
    /** No foreign keys: a log row outlives deleted users and projects (and never fails an insert). */
    userId: uuid("user_id"),
    projectId: uuid("project_id"),
    /** Non-content details, e.g. AI: feature, provider, characters sent, redaction counts. */
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (t) => [index("outbound_log_at_idx").on(t.at), index("outbound_log_purpose_idx").on(t.purpose, t.at), index("outbound_log_host_idx").on(t.host, t.at)],
);
