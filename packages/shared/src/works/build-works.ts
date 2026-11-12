// i18n-ok-file: build-phase work types, fields, presets and outcome options are seeded into projects as data (i18n.md §8.2)
/**
 * Build-phase work types on top of "İşler": RFI, submittal item, submittal package, meeting and
 * action. They are ordinary work types (seeded per project, editable in Proje ayarları → İş
 * tipleri); this file holds their default fields, numbering presets and the DTOs of the extras
 * (workflow chain, revisions, minutes, registers).
 */
import { foldTr } from "../kernel/attributes.js";
import { titleCaseTr } from "../kernel/title-case.js";
import type { OutcomeKind, OutcomeOption } from "../workflow/review-chains.js";
import type { OutcomeCode, WorkflowStatus } from "../workflow/workflow.js";
import { BUILT_IN_WORK_TYPES, type BuiltInWorkType, type WorkCategory, type WorkFieldDef, type WorkTypeSettings } from "./work-catalog.js";
import { listCode } from "./work-numbering.js";
import type { WorkFieldValues } from "./work-fields.js";
import type { WorkSummaryDto } from "./work-summary.js";

// ---- Vocabulary -------------------------------------------------------------------------------

export const DISCIPLINE_OPTIONS = [
  "G - Genel",
  "A - Mimari",
  "S - Statik",
  "M - Mekanik",
  "E - Elektrik",
  "I - Altyapı",
  "H - Harita",
  "Z - Zemin",
  "P - Peyzaj",
];

export const RFI_CATEGORIES = ["Tasarım Koordinasyonu", "Saha Uygulaması", "Malzeme", "Diğer"];

export const RFI_PRIORITIES = ["Düşük", "Normal", "Yüksek", "Acil"];

export const IMPACT_OPTIONS = ["Yok", "Var", "Belirsiz"];

/** Submittal kinds (ZAVM "bölüm"). BAS is for information only: the only answer is "Görüldü". */
export const SUBMITTAL_KINDS: { code: string; label: string }[] = [
  { code: "MOS", label: "Malzeme Onay" },
  { code: "NUM", label: "Numune" },
  { code: "UCZ", label: "Uygulama / Atölye Çizimi" },
  { code: "YB", label: "Yöntem Beyanı" },
  { code: "IP", label: "İş Programı" },
  { code: "ISG", label: "İSG" },
  { code: "TR", label: "Teknik Rapor" },
  { code: "PMR", label: "Periyodik Muayene" },
  { code: "KS", label: "Kalite" },
  { code: "IKOF", label: "İmalat Kontrol Onay Formu" },
  { code: "BAS", label: "Bilgi Amaçlı" },
  { code: "MKF", label: "Saha Malzeme Kabul" },
];

export const SUBMITTAL_KIND_OPTIONS = SUBMITTAL_KINDS.map((k) => `${k.code} - ${k.label}`);

export const INFO_ONLY_SUBMITTAL_KIND = "BAS";

export const MEETING_KINDS = ["Koordinasyon", "İlerleme", "İSG", "Tasarım", "BIM", "Kalite", "Diğer"];

/** Built-in type keys. */
export const BUILD_TYPE_KEYS = {
  rfi: "rfi",
  submittal: "submittal-kalemi",
  package: "submittal-paketi",
  meeting: "toplanti",
  action: "aksiyon",
} as const;

// ---- Built-in types ---------------------------------------------------------------------------

const RFI_FIELDS: WorkFieldDef[] = [
  { key: "soru", label: "Soru", type: "textarea", required: true },
  { key: "kategori", label: "Kategori", type: "list", options: RFI_CATEGORIES, required: true },
  { key: "disiplin", label: "Disiplin", type: "list", options: DISCIPLINE_OPTIONS, required: true },
  { key: "oncelik", label: "Öncelik", type: "list", options: RFI_PRIORITIES, required: true },
  { key: "maliyet_etkisi", label: "Maliyet Etkisi", type: "list", options: IMPACT_OPTIONS, required: true },
  { key: "takvim_etkisi", label: "Takvim Etkisi", type: "list", options: IMPACT_OPTIONS, required: true },
  { key: "onerilen_cozum", label: "Önerilen Çözüm", type: "textarea" },
  { key: "model_elemanlari", label: "İlgili Model Elemanları", type: "text", help: "Eleman kimlikleri / GUID; paftaları ilgi olarak bağlayın" },
  { key: "resmi_cevap", label: "Resmi Cevap", type: "textarea", help: "Cevap verilince akıştan dolar" },
];

