import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  DerivativeStatus,
  CdeFileStatus,
  FolderState,
  IfcSummary,
  IssueImportInfo,
  IssuePin,
  IssuePriority,
  IssueStatus,
  IssueViewpoint,
  NamingStandard,
  OAuthScope,
  PermissionLevel,
  ProjectSettings,
  SubjectType,
  UserPrefs,
} from "@sitekeep/shared";
import { oauthClients } from "./schema-oauth.js";
import { projectRoles } from "./schema-roles.js";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const companies = pgTable("companies", {
  id: id(),
  name: text("name").notNull().unique(),
  /** Short code used in numbers ({Gönderen}, {Alıcı}) and as the default slot code, e.g. "PAS". */
  code: text("code").unique(),
  /** Postal address and e-mail: prefill the recipient ("muhatap") of official letters. */
  address: text("address"),
  email: text("email"),
  createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  /** System administrator: manages users, companies and every project. */
  isAdmin: boolean("is_admin").notNull().default(false),
  companyId: uuid("company_id").references(() => companies.id),
  disabled: boolean("disabled").notNull().default(false),
  /**
   * Invited and not yet accepted (docs/features/INVITATIONS.md): the account exists for the project
   * memberships but stays disabled (no sign-in, no seat) until the invitation is accepted.
   */
  pending: boolean("pending").notNull().default(false),
  /** Per-user settings ("Gelişmiş Ayarları Göster" …), see UserPrefs. */
  prefs: jsonb("prefs").$type<UserPrefs>().notNull().default({}),
  createdAt: createdAt(),
});

/**
 * Browser sessions, API tokens (MCP, AECPilot) and OAuth access tokens of OpenCDE clients. Only the
 * SHA-256 of the token is stored. Every kind authenticates as its user (same permission checks).
 */
export const tokens = pgTable(
  "tokens",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"session" | "api" | "oauth">().notNull(),
    name: text("name"),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** API tokens: "read" allows GET and read-only POSTs; "write" everything the user may do. */
    scope: text("scope").$type<"read" | "write">().notNull().default("write"),
    /** API tokens: limited to these projects (null = every project of the user). */
    projectIds: uuid("project_ids").array(),
    /** OAuth access tokens: the client, the token family (refresh rotation) and the granted scopes. */
    oauthClientId: uuid("oauth_client_id").references((): AnyPgColumn => oauthClients.id, { onDelete: "cascade" }),
    oauthFamilyId: uuid("oauth_family_id"),
    oauthScopes: text("oauth_scopes").array().$type<OAuthScope[]>(),
  },
  (t) => [index("tokens_user_idx").on(t.userId), index("tokens_oauth_family_idx").on(t.oauthFamilyId)],
);

export const projects = pgTable(
  "projects",
  {
  id: id(),
  /** Unique among active projects; a deleted (archived) project frees its code. */
  code: text("code").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  rootFolderId: uuid("root_folder_id"),
  archived: boolean("archived").notNull().default(false),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
  /** Project settings set by project administrators: module switches (ProjectSettings). */
  settings: jsonb("settings").$type<ProjectSettings>().notNull().default({}),
  },
  (t) => [uniqueIndex("projects_code_active").on(t.code).where(sql`archived = false`)],
);

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Company the user represents in this project (defaults to the user's company). */
    companyId: uuid("company_id").references(() => companies.id),
    isProjectAdmin: boolean("is_project_admin").notNull().default(false),
    addedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

export const namingStandards = pgTable("naming_standards", {
  id: id(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  definition: jsonb("definition").$type<NamingStandard>().notNull(),
  createdAt: createdAt(),
});

export const folders = pgTable(
  "folders",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    description: text("description"),
    state: text("state").$type<FolderState>(),
    /** Free sub-status shown next to the state ("Onay için", "As-Built"); set by project templates. */
    stateLabel: text("state_label"),
    namingStandardId: uuid("naming_standard_id").references(() => namingStandards.id),
    /** Task team (project role of kind 'task_team') that owns this WIP folder (D-4). */
    ownerTeamId: uuid("owner_team_id").references((): AnyPgColumn => projectRoles.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("folders_parent_idx").on(t.parentId),
    uniqueIndex("folders_unique_name").on(t.parentId, t.name).where(sql`deleted_at IS NULL`),
  ],
);

export const folderGrants = pgTable(
  "folder_grants",
  {
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").$type<SubjectType>().notNull(),
    subjectId: uuid("subject_id").notNull(),
    level: text("level").$type<PermissionLevel>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.folderId, t.subjectType, t.subjectId] })],
);

