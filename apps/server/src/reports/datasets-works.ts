/**
 * Report datasets of "İşler": one dataset for every work (`works`) and convenience datasets per
 * family (correspondence, rfis, submittals, meetings, actions, transmittals) with family-specific
 * columns. All of them share one load per report run (ctx.memo): the works the caller sees under
 * the same rules as the İşler list (canSeeWork + workflow participants), their revisions, running
 * workflow step and "sıradaki taraf".
 */
import { inArray } from "drizzle-orm";
import {
  ALL_BUILT_IN_WORK_TYPES,
  DELIVERY_STATUS_LABELS_TR,
  LETTER_LANGUAGE_LABELS,
  OUTCOME_LABELS_TR,
  SUBMITTAL_KINDS,
  TRANSMITTAL_PURPOSE_LABELS_TR,
  WORK_CATEGORY_LABELS_TR,
  WORK_STATUS,
  defaultStatuses,
  submittalKindOf,
  type ReportRow,
  type WorkCategory,
} from "@sitekeep/shared";
import { workLinks, workReceipts } from "../db/schema.js";
import { flowState, visibleWorks } from "../works/detail.js";
import { DELIVERY_CHANNELS } from "../works/delivery.js";
import { letterDay, letterOf } from "../works/letter.js";
import { meetingDataOf } from "../works/meeting-data.js";
import { statusDef, type TypeRow, type WorkRow } from "../works/service.js";
import { ballInCourt, type RevisionRow } from "../works/workflow.js";
import { projectMemberRows } from "../workflow/service.js";
import { msg, type Msg } from "../i18n/index.js";
import { iso, labelValues, reportDatasets, type DatasetField, type ReportContext } from "./datasets.js";
import { dayKey } from "./engine.js";
import { moduleInstalled } from "../app/module-ids.js";

const DAY_MS = 86_400_000;

/** Status code → label of every built-in work type (custom statuses fall back to the code; rows carry statusLabel). */
const WORK_STATUS_VALUES: Record<string, string> = Object.fromEntries(
  ALL_BUILT_IN_WORK_TYPES.flatMap((t) => (t.statuses ?? defaultStatuses(t.category)).map((s) => [s.key, s.label])),
);
const CHANNEL_VALUES: Record<string, string | Msg> = Object.fromEntries(DELIVERY_CHANNELS.map((c) => [c.id, c.label]));
const KIND_VALUES: Record<string, string> = Object.fromEntries(SUBMITTAL_KINDS.map((k) => [k.code, k.label]));
const DIRECTION_VALUES = { gelen: msg("reports:values.direction.gelen"), giden: msg("reports:values.direction.giden") };

export interface WorkBase {
  w: WorkRow;
  t: TypeRow;
  closed: boolean;
  statusLabel: string;
  first: RevisionRow | undefined;
  last: RevisionRow | undefined;
  revCount: number;
  ballInCourt: string | null;
  fromCompany: string | null;
  toCompanies: string[];
  assignee: string | null;
  assigneeCompany: string | null;
  createdBy: string | null;
  parent: WorkRow | undefined;
  answeredAt: Date | null;
  dueDate: string | null;
  overdue: boolean;
  daysOverdue: number | null;
  daysOpen: number | null;
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
const str = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));