const SUBMITTAL_FIELDS: WorkFieldDef[] = [
  { key: "bolum_kodu", label: "Şartname Bölüm Kodu", type: "text", help: "Şartname bölümü, ör. 05 12 00" },
  { key: "bolum_adi", label: "Şartname Bölüm Adı", type: "text" },
  { key: "tur", label: "Tür", type: "list", options: SUBMITTAL_KIND_OPTIONS, required: true },
  { key: "disiplin", label: "Disiplin", type: "list", options: DISCIPLINE_OPTIONS, required: true },
  { key: "aciklama", label: "Açıklama", type: "textarea" },
  { key: "sayfa", label: "Şartname Sayfası", type: "text" },
  { key: "alinti", label: "Şartname Alıntısı", type: "textarea" },
];

const PACKAGE_FIELDS: WorkFieldDef[] = [
  { key: "bolum", label: "Bölüm", type: "text", required: true, help: "Tür kodu (MOS, UCZ…) ya da şartname bölüm kodu" },
  { key: "disiplin", label: "Disiplin", type: "list", options: DISCIPLINE_OPTIONS, required: true },
  { key: "aciklama", label: "Açıklama", type: "textarea" },
];

const MEETING_FIELDS: WorkFieldDef[] = [
  { key: "tur", label: "Toplantı Türü", type: "list", options: MEETING_KINDS, required: true },
  { key: "tarih", label: "Tarih", type: "date", required: true },
  { key: "saat", label: "Saat", type: "text", help: "ör. 10:00" },
  { key: "yer", label: "Yer", type: "text" },
  { key: "cevrimici", label: "Çevrimiçi Bağlantı", type: "text" },
];

const ACTION_FIELDS: WorkFieldDef[] = [
  { key: "aciklama", label: "Açıklama", type: "textarea" },
  { key: "karar", label: "Karar", type: "textarea" },
];

export const RFI_OUTCOME_STATUS: NonNullable<WorkTypeSettings["outcomeStatus"]> = {
  approved: "cevaplandi",
  approved_with_comments: "cevaplandi",
  info: "cevaplandi",
  revise: "taslak",
  rejected: "iptal",
};

export const SUBMITTAL_OUTCOME_STATUS: NonNullable<WorkTypeSettings["outcomeStatus"]> = {
  approved: "onaylandi",
  approved_with_comments: "notlu_onay",
  info: "goruldu",
  revise: "revize",
  rejected: "reddedildi",
};

export const BUILD_WORK_TYPES: BuiltInWorkType[] = [
  {
    key: BUILD_TYPE_KEYS.rfi,
    name: "Bilgi Talebi",
    category: "rfi",
    numberingPattern: "{Gönderen}_{Alıcı}_{Disiplin}_BT_{000}",
    counterGroup: "rfi",
    fields: RFI_FIELDS,
    settings: { dueDays: 7, submittedStatus: "acik", outcomeStatus: RFI_OUTCOME_STATUS },
    icon: "❓",
    color: "#8250df",
  },
  {
    key: BUILD_TYPE_KEYS.submittal,
    name: "Teknik Onay Kalemi",
    category: "submittal",
    numberingPattern: "{Gönderen}_{Tür}_{Disiplin}_{0000}",
    counterGroup: null,
    fields: SUBMITTAL_FIELDS,
    settings: { dueDays: 14, submittedStatus: "incelemede", outcomeStatus: SUBMITTAL_OUTCOME_STATUS },
    icon: "🧾",
    color: "#0969da",
  },
  {
    key: BUILD_TYPE_KEYS.package,
    name: "Teknik Onay Paketi",
    category: "submittal_package",
    numberingPattern: "{Bölüm}-{00} {Disiplin}",
    counterGroup: null,
    fields: PACKAGE_FIELDS,
    settings: {},
    icon: "🗂",
    color: "#1a7f37",
  },
  {
    key: BUILD_TYPE_KEYS.meeting,
    name: "Toplantı",
    category: "meeting",
    numberingPattern: "{Proje}-TPL-{YYYY}-{000}",
    counterGroup: null,
    fields: MEETING_FIELDS,
    settings: {},
    icon: "👥",
    color: "#bc4c00",
  },
  {
    key: BUILD_TYPE_KEYS.action,
    name: "Eylem",
    category: "action",
    numberingPattern: "{Proje}-EYL-{0000}",
    counterGroup: null,
    fields: ACTION_FIELDS,
    settings: {},
    icon: "✅",
    color: "#57606a",
  },
];

