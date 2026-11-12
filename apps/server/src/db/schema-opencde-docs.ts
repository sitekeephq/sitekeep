/**
 * OpenCDE Documents API 1.0 sessions (docs/features/OPENCDE.md): an authoring tool (AEC Pilot, Solibri …)
 * starts an upload or a selection, the user finishes it on a CDE page, the tool then uploads the
 * parts or reads the selection. Sessions belong to the token's user and OAuth client; the page
 * link is stored only as a SHA-256 hash and works once (bound to the first browser session).
 */
import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { OpenCdeSessionKind, OpenCdeSessionStatus } from "@sitekeep/shared";
import { files, fileVersions, folders, projects, users } from "./schema.js";
import { oauthClients } from "./schema-oauth.js";

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const opencdeDocSessions = pgTable(
  "opencde_doc_sessions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    kind: text("kind").$type<OpenCdeSessionKind>().notNull(),
    status: text("status").$type<OpenCdeSessionStatus>().notNull().default("pending"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** OAuth client of the token (null for personal API tokens). */
    oauthClientId: uuid("oauth_client_id").references(() => oauthClients.id, { onDelete: "cascade" }),
    /** Token that started the session; later API calls must come from the same user and client. */
    clientName: text("client_name").notNull(),
    /** SHA-256 of the page link key (upload_ui_url / select_documents_url). */
    uiKeyHash: text("ui_key_hash").notNull().unique(),
    uiExpiresAt: ts("ui_expires_at").notNull(),
    /** First browser session that opened the page; nobody else can use the link afterwards. */
    claimedAt: ts("claimed_at"),
    claimedBy: text("claimed_by"),
    callbackUrl: text("callback_url").notNull(),
    callbackExpiresAt: ts("callback_expires_at").notNull(),
    supportedExtensions: text("supported_extensions").array().notNull().default(sql`'{}'::text[]`),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    /** Upload page values: version comment and file attributes (Revizyon, Uygunluk, project attributes). */
    comment: text("comment"),
    attributes: jsonb("attributes").$type<Record<string, string>>().notNull().default({}),
    /** Select page: chosen file versions. */
    selectedVersionIds: uuid("selected_version_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /** After this nothing works any more (instructions, parts, completion, selection result). */
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    completedAt: ts("completed_at"),
  },
  (t) => [index("opencde_doc_sessions_user_idx").on(t.userId), index("opencde_doc_sessions_expires_idx").on(t.expiresAt)],
);

export type OpenCdeFileStatus = "pending" | "uploading" | "completed" | "cancelled";

/** Files of an upload session (client session_file_id → CDE name, size, result). */
export const opencdeDocSessionFiles = pgTable(
  "opencde_doc_session_files",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => opencdeDocSessions.id, { onDelete: "cascade" }),
    sessionFileId: text("session_file_id").notNull(),
    fileName: text("file_name").notNull(),
    /** New version of this existing file (document_id). */
    documentId: uuid("document_id").references(() => files.id, { onDelete: "set null" }),
    targetName: text("target_name"),
    sizeInBytes: bigint("size_in_bytes", { mode: "number" }),
    partSize: integer("part_size"),
    status: text("status").$type<OpenCdeFileStatus>().notNull().default("pending"),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    versionId: uuid("version_id").references(() => fileVersions.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [unique("opencde_doc_session_files_uq").on(t.sessionId, t.sessionFileId)],
);

/** Uploaded parts, stored as separate objects until the completion joins them. */
export const opencdeUploadParts = pgTable(
  "opencde_upload_parts",
  {
    fileRowId: uuid("file_row_id")
      .notNull()
      .references(() => opencdeDocSessionFiles.id, { onDelete: "cascade" }),
    partIndex: integer("part_index").notNull(),
    storageKey: text("storage_key").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.fileRowId, t.partIndex] })],
);