/** Visible works of the project with their workflow state, loaded once per report run. */
export function workBase(ctx: ReportContext): Promise<WorkBase[]> {
  return ctx.memo("works:base", async () => {
    const { list } = await visibleWorks(ctx.db, ctx.access);
    const st = await flowState(ctx.db, list.map((x) => x.w.id));
    const members = await projectMemberRows(ctx.db, ctx.access.project.id);
    const people = await ctx.people();
    await people.ensure(list.flatMap(({ w }) => [w.createdBy, w.assigneeUserId]));
    const byId = new Map(list.map((x) => [x.w.id, x.w]));
    const today = dayKey(ctx.now, ctx.timeZone)!;
    return list.map(({ w, t }): WorkBase => {
      const s = statusDef(t, w.status);
      const closed = !!s.closed;
      const first = st.first(w.id);
      const last = st.last(w.id);
      let bic = ballInCourt(w, t, st.instanceOf(w.id), members);
      // A letter that expects a reply waits for its addressees.
      if (!bic.length && t.category === "correspondence" && w.replyRequired && (w.status === WORK_STATUS.sent || w.status === WORK_STATUS.received))
        bic = w.toCompanyIds;
      const answeredAt =
        t.category === "rfi" || t.category === "submittal"
          ? last?.status === "decided"
            ? (last.decidedAt ?? null)
            : null
          : w.status === WORK_STATUS.answered
            ? (w.closedAt ?? w.updatedAt)
            : t.category === "action" && closed
              ? (w.closedAt ?? null)
              : null;
      const overdue = !closed && !!w.dueDate && w.dueDate < today && w.status !== WORK_STATUS.answered;
      const start = first?.submittedAt ?? w.sentAt ?? w.createdAt;
      const end = answeredAt ?? (closed ? (w.closedAt ?? ctx.now) : ctx.now);
      return {
        w,
        t,
        closed,
        statusLabel: s.label,
        first,
        last,
        revCount: st.revs.filter((r) => r.workId === w.id).length,
        ballInCourt: bic.length ? bic.map((c) => people.companyName(c) ?? "?").join(", ") : null,
        fromCompany: people.companyName(w.fromCompanyId),
        toCompanies: w.toCompanyIds.map((c) => people.companyName(c) ?? "?"),
        assignee: people.name(w.assigneeUserId),
        assigneeCompany: w.assigneeUserId ? people.company(w.assigneeUserId) : null,
        createdBy: people.name(w.createdBy),
        parent: w.parentWorkId ? byId.get(w.parentWorkId) : undefined,
        answeredAt,
        dueDate: w.dueDate,
        overdue,
        daysOverdue: overdue ? daysBetween(w.dueDate!, today) : null,
        daysOpen: Math.max(0, Math.floor((end.getTime() - start.getTime()) / DAY_MS)),
      };
    });
  });
}

// ---- Shared field definitions ------------------------------------------------------------------

const F = {
  number: { type: "string", label: msg("reports:datasets.workCommon.fields.number") },
  title: { type: "string", label: msg("reports:datasets.workCommon.fields.title") },
  type: { type: "string", label: msg("reports:datasets.workCommon.fields.type") },
  status: { type: "string", label: msg("reports:datasets.workCommon.fields.status"), values: WORK_STATUS_VALUES, description: msg("reports:datasets.workCommon.hints.status") },
  statusLabel: { type: "string", label: msg("reports:datasets.workCommon.fields.statusLabel") },
  isOpen: { type: "boolean", label: msg("reports:datasets.workCommon.fields.isOpen"), description: msg("reports:datasets.workCommon.hints.isOpen") },
  fromCompany: { type: "string", label: msg("reports:datasets.workCommon.fields.fromCompany") },
  toCompany: { type: "string", label: msg("reports:datasets.workCommon.fields.toCompany"), description: msg("reports:datasets.workCommon.hints.toCompany") },
  toCompanies: { type: "string", label: msg("reports:datasets.workCommon.fields.toCompanies"), description: msg("reports:datasets.workCommon.hints.toCompanies") },
  ballInCourt: { type: "string", label: msg("reports:datasets.workCommon.fields.ballInCourt"), description: msg("reports:datasets.workCommon.hints.ballInCourt") },
  assignee: { type: "string", label: msg("reports:datasets.workCommon.fields.assignee") },
  assigneeCompany: { type: "string", label: msg("reports:datasets.workCommon.fields.assigneeCompany") },
  createdBy: { type: "string", label: msg("reports:datasets.workCommon.fields.createdBy") },
  dueDate: { type: "date", label: msg("reports:datasets.workCommon.fields.dueDate"), description: msg("reports:datasets.workCommon.hints.dueDate") },
  overdue: { type: "boolean", label: msg("reports:datasets.workCommon.fields.overdue"), description: msg("reports:datasets.workCommon.hints.overdue") },
  daysOverdue: { type: "number", label: msg("reports:datasets.workCommon.fields.daysOverdue"), description: msg("reports:datasets.workCommon.hints.daysOverdue") },
  daysOpen: { type: "number", label: msg("reports:datasets.workCommon.fields.daysOpen"), description: msg("reports:datasets.workCommon.hints.daysOpen") },
  createdAt: { type: "date", label: msg("reports:datasets.workCommon.fields.createdAt") },
  sentAt: { type: "date", label: msg("reports:datasets.workCommon.fields.sentAt") },
  answeredAt: { type: "date", label: msg("reports:datasets.workCommon.fields.answeredAt") },
  closedAt: { type: "date", label: msg("reports:datasets.workCommon.fields.closedAt") },
  replyRequired: { type: "boolean", label: msg("reports:datasets.workCommon.fields.replyRequired") },
  awaitingReply: { type: "boolean", label: msg("reports:datasets.workCommon.fields.awaitingReply"), description: msg("reports:datasets.workCommon.hints.awaitingReply") },
  deliveryChannel: { type: "string", label: msg("reports:datasets.workCommon.fields.deliveryChannel"), values: CHANNEL_VALUES },
  deliveryStatus: { type: "string", label: msg("reports:datasets.workCommon.fields.deliveryStatus"), values: labelValues("deliveryStatus", DELIVERY_STATUS_LABELS_TR) },
  mailSent: { type: "boolean", label: msg("reports:datasets.workCommon.fields.mailSent") },
  letterLanguage: { type: "string", label: msg("reports:datasets.workCommon.fields.letterLanguage"), values: LETTER_LANGUAGE_LABELS },
  discipline: { type: "string", label: msg("reports:datasets.workCommon.fields.discipline"), description: msg("reports:datasets.workCommon.hints.discipline") },
} satisfies Record<string, DatasetField>;

