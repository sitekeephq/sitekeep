/**
 * Workflow engine, document reviews, folder gate and in-app notifications.
 * Re-exported from schema.ts; references to core tables are lazy (arrow functions)
 * so the circular import between the two files is safe.
 */
import { sql } from "drizzle-orm";
import {
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
  FinalOutcomeMap,
  OutcomeCode,
  ReviewChainConfig,
  WorkflowActionKind,
  WorkflowKind,
  WorkflowStatus,
  WorkflowStep,
} from "@sitekeep/shared";
import { fileVersions, files, folders, projects, users } from "./schema.js";
import type { Msg } from "../i18n/index.js";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const workflowTemplates = pgTable(
  "workflow_templates",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").$type<WorkflowKind>().notNull(),
    name: text("name").notNull(),
    steps: jsonb("steps").$type<WorkflowStep[]>().notNull(),
    finalOutcomes: jsonb("final_outcomes").$type<FinalOutcomeMap>().notNull().default({}),
    /** Review chains: stages, origin party, number pattern, copy target rule. */
    chainConfig: jsonb("chain_config").$type<ReviewChainConfig>().notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("workflow_templates_project_idx").on(t.projectId, t.kind)],
);

/** Snapshot of the template taken when an instance starts; later template edits don't touch it. */
export interface TemplateSnapshot {
  templateId: string | null;
  name: string;
  steps: WorkflowStep[];
  finalOutcomes: FinalOutcomeMap;
  /** Review chains (absent on instances started before chains existed). */
  chain?: ReviewChainConfig;
}

export const workflowInstances = pgTable(
  "workflow_instances",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").$type<WorkflowKind>().notNull(),
    templateId: uuid("template_id").references(() => workflowTemplates.id, { onDelete: "set null" }),
    template: jsonb("template").$type<TemplateSnapshot>().notNull(),
    /** What the workflow runs on, e.g. ("review", reviews.id). */
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    stepIndex: integer("step_index").notNull().default(0),
    status: text("status").$type<WorkflowStatus>().notNull().default("running"),
    stepStartedAt: timestamp("step_started_at", { withTimezone: true }).notNull().defaultNow(),
    stepDueAt: timestamp("step_due_at", { withTimezone: true }),
    /** Deadline of the current chain stage (the step due date never goes past it). */
    stageDueAt: timestamp("stage_due_at", { withTimezone: true }),
    startedBy: uuid("started_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("workflow_instances_subject").on(t.subjectType, t.subjectId),
    index("workflow_instances_status_idx").on(t.projectId, t.status),
  ],
);

export const workflowActions = pgTable(
  "workflow_actions",
  {
    id: id(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => workflowInstances.id, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull(),
    kind: text("kind").$type<WorkflowActionKind>().notNull(),
    userId: uuid("user_id").references(() => users.id),
    outcome: text("outcome").$type<OutcomeCode>(),
    comment: text("comment"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflow_actions_instance_idx").on(t.instanceId, t.at)],
);

/** Document review: a set of pinned file versions run through a workflow instance. */
export const reviews = pgTable(
  "reviews",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    name: text("name").notNull(),
    note: text("note"),
    /** Approved versions are copied here when the review completes. */
    targetFolderId: uuid("target_folder_id").references(() => folders.id),
    /** Sub-folder pattern under the target folder, e.g. "{Bölge}/{Disiplin}" (smart copy target). */
    targetPattern: text("target_pattern"),
    /** A file whose pattern fields are missing is copied to the target folder itself (else not copied). */
    targetFallback: boolean("target_fallback").notNull().default(false),
    /** Number generated from the template's name pattern, e.g. "MBE-RP-0007". */
    code: text("code"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("reviews_number").on(t.projectId, t.number),
    uniqueIndex("reviews_code").on(t.projectId, t.code).where(sql`code IS NOT NULL`),
  ],
);

export const reviewFiles = pgTable(
  "review_files",
  {
    id: id(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id),
    fileVersionId: uuid("file_version_id")
      .notNull()
      .references(() => fileVersions.id),
    sourceFolderId: uuid("source_folder_id").notNull(),
    /** Combined outcome of each finished step: { "0": "approved", … }. */
    stepResults: jsonb("step_results").$type<Record<string, OutcomeCode>>().notNull().default({}),
    finalStatus: text("final_status").$type<OutcomeCode>(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    copiedFileId: uuid("copied_file_id"),
    copiedVersionId: uuid("copied_version_id"),
    copyError: text("copy_error"),
    /** Code given per step (custom outcome code, or the base code). */
    stepCodes: jsonb("step_codes").$type<Record<string, string>>().notNull().default({}),
    /** Label of the final status when it comes from a custom outcome. */
    finalLabel: text("final_label"),
    /** The chain stopped for this file in this step (revise/reject in a "stop" stage). */
    stoppedAtStep: integer("stopped_at_step"),
    /** Folder the approved copy was placed in (resolved from the target pattern). */
    copyFolderId: uuid("copy_folder_id"),
    /** Target pattern fields that could not be resolved for this file. */
    copyUnresolved: jsonb("copy_unresolved").$type<string[]>(),
  },
  (t) => [
    uniqueIndex("review_files_unique").on(t.reviewId, t.fileVersionId),
    index("review_files_version_idx").on(t.fileVersionId),
    index("review_files_copy_idx").on(t.copiedVersionId),
  ],
);

/** One reviewer's outcome for one file in one step. */
export const reviewMarks = pgTable(
  "review_marks",
  {
    id: id(),
    reviewFileId: uuid("review_file_id")
      .notNull()
      .references(() => reviewFiles.id, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    outcome: text("outcome").$type<OutcomeCode>().notNull(),
    /** Custom outcome code picked (outcome holds its base code). */
    optionCode: text("option_code"),
    comment: text("comment"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("review_marks_unique").on(t.reviewFileId, t.stepIndex, t.userId)],
);

/** Per-folder settings that don't belong on the folders table. */
export const folderSettings = pgTable("folder_settings", {
  folderId: uuid("folder_id")
    .primaryKey()
    .references(() => folders.id, { onDelete: "cascade" }),
  /** Files enter this folder (and its subfolders) only as approved review copies. */
  requireApprovedReview: boolean("require_approved_review").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    /**
     * Title and body as translation keys (docs/architecture/i18n.md §8), rendered in the reader's
     * language when listed; `title`/`body` keep the text in the server's default language for
     * older readers and rows written before this column.
     */
    message: jsonb("message").$type<{ title: Msg; body?: Msg | null } | null>(),
    /** Web app path, e.g. /projects/{pid}/reviews/{rid}. */
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.readAt, t.createdAt)],
);

/** Review number counters: one per project and resolved prefix ("MBE-RP-{0000}"). */
export const reviewCounters = pgTable(
  "review_counters",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    value: integer("value").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.scope] })],
);

/** Due-date reminders already sent (once per instance, step and kind). */
export const workflowReminders = pgTable(
  "workflow_reminders",
  {
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => workflowInstances.id, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull(),
    /** "due_soon" (1 day before) or "overdue". */
    kind: text("kind").$type<"due_soon" | "overdue">().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.instanceId, t.stepIndex, t.kind] })],
);