/** Every type seeded into a project. */
export const ALL_BUILT_IN_WORK_TYPES: BuiltInWorkType[] = [...BUILT_IN_WORK_TYPES, ...BUILD_WORK_TYPES];

/**
 * Earlier names of built-in types (by key). A project whose type still carries one of these (or
 * the name the seeder last gave it) gets the current built-in name; a name the admin chose stays.
 * Sentence-case names ("Gelen yazı") became Title Case ("Gelen Yazı") on 10.10.2026.
 */
export const BUILT_IN_WORK_TYPE_OLD_NAMES: Record<string, string[]> = {
  "gelen-yazi": ["Gelen yazı"],
  "giden-yazi": ["Giden yazı"],
  transmittal: ["Transmittal", "Gönderim formu"],
  [BUILD_TYPE_KEYS.rfi]: ["RFI", "Bilgi talebi"],
  [BUILD_TYPE_KEYS.submittal]: ["Submittal kalemi", "Teknik onay kalemi"],
  [BUILD_TYPE_KEYS.package]: ["Submittal paketi", "Teknik onay paketi"],
  [BUILD_TYPE_KEYS.action]: ["Aksiyon"],
};

/**
 * Seed upgrade of a stored default label (type name, field or status label): true when `stored`
 * may be replaced by the current built-in label `current`. The label must still be the one the
 * seeder gave: `remembered` (settings.seededName / seededLabels) when the project has it, else one
 * of the known earlier defaults or the same words in other letter case (the sentence-case labels
 * seeded before 10.10.2026: "Yazı tarihi" → "Yazı Tarihi"). A label the admin changed stays.
 */
export function isSeededDefaultLabel(stored: string, current: string, remembered: string | undefined, earlier: readonly string[] = []): boolean {
  if (stored === current) return false;
  if (remembered !== undefined) return stored === remembered;
  return earlier.includes(stored) || titleCaseTr(stored) === current;
}

/** Project-level numbering presets for RFIs and submittal items (ZAVM = earlier Forma setup). */
export const BUILD_NUMBERING_PRESETS = {
  standart: {
    label: "Standart",
    patterns: {
      [BUILD_TYPE_KEYS.rfi]: "{Gönderen}_{Alıcı}_{Disiplin}_BT_{000}",
      [BUILD_TYPE_KEYS.submittal]: "{Gönderen}_{Tür}_{Disiplin}_{0000}",
    } as Record<string, string>,
  },
  zavm: {
    label: "ZAVM (PAS_CNS_{D}_RFI_{001}_{Konu})",
    patterns: {
      [BUILD_TYPE_KEYS.rfi]: "{Proje}_{Gönderen}_{Disiplin}_RFI_{000}_{Konu}",
      [BUILD_TYPE_KEYS.submittal]: "{Proje}_{Tür}_{Disiplin}_{0000}_{Konu}",
    } as Record<string, string>,
  },
} as const;

export type BuildNumberingPreset = keyof typeof BUILD_NUMBERING_PRESETS;

// ---- Outcomes -----------------------------------------------------------------------------------

/** One-step answer used when a type has no default workflow template. */
export const RFI_ANSWER_OPTIONS: OutcomeOption[] = [
  { code: "CEVAP", label: "Cevaplandı", kind: "info" },
  { code: "IADE", label: "Netleştirme Gerekli (iade)", kind: "revise" },
];