function common(b: WorkBase): ReportRow {
  return {
    number: b.w.number,
    title: b.w.title,
    type: b.t.name,
    status: b.w.status,
    statusLabel: b.statusLabel,
    isOpen: !b.closed,
    fromCompany: b.fromCompany,
    toCompany: b.toCompanies[0] ?? null,
    toCompanies: b.toCompanies.join(", ") || null,
    ballInCourt: b.ballInCourt,
    assignee: b.assignee,
    createdBy: b.createdBy,
    dueDate: b.dueDate,
    overdue: b.overdue,
    daysOverdue: b.daysOverdue,
    daysOpen: b.daysOpen,
    createdAt: iso(b.w.createdAt),
    sentAt: iso(b.w.sentAt),
    answeredAt: iso(b.answeredAt),
    closedAt: iso(b.w.closedAt),
  };
}

function letterFields(b: WorkBase): ReportRow {
  const letter = b.t.category === "correspondence" ? letterOf(b.w) : null;
  return {
    replyRequired: b.w.replyRequired,
    awaitingReply: b.w.replyRequired && (b.w.status === WORK_STATUS.sent || b.w.status === WORK_STATUS.received),
    deliveryChannel: b.w.delivery?.channel ?? null,
    deliveryStatus: b.w.delivery?.status ?? null,
    mailSent: letter ? !!letter.mailSentAt : null,
    letterLanguage: letter?.language ?? null,
  };
}

const ofCategory = (ctx: ReportContext, cats: WorkCategory[]) => workBase(ctx).then((l) => l.filter((b) => cats.includes(b.t.category)));

// ---- works: every work ----------------------------------------------------------------------------

reportDatasets.register("works", {
  label: msg("reports:datasets.works.label"),
  description: msg("reports:datasets.works.description"),
  module: "works",
  sources: ["works", "workflow", "members"],
  fields: {
    category: { type: "string", label: msg("reports:datasets.works.fields.category"), values: labelValues("workCategory", WORK_CATEGORY_LABELS_TR) },
    ...F,
    discipline: F.discipline,
    parent: { type: "string", label: msg("reports:datasets.works.fields.parent"), description: msg("reports:datasets.works.hints.parent") },
  },
  async load(ctx) {
    return (await workBase(ctx)).map((b) => ({
      category: b.t.category,
      ...common(b),
      assigneeCompany: b.assigneeCompany,
      ...letterFields(b),
      discipline: str(b.w.fields.disiplin),
      parent: b.parent?.number ?? null,
    }));
  },
});

