/**
 * ISO 19650 information delivery plans (ISO-7, docs/features/DELIVERY_PLAN.md): a task information
 * delivery plan (TIDP) per task team, aggregated into the master information delivery plan (MIDP)
 * with project milestones (ISO 19650-2 §5.4.3–§5.4.5). Shared by the server and the web app: the
 * DTOs, the status of a planned deliverable computed from the CDE states of its document, the late
 * rule and the cell formats of the XLSX / CSV import and export.
 */
import type { CdeState } from "./cde.js";

/** Status of a planned deliverable, in order: what the CDE holds for its document code. */
export const DELIVERABLE_STATUSES = ["not_started", "wip", "shared", "published"] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

/** The state a due date asks for: Shared (for coordination) or Published (for acceptance). */
export type DeliverableDueState = "shared" | "published";

export interface DeliveryMilestoneDto {
  id: string;
  /** Short code ("M1"), optional. */
  code: string | null;
  name: string;
  /** YYYY-MM-DD, or null when not dated yet. */
  dueDate: string | null;
  position: number;
}

/** The planned revision and suitability of a deliverable at a milestone. */
export interface DeliverableTargetDto {
  milestoneId: string;
  suitabilityCode: string | null;
  revisionCode: string | null;
}

/** The document a deliverable is matched to (its most advanced file in the CDE). */
export interface DeliverableDocumentDto {
  state: CdeState | null;
  suitabilityCode: string | null;
  revisionCode: string | null;
  /** Left out when the caller cannot see the file (folder permissions, task-team WIP). */
  fileId?: string;
  folderId?: string;
  name?: string;
}

export interface DeliverableDto {
  id: string;
  teamId: string | null;
  teamName: string | null;
  code: string;
  title: string;
  discipline: string | null;
  docType: string | null;
  targets: DeliverableTargetDto[];
  dueShared: string | null;
  duePublished: string | null;
  notes: string | null;
  status: DeliverableStatus;
  /** The due date that passed without the deliverable reaching its state, or null. */
  late: DeliverableDueState | null;
  /** True when a document code register entry exists for the code. */
  registered: boolean;
  document: DeliverableDocumentDto | null;
  /** The caller may edit or delete the row (project administrator or the team's lead). */
  canEdit: boolean;
}

export interface DeliveryPlanTeamDto {
  id: string;
  name: string;
  code: string | null;
  isLead: boolean;
  leadUserId: string | null;
  leadName: string | null;
  /** The caller may add rows to this team's TIDP. */
  canEdit: boolean;
  /** Rows of the TIDP. */
  count: number;
  late: number;
}

export interface DeliveryPlanDto {
  milestones: DeliveryMilestoneDto[];
  /** Teams whose TIDP the caller sees (every team for project administrators). */
  teams: DeliveryPlanTeamDto[];
  deliverables: DeliverableDto[];
  /** Project administrator: sees the whole MIDP, edits milestones and leads. */
  canManage: boolean;
  /** The date the late rule used (server day, YYYY-MM-DD). */
  today: string;
}

/** Body of a deliverable create / update. */
export interface DeliverableInput {
  teamId: string;
  code: string;
  title: string;
  discipline?: string | null;
  docType?: string | null;
  targets?: DeliverableTargetDto[];
  dueShared?: string | null;
  duePublished?: string | null;
  notes?: string | null;
}

export interface DeliveryMilestoneInput {
  code?: string | null;
  name: string;
  dueDate?: string | null;
  position?: number;
}

/**
 * The optional `deliveryPlan` block of a project template: milestones seeded into new projects.
 * `offsetDays` dates a milestone that many days after the project is created; without it the
 * milestone has no date until an administrator sets one.
 */
export interface TemplateDeliveryPlan {
  milestones: { code?: string; name: string; offsetDays?: number }[];
}

/** Result of an import (dry run or applied). */
export interface DeliveryPlanImportReportDto {
  applied: boolean;
  created: number;
  updated: number;
  unchanged: number;
  /** Row numbers are spreadsheet rows (the header is row 1). */
  errors: { row: number; message: string }[];
}

const RANK: Record<DeliverableStatus, number> = { not_started: 0, wip: 1, shared: 2, published: 3 };

/** Rank of a status: not started 0, WIP 1, Shared 2, Published 3. */
export function deliverableRank(status: DeliverableStatus): number {
  return RANK[status];
}

/**
 * Status a document file gives: its folder's CDE state. An Archived publication was published; a
 * withdrawn Shared copy counts as WIP (its original went back to the team); a file outside the CDE
 * states counts as WIP (it exists but was not shared).
 */
export function fileDeliverableStatus(state: CdeState | null, flag?: string | null): DeliverableStatus {
  if (state === "published" || state === "archived") return "published";
  if (state === "shared") return flag === "withdrawn" ? "wip" : "shared";
  return "wip";
}

/** Status of a deliverable: the most advanced of its files; not started without any. */
export function deliverableStatus(files: readonly { state: CdeState | null; flag?: string | null }[]): DeliverableStatus {
  let best: DeliverableStatus = "not_started";
  for (const f of files) {
    const s = fileDeliverableStatus(f.state, f.flag);
    if (RANK[s] > RANK[best]) best = s;
  }
  return best;
}

/**
 * Late: a due date before `today` and the status below the state it asks for. Published is checked
 * first (the later commitment); a deliverable without due dates is never late.
 */
