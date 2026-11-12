/**
 * "İşler" (works): typed records for correspondence, transmittals and later RFIs, submittals…
 * Re-exported from schema.ts; references to core tables are lazy (arrow functions) so the
 * circular import between the two files is safe.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  type AnyPgColumn,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  DeliveryStatus,
  TransmittalPurpose,
  WorkCategory,
  WorkEventKind,
  WorkFieldDef,
  WorkFieldValues,
  WorkLinkKind,
  WorkLinkMeta,
  WorkLinkRole,
  WorkStatusDef,
  WorkTypeSettings,
  OutcomeCode,
} from "@sitekeep/shared";
import { companies, projects, users } from "./schema.js";
import { workflowInstances, workflowTemplates } from "./schema-workflow.js";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Project-scoped work type templates (built-in ones are seeded on first use). */
export const workTypes = pgTable(
  "work_types",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    category: text("category").$type<WorkCategory>().notNull(),
    numberingPattern: text("numbering_pattern").notNull(),
    counterGroup: text("counter_group"),
    fields: jsonb("fields").$type<WorkFieldDef[]>().notNull().default([]),
    statuses: jsonb("statuses").$type<WorkStatusDef[]>().notNull(),
    settings: jsonb("settings").$type<WorkTypeSettings>().notNull().default({}),
    defaultWorkflowTemplateId: uuid("default_workflow_template_id").references(() => workflowTemplates.id, {
      onDelete: "set null",
    }),
    icon: text("icon"),
    color: text("color"),
    builtIn: boolean("built_in").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("work_types_key").on(t.projectId, t.key)],
);

/** Atomic number counters; scope = counter group + pattern with every token but the counter filled. */
export const workCounters = pgTable(
  "work_counters",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    value: integer("value").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.scope] })],
);

/** Delivery record of a sent work (channel-specific reference such as a KEP gönderim no). */
export interface WorkDelivery {
  channel: string;
  status: DeliveryStatus;
  reference: string | null;
  note: string | null;
  sentAt: string | null;
  sentBy: string | null;
  updatedAt: string | null;
}

export const works = pgTable(
  "works",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    typeId: uuid("type_id")
      .notNull()
      .references(() => workTypes.id),
    number: text("number").notNull(),
    /** Counter value the number was made from. */
    seq: integer("seq").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),
    fields: jsonb("fields").$type<WorkFieldValues>().notNull().default({}),
    /** Company of the creator at creation time (owner side for visibility). */
    ownerCompanyId: uuid("owner_company_id").references(() => companies.id),
    fromCompanyId: uuid("from_company_id").references(() => companies.id),
    /** "Gereği" (action) recipients. */
    toCompanyIds: uuid("to_company_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /** "Bilgi" (info) recipients. */
    ccCompanyIds: uuid("cc_company_ids").array().notNull().default(sql`'{}'::uuid[]`),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id),
    dueDate: text("due_date"),
    replyRequired: boolean("reply_required").notNull().default(false),
    delivery: jsonb("delivery").$type<WorkDelivery>(),
    workflowInstanceId: uuid("workflow_instance_id").references(() => workflowInstances.id, { onDelete: "set null" }),
    /** Parent work: the package of a submittal item, the meeting of an action. */
    parentWorkId: uuid("parent_work_id").references((): AnyPgColumn => works.id, { onDelete: "set null" }),
    /** Type-specific structured data: meeting agenda / attendees / minutes, submittal revision number. */
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("works_number").on(t.projectId, t.typeId, t.number),
    index("works_project_idx").on(t.projectId, t.typeId, t.status),
    index("works_parent_idx").on(t.parentWorkId),
  ],
);

export const workLinks = pgTable(
  "work_links",
  {
    id: id(),
    workId: uuid("work_id")
      .notNull()
      .references(() => works.id, { onDelete: "cascade" }),
    kind: text("kind").$type<WorkLinkKind>().notNull(),
    targetId: uuid("target_id").notNull(),
    role: text("role").$type<WorkLinkRole>().notNull(),
    meta: jsonb("meta").$type<WorkLinkMeta>().notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("work_links_unique").on(t.workId, t.kind, t.targetId, t.role),
    index("work_links_target_idx").on(t.kind, t.targetId),
  ],
);

/** Timeline of a work. */
export const workEvents = pgTable(
  "work_events",
  {
    id: id(),
    workId: uuid("work_id")
      .notNull()
      .references(() => works.id, { onDelete: "cascade" }),
    kind: text("kind").$type<WorkEventKind>().notNull(),
    userId: uuid("user_id").references(() => users.id),
    message: text("message"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("work_events_work_idx").on(t.workId, t.at)],
);

/** Receipt confirmation ("alındı") per recipient company. */
export const workReceipts = pgTable(
  "work_receipts",
  {
    workId: uuid("work_id")
      .notNull()
      .references(() => works.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    receivedBy: uuid("received_by")
      .notNull()
      .references(() => users.id),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workId, t.companyId] })],
);

/**
 * Works-related options of a workflow template (kept in a side table so workflow tables stay
 * untouched): e.g. create a transmittal when a review using the template completes.
 */
export const workflowTemplateWorkOptions = pgTable("workflow_template_work_options", {
  templateId: uuid("template_id")
    .primaryKey()
    .references(() => workflowTemplates.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  autoTransmittal: boolean("auto_transmittal").notNull().default(false),
  recipientCompanyIds: uuid("recipient_company_ids").array().notNull().default(sql`'{}'::uuid[]`),
  purpose: text("purpose").$type<TransmittalPurpose>().notNull().default("bilgi"),
  send: boolean("send").notNull().default(true),
  include: text("include").$type<"approved" | "all">().notNull().default("approved"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One submission of a work to its workflow (RFI, submittal item). Revision 0 is the first
 * submission; "Revize et" opens the next revision of the same work. The workflow instance runs
 * on the revision (subject "work_revision"), so every revision keeps its own chain and answers.
 */
export const workRevisions = pgTable(
  "work_revisions",
  {
    id: id(),
    workId: uuid("work_id")
      .notNull()
      .references(() => works.id, { onDelete: "cascade" }),
    rev: integer("rev").notNull(),
    status: text("status").$type<"running" | "decided" | "cancelled">().notNull().default("running"),
    workflowInstanceId: uuid("workflow_instance_id").references(() => workflowInstances.id, { onDelete: "set null" }),
    /** Field values and attachment versions as submitted. */
    fields: jsonb("fields").$type<WorkFieldValues>().notNull().default({}),
    attachments: jsonb("attachments").$type<{ versionId: string; name: string; version: number }[]>().notNull().default([]),
    comment: text("comment"),
    submittedBy: uuid("submitted_by")
      .notNull()
      .references(() => users.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    /** Final base outcome, the picked code and its label. */
    outcome: text("outcome").$type<OutcomeCode>(),
    outcomeCode: text("outcome_code"),
    outcomeLabel: text("outcome_label"),
    /** Official response (RFI). */
    response: text("response"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("work_revisions_rev").on(t.workId, t.rev)],
);