// ---- correspondence -------------------------------------------------------------------------------

// Manage's categories (correspondence, RFIs, submittals, meetings, actions): read-only views of the
// core's works, registered only when Manage is installed (docs/modules/manage.md).
if (moduleInstalled("manage")) {
  reportDatasets.register("correspondence", {
    label: msg("reports:datasets.correspondence.label"),
    description: msg("reports:datasets.correspondence.description"),
    module: "correspondence",
    sources: ["works", "members"],
    fields: {
      number: F.number,
      title: { type: "string", label: msg("reports:datasets.correspondence.fields.title") },
      type: F.type,
      direction: { type: "string", label: msg("reports:datasets.correspondence.fields.direction"), values: DIRECTION_VALUES },
      status: F.status,
      statusLabel: F.statusLabel,
      isOpen: F.isOpen,
      fromCompany: F.fromCompany,
      toCompany: F.toCompany,
      toCompanies: F.toCompanies,
      counterparty: { type: "string", label: msg("reports:datasets.correspondence.fields.counterparty"), description: msg("reports:datasets.correspondence.hints.counterparty") },
      ballInCourt: F.ballInCourt,
      letterDate: { type: "date", label: msg("reports:datasets.correspondence.fields.letterDate") },
      sentAt: F.sentAt,
      answeredAt: F.answeredAt,
      dueDate: F.dueDate,
      overdue: F.overdue,
      daysOverdue: F.daysOverdue,
      daysOpen: F.daysOpen,
      replyRequired: F.replyRequired,
      awaitingReply: F.awaitingReply,
      deliveryChannel: F.deliveryChannel,
      deliveryStatus: F.deliveryStatus,
      mailSent: F.mailSent,
      letterLanguage: F.letterLanguage,
      createdBy: F.createdBy,
    },
    async load(ctx) {
      return (await ofCategory(ctx, ["correspondence"])).map((b) => {
        const day = letterDay(b.w);
        return {
          number: b.w.number,
          title: b.w.title,
          type: b.t.name,
          direction: b.t.settings.incoming ? "gelen" : "giden",
          status: b.w.status,
          statusLabel: b.statusLabel,
          isOpen: !b.closed,
          fromCompany: b.fromCompany,
          toCompany: b.toCompanies[0] ?? null,
          toCompanies: b.toCompanies.join(", ") || null,
          counterparty: b.t.settings.incoming ? b.fromCompany : (b.toCompanies[0] ?? null),
          ballInCourt: b.ballInCourt,
          letterDate: typeof day === "string" ? day : iso(day),
          sentAt: iso(b.w.sentAt),
          answeredAt: iso(b.answeredAt),
          dueDate: b.dueDate,
          overdue: b.overdue,
          daysOverdue: b.daysOverdue,
          daysOpen: b.daysOpen,
          ...letterFields(b),
          createdBy: b.createdBy,
        };
      });
    },
  });

  // ---- rfis -------------------------------------------------------------------------------------------

  reportDatasets.register("rfis", {
    label: msg("reports:datasets.rfis.label"),
    description: msg("reports:datasets.rfis.description"),
    module: "rfi",
    sources: ["works", "workflow", "members"],
    fields: {
      number: F.number,
      title: { type: "string", label: msg("reports:datasets.rfis.fields.title") },
      status: F.status,
      statusLabel: F.statusLabel,
      isOpen: F.isOpen,
      answered: { type: "boolean", label: msg("reports:datasets.rfis.fields.answered") },
      discipline: F.discipline,
      rfiCategory: { type: "string", label: msg("reports:datasets.rfis.fields.rfiCategory"), description: msg("reports:datasets.rfis.hints.rfiCategory") },
      priority: { type: "string", label: msg("reports:datasets.rfis.fields.priority"), description: msg("reports:datasets.rfis.hints.priority") },
      costImpact: { type: "string", label: msg("reports:datasets.rfis.fields.costImpact"), description: msg("reports:datasets.rfis.hints.costImpact") },
      scheduleImpact: { type: "string", label: msg("reports:datasets.rfis.fields.scheduleImpact"), description: msg("reports:datasets.rfis.hints.scheduleImpact") },
      fromCompany: F.fromCompany,
      toCompany: F.toCompany,
      ballInCourt: F.ballInCourt,
      submittedAt: { type: "date", label: msg("reports:datasets.rfis.fields.submittedAt") },
      answeredAt: F.answeredAt,
      dueDate: F.dueDate,
      overdue: F.overdue,
      daysOverdue: F.daysOverdue,
      daysOpen: F.daysOpen,
      revisionCount: { type: "number", label: msg("reports:datasets.rfis.fields.revisionCount") },
      createdBy: F.createdBy,
    },
    async load(ctx) {
      return (await ofCategory(ctx, ["rfi"])).map((b) => ({
        number: b.w.number,
        title: b.w.title,
        status: b.w.status,
        statusLabel: b.statusLabel,
        isOpen: !b.closed,
        answered: !!b.answeredAt || b.w.status === WORK_STATUS.answered,
        discipline: str(b.w.fields.disiplin),
        rfiCategory: str(b.w.fields.kategori),
        priority: str(b.w.fields.oncelik),
        costImpact: str(b.w.fields.maliyet_etkisi),
        scheduleImpact: str(b.w.fields.takvim_etkisi),
        fromCompany: b.fromCompany,
        toCompany: b.toCompanies[0] ?? null,
        ballInCourt: b.ballInCourt,
        submittedAt: iso(b.first?.submittedAt ?? b.w.sentAt),
        answeredAt: iso(b.answeredAt),
        dueDate: b.dueDate,
        overdue: b.overdue,
        daysOverdue: b.daysOverdue,
        daysOpen: b.first || b.w.sentAt ? b.daysOpen : null,
        revisionCount: b.revCount,
        createdBy: b.createdBy,
      }));
    },
  });

  // ---- submittals --------------------------------------------------------------------------------------

  reportDatasets.register("submittals", {
    label: msg("reports:datasets.submittals.label"),
    description: msg("reports:datasets.submittals.description"),
    module: "submittals",
    sources: ["works", "workflow", "members"],
    fields: {
      number: F.number,
      title: F.title,
      status: F.status,
      statusLabel: F.statusLabel,
      isOpen: F.isOpen,
      sectionCode: { type: "string", label: msg("reports:datasets.submittals.fields.sectionCode"), description: msg("reports:datasets.submittals.hints.sectionCode") },
      sectionTitle: { type: "string", label: msg("reports:datasets.submittals.fields.sectionTitle") },
      kind: { type: "string", label: msg("reports:datasets.submittals.fields.kind"), values: KIND_VALUES },
      discipline: F.discipline,
      package: { type: "string", label: msg("reports:datasets.submittals.fields.package"), description: msg("reports:datasets.submittals.hints.package") },
      rev: { type: "number", label: msg("reports:datasets.submittals.fields.rev"), description: msg("reports:datasets.submittals.hints.rev") },
      outcome: { type: "string", label: msg("reports:datasets.submittals.fields.outcome"), values: labelValues("outcome", OUTCOME_LABELS_TR), description: msg("reports:datasets.submittals.hints.outcome") },
      outcomeLabel: { type: "string", label: msg("reports:datasets.submittals.fields.outcomeLabel") },
      decided: { type: "boolean", label: msg("reports:datasets.submittals.fields.decided") },
      submittedAt: { type: "date", label: msg("reports:datasets.submittals.fields.submittedAt"), description: msg("reports:datasets.submittals.hints.submittedAt") },
      decidedAt: { type: "date", label: msg("reports:datasets.submittals.fields.decidedAt") },
      reviewDays: { type: "number", label: msg("reports:datasets.submittals.fields.reviewDays"), description: msg("reports:datasets.submittals.hints.reviewDays") },
      dueDate: F.dueDate,
      overdue: F.overdue,
      daysOverdue: F.daysOverdue,
      ballInCourt: F.ballInCourt,
      fromCompany: F.fromCompany,
      createdBy: F.createdBy,
    },
    async load(ctx) {
      return (await ofCategory(ctx, ["submittal"])).map((b) => {
        const last = b.last;
        const decided = last?.status === "decided";
        const end = decided ? (last!.decidedAt ?? ctx.now) : ctx.now;
        return {
          number: b.w.number,
          title: b.w.title,
          status: b.w.status,
          statusLabel: b.statusLabel,
          isOpen: !b.closed,
          sectionCode: str(b.w.fields.bolum_kodu),
          sectionTitle: str(b.w.fields.bolum_adi),
          kind: submittalKindOf(b.w.fields),
          discipline: str(b.w.fields.disiplin),
          package: b.parent?.number ?? null,
          rev: typeof b.w.data.rev === "number" ? b.w.data.rev : (last?.rev ?? 0),
          outcome: last?.outcome ?? null,
          outcomeLabel: last?.outcomeLabel ?? null,
          decided,
          submittedAt: iso(last?.submittedAt),
          decidedAt: iso(last?.decidedAt),
          reviewDays: last ? Math.max(0, Math.floor((end.getTime() - last.submittedAt.getTime()) / DAY_MS)) : null,
          dueDate: b.dueDate,
          overdue: b.overdue,
          daysOverdue: b.daysOverdue,
          ballInCourt: b.ballInCourt,
          fromCompany: b.fromCompany,
          createdBy: b.createdBy,
        };
      });
    },
  });

  // ---- meetings and actions ----------------------------------------------------------------------------

  reportDatasets.register("meetings", {
    label: msg("reports:datasets.meetings.label"),
    description: msg("reports:datasets.meetings.description"),
    module: "meetings",
    sources: ["works", "members"],
    fields: {
      number: F.number,
      title: F.title,
      kind: { type: "string", label: msg("reports:datasets.meetings.fields.kind"), description: msg("reports:datasets.meetings.hints.kind") },
      date: { type: "date", label: msg("reports:datasets.meetings.fields.date") },
      place: { type: "string", label: msg("reports:datasets.meetings.fields.place") },
      status: F.status,
      statusLabel: F.statusLabel,
      isOpen: F.isOpen,
      attendeeCount: { type: "number", label: msg("reports:datasets.meetings.fields.attendeeCount") },
      presentCount: { type: "number", label: msg("reports:datasets.meetings.fields.presentCount") },
      minutesItemCount: { type: "number", label: msg("reports:datasets.meetings.fields.minutesItemCount") },
      actionCount: { type: "number", label: msg("reports:datasets.meetings.fields.actionCount") },
      openActionCount: { type: "number", label: msg("reports:datasets.meetings.fields.openActionCount") },
      createdBy: F.createdBy,
    },
    async load(ctx) {
      const all = await workBase(ctx);
      const actions = all.filter((b) => b.t.category === "action");
      return all
        .filter((b) => b.t.category === "meeting")
        .map((b) => {
          const data = meetingDataOf(b.w);
          const mine = actions.filter((x) => x.w.parentWorkId === b.w.id);
          return {
            number: b.w.number,
            title: b.w.title,
            kind: str(b.w.fields.tur),
            date: str(b.w.fields.tarih),
            place: str(b.w.fields.yer),
            status: b.w.status,
            statusLabel: b.statusLabel,
            isOpen: !b.closed,
            attendeeCount: data.attendees.length,
            presentCount: data.attendees.filter((x) => x.present).length,
            minutesItemCount: data.minutes.items.length,
            actionCount: mine.length,
            openActionCount: mine.filter((x) => !x.closed).length,
            createdBy: b.createdBy,
          };
        });
    },
  });

  reportDatasets.register("actions", {
    label: msg("reports:datasets.actions.label"),
    description: msg("reports:datasets.actions.description"),
    module: "meetings",
    sources: ["works", "members"],
    fields: {
      number: F.number,
      title: { type: "string", label: msg("reports:datasets.actions.fields.title") },
      status: F.status,
      statusLabel: F.statusLabel,
      isOpen: F.isOpen,
      assignee: { type: "string", label: msg("reports:datasets.actions.fields.assignee") },
      responsibleCompany: { type: "string", label: msg("reports:datasets.actions.fields.responsibleCompany") },
      meeting: { type: "string", label: msg("reports:datasets.actions.fields.meeting") },
      meetingTitle: { type: "string", label: msg("reports:datasets.actions.fields.meetingTitle") },
      meetingDate: { type: "date", label: msg("reports:datasets.actions.fields.meetingDate") },
      dueDate: F.dueDate,
      overdue: F.overdue,
      daysOverdue: F.daysOverdue,
      daysOpen: F.daysOpen,
      createdAt: F.createdAt,
      closedAt: F.closedAt,
    },
    async load(ctx) {
      return (await ofCategory(ctx, ["action"])).map((b) => ({
        number: b.w.number,
        title: b.w.title,
        status: b.w.status,
        statusLabel: b.statusLabel,
        isOpen: !b.closed,
        assignee: b.assignee,
        responsibleCompany: b.toCompanies[0] ?? b.assigneeCompany,
        meeting: b.parent?.number ?? null,
        meetingTitle: b.parent?.title ?? null,
        meetingDate: b.parent ? str(b.parent.fields.tarih) : null,
        dueDate: b.dueDate,
        overdue: b.overdue,
        daysOverdue: b.daysOverdue,
        daysOpen: b.daysOpen,
        createdAt: iso(b.w.createdAt),
        closedAt: iso(b.w.closedAt),
      }));
    },
  });

  // ---- transmittals -------------------------------------------------------------------------------------
}