export function deliverableLate(
  status: DeliverableStatus,
  due: { dueShared: string | null; duePublished: string | null },
  today: string,
): DeliverableDueState | null {
  if (due.duePublished && due.duePublished < today && RANK[status] < RANK.published) return "published";
  if (due.dueShared && due.dueShared < today && RANK[status] < RANK.shared) return "shared";
  return null;
}

/** YYYY-MM-DD of a date in UTC. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDay(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return isoDay(date);
}

/**
 * A date cell of an imported plan as YYYY-MM-DD: "2027-03-31", "31.03.2027", "31/03/2027", or an
 * Excel serial day number ("46477"). Empty → null; anything else → undefined (invalid).
 */
export function parsePlanDate(raw: string | number | null | undefined): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let m = ISO_DAY.exec(s.slice(0, 10));
  if (m && (s.length === 10 || /^T|^ /.test(s.slice(10)))) return validDay(Number(m[1]), Number(m[2]), Number(m[3])) ?? undefined;
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
  if (m) return validDay(Number(m[3]), Number(m[2]), Number(m[1])) ?? undefined;
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    // Excel serial: day 25569 is 1970-01-01 (the 1900 leap-year bug is before any plan date).
    const n = Math.floor(Number(s));
    if (n > 25569 && n < 80000) return isoDay(new Date((n - 25569) * 86_400_000));
  }
  return undefined;
}

/** True for a valid YYYY-MM-DD. */
export function isPlanDate(s: string): boolean {
  const m = ISO_DAY.exec(s);
  return !!m && validDay(Number(m[1]), Number(m[2]), Number(m[3])) === s;
}

/** A milestone target cell: "S2 / P01", "S2", "/ P01" or "" (codes as written; normalised by the caller). */
export function formatPlanTarget(t: { suitabilityCode: string | null; revisionCode: string | null } | null | undefined): string {
  if (!t || (!t.suitabilityCode && !t.revisionCode)) return "";
  if (!t.revisionCode) return t.suitabilityCode!;
  return `${t.suitabilityCode ?? ""} / ${t.revisionCode}`.trim();
}

/** Reads a milestone target cell written by formatPlanTarget ("S2 / P01", "S2/P01", "S2 P01", "S2"). */
export function parsePlanTarget(raw: string | null | undefined): { suitabilityCode: string | null; revisionCode: string | null } | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const parts = s.includes("/") ? s.split("/") : s.split(/\s+/);
  const suitability = parts[0]?.trim() || null;
  const revision = parts.slice(1).join(" ").trim() || null;
  if (!suitability && !revision) return null;
  return { suitabilityCode: suitability, revisionCode: revision };
}

/** Columns of the plan export and import, in order (milestone target columns follow `docType`). */
export const DELIVERY_PLAN_COLUMNS = ["code", "title", "team", "discipline", "docType", "dueShared", "duePublished", "notes", "status", "late", "document"] as const;
export type DeliveryPlanColumn = (typeof DELIVERY_PLAN_COLUMNS)[number];

/** Columns read on import (the others are information only). */
export const DELIVERY_PLAN_IMPORT_COLUMNS = ["code", "title", "team", "discipline", "docType", "dueShared", "duePublished", "notes"] as const satisfies readonly DeliveryPlanColumn[];
export type DeliveryPlanImportColumn = (typeof DELIVERY_PLAN_IMPORT_COLUMNS)[number];

/**
 * Header names the import recognises besides the exported ones, lower-cased (English and Turkish),
 * so a plan typed by hand reads too.
 */
export const DELIVERY_PLAN_HEADER_ALIASES: Record<DeliveryPlanImportColumn, string[]> = {
  code: ["code", "document code", "planned document code", "kod", "doküman kodu", "belge kodu", "planlanan doküman kodu"],
  title: ["title", "name", "document title", "başlık", "ad", "doküman adı", "belge adı"],
  team: ["team", "task team", "responsible team", "ekip", "görev ekibi", "sorumlu ekip"],
  discipline: ["discipline", "role", "disiplin", "rol"],
  docType: ["type", "document type", "doc type", "tip", "tür", "doküman tipi", "belge türü"],
  dueShared: ["due shared", "shared due", "due for shared", "paylaşım tarihi", "paylaşılan teslim", "paylaşım teslim tarihi"],
  duePublished: ["due published", "published due", "due for published", "yayın tarihi", "yayınlanan teslim", "yayın teslim tarihi"],
  notes: ["notes", "note", "remarks", "notlar", "not", "açıklama"],
};

/** Lower-cased header text for matching ("Due Shared " → "due shared"; Turkish İ / ı read as i). */
export function planHeaderKey(s: string): string {
  return s.normalize("NFC").replace(/[İIı]/g, "i").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Header of a milestone's target column: "M1 · Concept design", or the name alone. */
export function milestoneHeader(m: Pick<DeliveryMilestoneDto, "code" | "name">): string {
  return m.code ? `${m.code} · ${m.name}` : m.name;
}

/** The milestone a header names (its column header, code or name), or undefined. */
export function milestoneOfHeader<M extends Pick<DeliveryMilestoneDto, "code" | "name">>(header: string, milestones: readonly M[]): M | undefined {
  const h = planHeaderKey(header);
  if (!h) return undefined;
  return milestones.find((m) => [milestoneHeader(m), m.name, m.code ?? ""].some((x) => x && planHeaderKey(x) === h));
}