export const files = pgTable(
  "files",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id),
    name: text("name").notNull(),
    description: text("description"),
    currentVersion: integer("current_version").notNull().default(1),
    attributes: jsonb("attributes").$type<Record<string, string>>().notNull().default({}),
    /**
     * The document (ISO 19650 information container) this file belongs to: review copies of one
     * document share it; any other new file starts its own. Filled by the database when not given
     * (trigger files_container_default, migration 0042: container_id = id).
     */
    containerId: uuid("container_id")
      .notNull()
      .$defaultFn(() => sql`DEFAULT`),
    /** Unique document code (normalised name without extension), registered in document_codes. */
    documentCode: text("document_code"),
    /** Status flag beside the folder state: returned, superseded, withdrawn (docs/features/CDE_STATES.md). */
    cdeStatus: text("cde_status").$type<CdeFileStatus>(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("files_folder_idx").on(t.folderId),
    index("files_container_idx").on(t.containerId),
    uniqueIndex("files_unique_name").on(t.folderId, t.name).where(sql`deleted_at IS NULL`),
  ],
);

export const fileVersions = pgTable(
  "file_versions",
  {
    id: id(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    storageKey: text("storage_key").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    uploadedBy: uuid("uploaded_by").references(() => users.id),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    comment: text("comment"),
    derivativeStatus: text("derivative_status").$type<DerivativeStatus>().notNull().default("none"),
    derivativeKey: text("derivative_key"),
    derivativeError: text("derivative_error"),
    ifcSummary: jsonb("ifc_summary").$type<IfcSummary>(),
    /** ISO 19650 codes of this version (D-1): suitability "S2", revision "P01.02". */
    suitabilityCode: text("suitability_code"),
    revisionCode: text("revision_code"),
    codesSetBy: uuid("codes_set_by").references(() => users.id, { onDelete: "set null" }),
    codesSetAt: timestamp("codes_set_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("file_versions_unique").on(t.fileId, t.version)],
);

/** Read-only document trees mirrored from external CDE providers such as Autodesk APS. */
export const externalDocumentSources = pgTable(
  "external_document_sources",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalHubId: text("external_hub_id").notNull(),
    externalProjectId: text("external_project_id").notNull(),
    name: text("name").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("external_document_sources_project_provider_external").on(
      t.projectId,
      t.provider,
      t.externalProjectId,
    ),
    index("external_document_sources_project_idx").on(t.projectId),
  ],
);

export const externalDocuments = pgTable(
  "external_documents",
  {
    id: id(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => externalDocumentSources.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    parentExternalId: text("parent_external_id"),
    kind: text("kind").$type<"folder" | "file">().notNull(),
    name: text("name").notNull(),
    path: text("path").notNull(),
    versionNumber: integer("version_number"),
    webUrl: text("web_url"),
    sourceCreatedAt: timestamp("source_created_at", { withTimezone: true }),
    sourceModifiedAt: timestamp("source_modified_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    uniqueIndex("external_documents_source_external").on(t.sourceId, t.externalId),
    index("external_documents_parent_idx").on(t.sourceId, t.parentExternalId),
    index("external_documents_source_kind_idx").on(t.sourceId, t.kind),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<"queued" | "running" | "done" | "failed">().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("jobs_status_idx").on(t.status)],
);

export const issues = pgTable(
  "issues",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").$type<IssueStatus>().notNull().default("open"),
    priority: text("priority").$type<IssuePriority>().notNull().default("normal"),
    type: text("type"),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id),
    assigneeCompanyId: uuid("assignee_company_id").references(() => companies.id),
    dueDate: text("due_date"),
    /** Primary viewpoint (BCF: the first one); more viewpoints live in issue_viewpoints. */
    viewpoint: jsonb("viewpoint").$type<IssueViewpoint>(),
    pin: jsonb("pin").$type<IssuePin>(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // BCF topic fields (docs/features/BCF.md). guid = id for issues created here (backfilled by 0029).
    guid: text("guid").notNull().default(sql`gen_random_uuid()::text`),
    labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
    stage: text("stage"),
    referenceLinks: text("reference_links").array().notNull().default(sql`'{}'::text[]`),
    modifiedBy: uuid("modified_by").references(() => users.id),
    /** Set by a .bcfzip import: source, version, original BCF values without a match here. */
    importedFrom: jsonb("imported_from").$type<IssueImportInfo>(),
  },
  (t) => [uniqueIndex("issues_number").on(t.projectId, t.number), uniqueIndex("issues_guid").on(t.projectId, t.guid)],
);

export const issueComments = pgTable(
  "issue_comments",
  {
    id: id(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    createdAt: createdAt(),
    /** BCF comment GUID (= id for comments written here, backfilled by 0029). */
    guid: text("guid").notNull().default(sql`gen_random_uuid()::text`),
    /** BCF viewpoint the comment refers to. */
    viewpointGuid: text("viewpoint_guid"),
    modifiedAt: timestamp("modified_at", { withTimezone: true }),
    modifiedBy: uuid("modified_by").references(() => users.id),
    /** Imported comment: original BCF author (e-mail) when it matched no project member. */
    importedAuthor: text("imported_author"),
  },
  (t) => [uniqueIndex("issue_comments_guid").on(t.issueId, t.guid)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectId: uuid("project_id"),
    userId: uuid("user_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** Hash chain (ISO-4): hash of the previous row and of this row (filled by the audit work). */
    prevHash: text("prev_hash"),
    hash: text("hash"),
    /**
     * Client of the request (D-9) on chained rows written before migration 0049 only: newer rows
     * keep it in audit_personal and carry personal_hash instead (docs/features/AUDIT_LOG.md#personal-data).
     */
    ip: text("ip"),
    userAgent: text("user_agent"),
    /** Keyed hash (HMAC-SHA256) of the row's audit_personal values; part of the chained content. */
    personalHash: text("personal_hash"),
  },
  (t) => [
    index("audit_project_idx").on(t.projectId, t.at),
    index("audit_project_action_idx").on(t.projectId, t.action, t.at),
    index("audit_target_idx").on(t.targetType, t.targetId),
    index("audit_user_idx").on(t.userId, t.at),
  ],
);

/**
 * Personal part of an audit row (P1-5, migration 0049): the client's IP address and user agent and
 * an e-mail address the event names. Not chained, so it can be deleted (retention, erasure of one
 * person) while the chained row keeps only personal_hash. Rows are written with their audit row and
 * deleted, never changed.
 */
export const auditPersonal = pgTable(
  "audit_personal",
  {
    auditId: bigint("audit_id", { mode: "number" })
      .primaryKey()
      .references(() => auditLog.id),
    /** Time of the audit row (the retention clock). */
    at: timestamp("at", { withTimezone: true }).notNull(),
    /** The audit row's person, or the known account the event names (erasure by person). */
    userId: uuid("user_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    /** Lower-case e-mail address moved out of details (details keep emailHash). */
    email: text("email"),
  },
  (t) => [index("audit_personal_at_idx").on(t.at), index("audit_personal_user_idx").on(t.userId), index("audit_personal_email_idx").on(t.email)],
);

/**
 * Re-seals of the audit chain (docs/features/AUDIT_LOG.md#re-seal): one row per maintenance
 * operation that moved personal values out of chained rows and recomputed the chain from there.
 */
export const auditReseals = pgTable("audit_reseal", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  userId: uuid("user_id"),
  /** First row rewritten: every chained row from here to the old head got a new hash. */
  fromId: bigint("from_id", { mode: "number" }).notNull(),
  /** Head of the chain before the re-seal. */
  oldHeadId: bigint("old_head_id", { mode: "number" }).notNull(),
  oldHeadHash: text("old_head_hash").notNull(),
  /** Hash of the same row after the rewrite (the audit.resealed row chains to it). */
  newHeadHash: text("new_head_hash").notNull(),
  rowsRewritten: integer("rows_rewritten").notNull(),
  personalMoved: integer("personal_moved").notNull(),
  /** sha256 over "id:old_prev_hash:old_hash\n" of every archived row, in id order. */
  archiveDigest: text("archive_digest").notNull(),
});

/** The hashes re-sealed rows had before the re-seal: an old head hash recorded elsewhere stays findable. */
export const auditResealHashes = pgTable(
  "audit_reseal_hash",
  {
    resealId: bigint("reseal_id", { mode: "number" })
      .notNull()
      .references(() => auditReseals.id),
    rowId: bigint("row_id", { mode: "number" }).notNull(),
    oldPrevHash: text("old_prev_hash"),
    oldHash: text("old_hash").notNull(),
  },
  (t) => [primaryKey({ columns: [t.resealId, t.rowId] }), index("audit_reseal_hash_old_idx").on(t.oldHash)],
);

export * from "./schema-workflow.js";
export * from "./schema-docs.js";
export * from "./schema-markup.js";
export * from "./schema-ai.js";
export * from "./schema-locations.js";
// Feature schemas (see docs/architecture/structure.md: tables live in their feature file).
export * from "./schema-reports.js";
export * from "./schema-roles.js";
export * from "./schema-templates.js";
export * from "./schema-works.js";
export * from "./schema-coordination.js";
export * from "./schema-docintel.js";
export * from "./schema-doccompare.js";
export * from "./schema-previews.js";
export * from "./schema-wopi.js";
export * from "./schema-hub.js";
export * from "./schema-oauth.js";
export * from "./schema-bcf.js";
export * from "./schema-privacy.js";
export * from "./schema-opencde-docs.js";
export * from "./schema-integrations.js";
export * from "./schema-cde.js";

export * from "./schema-sheets.js";
export * from "./schema-model-markup.js";
export * from "./schema-invitations.js";