reportDatasets.register("transmittals", {
  label: msg("reports:datasets.transmittals.label"),
  description: msg("reports:datasets.transmittals.description"),
  module: "transmittals",
  sources: ["works", "members"],
  fields: {
    number: F.number,
    title: F.title,
    purpose: { type: "string", label: msg("reports:datasets.transmittals.fields.purpose"), values: labelValues("transmittalPurpose", TRANSMITTAL_PURPOSE_LABELS_TR) },
    status: F.status,
    statusLabel: F.statusLabel,
    isOpen: F.isOpen,
    fromCompany: F.fromCompany,
    toCompany: F.toCompany,
    toCompanies: F.toCompanies,
    sentAt: F.sentAt,
    received: { type: "boolean", label: msg("reports:datasets.transmittals.fields.received"), description: msg("reports:datasets.transmittals.hints.received") },
    receivedAt: { type: "date", label: msg("reports:datasets.transmittals.fields.receivedAt"), description: msg("reports:datasets.transmittals.hints.receivedAt") },
    fileCount: { type: "number", label: msg("reports:datasets.transmittals.fields.fileCount") },
    deliveryChannel: F.deliveryChannel,
    dueDate: F.dueDate,
    overdue: F.overdue,
    createdBy: F.createdBy,
  },
  async load(ctx) {
    const list = await ofCategory(ctx, ["transmittal"]);
    const ids = list.map((b) => b.w.id);
    const links = ids.length
      ? await ctx.db.select({ workId: workLinks.workId, kind: workLinks.kind }).from(workLinks).where(inArray(workLinks.workId, ids))
      : [];
    const receipts = ids.length ? await ctx.db.select().from(workReceipts).where(inArray(workReceipts.workId, ids)) : [];
    return list.map((b) => {
      const mine = receipts.filter((r) => r.workId === b.w.id).sort((x, y) => x.receivedAt.getTime() - y.receivedAt.getTime());
      return {
        number: b.w.number,
        title: b.w.title,
        purpose: str(b.w.fields.amac),
        status: b.w.status,
        statusLabel: b.statusLabel,
        isOpen: !b.closed,
        fromCompany: b.fromCompany,
        toCompany: b.toCompanies[0] ?? null,
        toCompanies: b.toCompanies.join(", ") || null,
        sentAt: iso(b.w.sentAt),
        received: mine.length > 0,
        receivedAt: iso(mine[0]?.receivedAt),
        fileCount: links.filter((l) => l.workId === b.w.id && l.kind === "file_version").length,
        deliveryChannel: b.w.delivery?.channel ?? null,
        dueDate: b.dueDate,
        overdue: b.overdue,
        createdBy: b.createdBy,
      };
    });
  },
});