export const SUBMITTAL_ANSWER_OPTIONS: OutcomeOption[] = [
  { code: "approved", label: "Onaylandı", kind: "approved" },
  { code: "approved_with_comments", label: "Notlu Onaylandı", kind: "approved_with_comments" },
  { code: "revise_resubmit", label: "Revize Et ve Tekrar Gönder", kind: "revise" },
  { code: "rejected", label: "Reddedildi", kind: "rejected" },
];

export const INFO_ONLY_OPTION: OutcomeOption = { code: "reviewed", label: "Görüldü", kind: "info" };

/** The submittal kind code of an item ("BAS - Bilgi Amaçlı" → "BAS"). */
export function submittalKindOf(fields: WorkFieldValues): string | null {
  const v = fields.tur;
  return typeof v === "string" && v.trim() ? listCode(v).toLocaleUpperCase("tr-TR") : null;
}

export function isInfoOnlySubmittal(fields: WorkFieldValues): boolean {
  return submittalKindOf(fields) === INFO_ONLY_SUBMITTAL_KIND;
}

/**
 * Answers allowed on a work: the step's options, narrowed for information-only submittals (BAS)
 * to "info" kinds (or a plain "Görüldü" when the step has none).
 */
export function allowedWorkOptions(options: readonly OutcomeOption[], category: WorkCategory, fields: WorkFieldValues): OutcomeOption[] {
  if (category === "submittal" && isInfoOnlySubmittal(fields)) {
    const info = options.filter((o) => o.kind === "info");
    return info.length ? info : [INFO_ONLY_OPTION];
  }
  return [...options];
}

/** Package status from its items' statuses. */
export function rollupPackageStatus(itemStatuses: readonly string[]): string {
  const done = new Set(["onaylandi", "notlu_onay", "goruldu", "kapandi"]);
  const list = itemStatuses.filter((s) => s !== "iptal");
  if (!list.length) return "taslak";
  if (list.some((s) => s === "incelemede")) return "incelemede";
  if (list.some((s) => s === "revize")) return "revize";
  if (list.every((s) => done.has(s))) return "onaylandi";
  if (list.every((s) => s === "reddedildi")) return "reddedildi";
  if (list.some((s) => done.has(s))) return "kismen";
  return "taslak";
}

// ---- Meetings -----------------------------------------------------------------------------------

export interface MeetingAttendee {
  /** Project member, or free text for external people. */
  userId?: string | null;
  name?: string | null;
  companyId?: string | null;
  /** Free-text company of an external attendee. */
  companyText?: string | null;
  present?: boolean;
}

export interface MeetingAgendaItem {
  text: string;
  note?: string | null;
}

/** One minutes line: decision and, with a responsible party or a due date, an action. */
export interface MinutesItem {
  id: string;
  konu: string;
  karar?: string | null;
  sorumluUserId?: string | null;
  sorumluCompanyId?: string | null;
  termin?: string | null;
  /** Child work of type "Eylem" (key "aksiyon") created from this line. */
  actionWorkId?: string | null;
}

export interface MeetingData {
  attendees: MeetingAttendee[];
  agenda: MeetingAgendaItem[];
  minutes: { items: MinutesItem[]; notes?: string | null; updatedAt?: string | null };
  /** Open actions of earlier meetings carried over to this one. */
  carriedActionIds?: string[];
  previousMeetingId?: string | null;
  nextMeetingId?: string | null;
}

export function emptyMeetingData(): MeetingData {
  return { attendees: [], agenda: [], minutes: { items: [] } };
}

// ---- DTOs ---------------------------------------------------------------------------------------

export interface WorkAnswerDto {
  userId: string;
  userName?: string;
  code: string;
  label: string;
  kind: OutcomeKind;
  comment: string | null;
  /** Official response text (RFI). */
  response: string | null;
  /** Teams / companies the answer counts for. */
  onBehalfOf: string[];
  at: string;
}

export interface WorkFlowStepDto {
  index: number;
  name: string;
  /** Display names of the assignees (users, companies, teams). */
  assignees: string[];
  rule: "any" | "all";
  state: "done" | "current" | "pending" | "returned" | "skipped";
  dueAt: string | null;
  overdue: boolean;
  answers: WorkAnswerDto[];
  result: { code: string; label: string; kind: OutcomeKind } | null;
}

