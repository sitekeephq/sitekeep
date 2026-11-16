/**
 * ISO 19650 CDE: project settings, the state transition table and the unique document code
 * register (docs/features/CDE_STATES.md). Re-exported from schema.ts; references to core tables
 * are lazy so the circular import between the two files is safe.
 */
import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type {
  CdeCodeScheme,
  CdeRevisionRules,
  CdeState,
  CdeSuitabilityCode,
  CdeTransitionMode,
  CdeWipPolicy,
} from "@sitekeep/shared";
import { fileVersions, files, folders, namingStandards, projects } from "./schema.js";
import { reviews, workflowTemplates } from "./schema-workflow.js";

/** One row per project; a project without a row uses DEFAULT_CDE_SETTINGS. */
export const projectCdeSettings = pgTable("project_cde_settings", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  /** Off: transitions are recorded but not enforced (existing projects, D-8). */
  enforceTransitions: boolean("enforce_transitions").notNull().default(false),
  codeScheme: text("code_scheme").$type<CdeCodeScheme>().notNull().default("iso_uk_na"),
  /** Custom profile only. */
  suitabilityCodes: jsonb("suitability_codes").$type<CdeSuitabilityCode[]>(),
  revisionRules: jsonb("revision_rules").$type<CdeRevisionRules>(),
  archiveFolderId: uuid("archive_folder_id").references(() => folders.id, { onDelete: "set null" }),
  containerStandardId: uuid("container_standard_id").references(() => namingStandards.id, { onDelete: "set null" }),
  wipPolicy: text("wip_policy").$type<CdeWipPolicy>().notNull().default("grants"),
  adminSeesWip: boolean("admin_sees_wip").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Allowed state transitions of a project. `from_state` null is a direct upload into `to_state`.
 * Unique per (project, from, to) with null counted as one value (coalesce index).
 */
export const cdeTransitions = pgTable(
  "cde_transitions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fromState: text("from_state").$type<CdeState>(),
    toState: text("to_state").$type<CdeState>().notNull(),
    mode: text("mode").$type<CdeTransitionMode>().notNull(),
    workflowTemplateId: uuid("workflow_template_id").references(() => workflowTemplates.id, { onDelete: "set null" }),
    requireReason: boolean("require_reason").notNull().default(false),
  },
  (t) => [uniqueIndex("cde_transitions_unique").on(t.projectId, sql`coalesce(${t.fromState}, '')`, t.toState)],
);

/**
 * Unique document codes (ISO-3): a normalised code belongs to one container per project. The
 * first file that registered it is kept for messages.
 */
export const documentCodes = pgTable(
  "document_codes",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    codeNorm: text("code_norm").notNull(),
    containerId: uuid("container_id").notNull(),
    firstFileId: uuid("first_file_id").references(() => files.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.codeNorm] })],
);

/**
 * ISO-12: which version replaced which (ISO 19650-1 §12.5). A publication that archives the
 * current one records the pair: `version_id` is the new published version, `superseded_version_id`
 * the archive copy (and a publication in another place that it made superseded). Both sides read
 * the same row: the archived file shows "Superseded by", the new one "Supersedes".
 */
export const cdeSupersessions = pgTable(
  "cde_supersessions",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => fileVersions.id, { onDelete: "cascade" }),
    supersededVersionId: uuid("superseded_version_id")
      .notNull()
      .references(() => fileVersions.id, { onDelete: "cascade" }),
    reviewId: uuid("review_id").references(() => reviews.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.versionId, t.supersededVersionId] }), index("cde_supersessions_superseded").on(t.supersededVersionId)],
);