export interface WorkFlowDto {
  instanceId: string;
  revisionId: string;
  rev: number;
  status: WorkflowStatus;
  stepIndex: number;
  templateName: string;
  steps: WorkFlowStepDto[];
  /** The caller can answer the current step. */
  canAct: boolean;
  /** Answers the caller may give (BAS → "Görüldü" only). */
  options: OutcomeOption[];
  /** Teams / companies the caller's answer will count for. */
  actingFor: string[];
  /** RFI: an official response text is required with an answer. */
  needsResponse: boolean;
}

export interface WorkRevisionDto {
  id: string;
  rev: number;
  status: "running" | "decided" | "cancelled";
  submittedAt: string;
  submittedBy: string;
  submittedByName?: string;
  comment: string | null;
  decidedAt: string | null;
  outcome: OutcomeCode | null;
  outcomeKind: OutcomeKind | null;
  outcomeLabel: string | null;
  response: string | null;
  attachments: { versionId: string; name: string; version: number }[];
  steps: WorkFlowStepDto[];
}

export interface WorkBuildDto {
  category: WorkCategory;
  /** Current revision number (0 for the first submission). */
  rev: number;
  /** Companies that have to act now (current step assignees, or the submitter when it came back). */
  ballInCourt: string[];
  canSubmit: boolean;
  canRevise: boolean;
  canCancel: boolean;
  workflow: WorkFlowDto | null;
  revisions: WorkRevisionDto[];
  officialResponse: string | null;
  /** Items of a package, actions of a meeting. */
  children: WorkSummaryDto[];
  parent: WorkSummaryDto | null;
  meeting: MeetingData | null;
  /** Actions carried over from earlier meetings. */
  carried: WorkSummaryDto[];
}

export interface SubmittalRegisterRowDto {
  id: string;
  number: string;
  title: string;
  status: string;
  statusLabel: string;
  statusTone: string;
  closed: boolean;
  overdue: boolean;
  sectionCode: string | null;
  sectionTitle: string | null;
  kind: string | null;
  kindLabel: string | null;
  discipline: string | null;
  packageId: string | null;
  packageNumber: string | null;
  rev: number;
  dueDate: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  outcomeLabel: string | null;
  /** Company names. */
  ballInCourt: string[];
  from: string | null;
}

export interface RfiLogRowDto {
  id: string;
  number: string;
  title: string;
  status: string;
  statusLabel: string;
  statusTone: string;
  closed: boolean;
  category: string | null;
  discipline: string | null;
  priority: string | null;
  costImpact: string | null;
  scheduleImpact: string | null;
  from: string | null;
  to: string[];
  createdAt: string;
  submittedAt: string | null;
  answeredAt: string | null;
  dueDate: string | null;
  overdue: boolean;
  /** Days from submission to the answer (or to today while open). */
  daysOpen: number | null;
  ballInCourt: string[];
  response: string | null;
}

/** AI: an action suggested from free-text minutes (never created automatically). */
export interface ActionSuggestionDto {
  konu: string;
  karar: string | null;
  sorumluUserId: string | null;
  sorumluCompanyId: string | null;
  /** Responsible as written in the text when it matched nobody. */
  sorumluText: string | null;
  termin: string | null;
}

/** AI: suggested RFI fields from a short description. */
export interface RfiDraftDto {
  title: string;
  fields: WorkFieldValues;
  notes: string[];
}

// ---- Matching helpers -----------------------------------------------------------------------------

/** Option of a list matching a code or a label ("m", "Mekanik", "M - Mekanik" → "M - Mekanik"). */
export function matchListOption(options: readonly string[], value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  const f = foldTr(v);
  return (
    options.find((o) => foldTr(o) === f) ??
    options.find((o) => foldTr(listCode(o)) === f) ??
    options.find((o) => {
      const label = o.includes(" - ") ? o.slice(o.indexOf(" - ") + 3) : o;
      return foldTr(label) === f;
    }) ??
    null
  );
}
