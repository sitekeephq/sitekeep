// i18n-ok-file: built-in work types, statuses and fields are seeded into projects as data (i18n.md §8.2)
/** Work type vocabulary and built-in catalog. */
/** Behaviour family of a type. Built-in logic (reply chains, transmittal cover PDF) keys on this. */
export const WORK_CATEGORIES = [
  "correspondence",
  "transmittal",
  "generic",
  "rfi",
  "submittal",
  "submittal_package",
  "meeting",
  "action",
] as const;
export type WorkCategory = (typeof WORK_CATEGORIES)[number];

export const WORK_CATEGORY_LABELS_TR: Record<WorkCategory, string> = {
  correspondence: "Yazışma",
  transmittal: "Gönderim Formu",
  generic: "Genel İş",
  rfi: "Bilgi Talebi",
  submittal: "Teknik Onay Kalemi",
  submittal_package: "Teknik Onay Paketi",
  meeting: "Toplantı",
  action: "Eylem",
};

export const WORK_FIELD_TYPES = ["text", "textarea", "date", "number", "list", "boolean"] as const;
export type WorkFieldType = (typeof WORK_FIELD_TYPES)[number];

export const WORK_FIELD_TYPE_LABELS_TR: Record<WorkFieldType, string> = {
  text: "Metin",
  textarea: "Uzun Metin",
  date: "Tarih",
  number: "Sayı",
  list: "Liste",
  boolean: "Evet / Hayır",
};

/** One custom field of a work type (JSON-schema-like, kept small on purpose). */
export interface WorkFieldDef {
  /** Stable key in works.fields, e.g. "sayi". */
  key: string;
  label: string;
  type: WorkFieldType;
  required?: boolean;
  /** Choices for "list". */
  options?: string[];
  help?: string;
}

export type WorkTone = "ok" | "info" | "warn" | "danger" | "";

export interface WorkStatusDef {
  key: string;
  label: string;
  tone: WorkTone;
  /** Finished: not shown as open in "Bugün", no due-date warnings. */
  closed?: boolean;
}

/** Status keys the server gives meaning to (sending, receipt, replies). */
export const WORK_STATUS = {
  draft: "taslak",
  sent: "gonderildi",
  received: "alindi",
  answered: "cevaplandi",
  closed: "kapandi",
  open: "acik",
} as const;

export const CORRESPONDENCE_STATUSES: WorkStatusDef[] = [
  { key: "taslak", label: "Taslak", tone: "" },
  { key: "gonderildi", label: "Gönderildi", tone: "info" },
  { key: "alindi", label: "Alındı", tone: "warn" },
  { key: "cevaplandi", label: "Cevaplandı", tone: "ok", closed: true },
  { key: "kapandi", label: "Kapandı", tone: "ok", closed: true },
  { key: "arsivlendi", label: "Arşivlendi", tone: "", closed: true },
  { key: "iptal", label: "İptal", tone: "", closed: true },
];

/** Correspondence: statuses that can be archived, and the end states of "Arşivle" / "İptal et". */
export const LETTER_ARCHIVABLE = ["gonderildi", "alindi", "cevaplandi", "kapandi"] as const;
export const LETTER_STATUS = { archived: "arsivlendi", cancelled: "iptal" } as const;

export const TRANSMITTAL_STATUSES: WorkStatusDef[] = [
  { key: "taslak", label: "Taslak", tone: "" },
  { key: "gonderildi", label: "Gönderildi", tone: "info" },
  { key: "alindi", label: "Alındı", tone: "ok" },
  { key: "kapandi", label: "Kapandı", tone: "ok", closed: true },
];

export const GENERIC_STATUSES: WorkStatusDef[] = [
  { key: "taslak", label: "Taslak", tone: "" },
  { key: "acik", label: "Açık", tone: "warn" },
  { key: "kapandi", label: "Kapandı", tone: "ok", closed: true },
];

export const RFI_STATUSES: WorkStatusDef[] = [
  { key: "taslak", label: "Taslak", tone: "" },
  { key: "acik", label: "Açık", tone: "warn" },
  { key: "cevaplandi", label: "Cevaplandı", tone: "info" },
  { key: "kapandi", label: "Kapalı", tone: "ok", closed: true },
  { key: "iptal", label: "İptal", tone: "", closed: true },
];

export const SUBMITTAL_STATUSES: WorkStatusDef[] = [
  { key: "taslak", label: "Taslak", tone: "" },
  { key: "incelemede", label: "İncelemede", tone: "warn" },
  { key: "onaylandi", label: "Onaylandı", tone: "ok", closed: true },
  { key: "notlu_onay", label: "Notlu Onaylandı", tone: "ok", closed: true },
  { key: "goruldu", label: "Görüldü", tone: "info", closed: true },
  { key: "revize", label: "Revize Et ve Tekrar Gönder", tone: "danger" },
  { key: "reddedildi", label: "Reddedildi", tone: "danger", closed: true },
  { key: "kapandi", label: "Kapandı", tone: "ok", closed: true },
  { key: "iptal", label: "İptal", tone: "", closed: true },
];

export const SUBMITTAL_PACKAGE_STATUSES: WorkStatusDef[] = [
  { key: "taslak", label: "Taslak", tone: "" },
  { key: "incelemede", label: "İncelemede", tone: "warn" },
  { key: "revize", label: "Revize Bekliyor", tone: "danger" },
  { key: "kismen", label: "Kısmen Onaylı", tone: "info" },
  { key: "onaylandi", label: "Onaylandı", tone: "ok", closed: true },
  { key: "reddedildi", label: "Reddedildi", tone: "danger", closed: true },
  { key: "kapandi", label: "Kapandı", tone: "ok", closed: true },
];

export const MEETING_STATUSES: WorkStatusDef[] = [
  { key: "planlandi", label: "Planlandı", tone: "info" },
  { key: "yapildi", label: "Tutanak Hazırlanıyor", tone: "warn" },
  { key: "kapandi", label: "Tutanak Yayınlandı", tone: "ok", closed: true },
  { key: "iptal", label: "İptal", tone: "", closed: true },
];

export const ACTION_STATUSES: WorkStatusDef[] = [
  { key: "acik", label: "Açık", tone: "warn" },
  { key: "kapandi", label: "Kapalı", tone: "ok", closed: true },
];

export function defaultStatuses(category: WorkCategory): WorkStatusDef[] {
  switch (category) {
    case "correspondence":
      return CORRESPONDENCE_STATUSES;
    case "transmittal":
      return TRANSMITTAL_STATUSES;
    case "rfi":
      return RFI_STATUSES;
    case "submittal":
      return SUBMITTAL_STATUSES;
    case "submittal_package":
      return SUBMITTAL_PACKAGE_STATUSES;
    case "meeting":
      return MEETING_STATUSES;
    case "action":
      return ACTION_STATUSES;
    default:
      return GENERIC_STATUSES;
  }
}

export const TRANSMITTAL_PURPOSES = ["bilgi", "onay", "uygulama"] as const;
export type TransmittalPurpose = (typeof TRANSMITTAL_PURPOSES)[number];
export const TRANSMITTAL_PURPOSE_LABELS_TR: Record<TransmittalPurpose, string> = {
  bilgi: "Bilgi için",
  onay: "Onay için",
  uygulama: "Uygulama için",
};

/** Per-type settings that are not fields. */
export interface WorkTypeSettings {
  /** Transmittal cover PDFs are stored here (default: a "Gönderim formları" folder under the root; an older "Transmittaller" folder is reused). */
  coverFolderId?: string | null;
  /** Type key used by "Cevap yaz" (default: giden-yazi). */
  replyTypeKey?: string | null;
  /** Incoming registrations: the letter comes from outside, so "send" is not offered. */
  incoming?: boolean;
  /** RFI / submittal: the answer is due this many calendar days after submitting (sets the due date). */
  dueDays?: number | null;
  /** Status a work gets when it is submitted to its workflow (default "acik" for RFI, "incelemede" otherwise). */
  submittedStatus?: string | null;
  /** Status per final outcome kind when the work's workflow completes (approved, info, revise…). */
  outcomeStatus?: Partial<Record<"approved" | "approved_with_comments" | "info" | "revise" | "rejected", string>> | null;
  /** Built-in types: field ("f:key") and status ("s:key") keys already offered by the seeder (internal). */
  seededKeys?: string[];
  /** Built-in types: the name the seeder last gave the type (internal); a different name is the admin's own. */
  seededName?: string;
  /**
   * Built-in types: the field ("f:key") and status ("s:key") labels the seeder last gave (internal).
   * A stored label that differs from it is the admin's own and is never upgraded.
   */
  seededLabels?: Record<string, string>;
}

export interface WorkTypeDto {
  id: string;
  projectId: string;
  key: string;
  name: string;
  category: WorkCategory;
  /** e.g. "{Proje}-{Gönderen}-{Alıcı}-{YYYY}-{0000}". */
  numberingPattern: string;
  /** Types with the same group share counters (e.g. letters and transmittals). Null = own counter. */
  counterGroup: string | null;
  fields: WorkFieldDef[];
  statuses: WorkStatusDef[];
  settings: WorkTypeSettings;
  defaultWorkflowTemplateId: string | null;
  icon: string | null;
  color: string | null;
  builtIn: boolean;
  archived: boolean;
}

// ---- Built-in types -------------------------------------------------------------------------

export interface BuiltInWorkType {
  key: string;
  name: string;
  category: WorkCategory;
  /** Default: defaultStatuses(category). */
  statuses?: WorkStatusDef[];
  numberingPattern: string;
  counterGroup: string | null;
  fields: WorkFieldDef[];
  settings: WorkTypeSettings;
  icon: string;
  color: string;
}

const LETTER_FIELDS: WorkFieldDef[] = [
  { key: "tarih", label: "Yazı Tarihi", type: "date" },
  { key: "konu", label: "Konu", type: "textarea" },
  { key: "ozet", label: "Özet / Not", type: "textarea" },
  { key: "proje_kodu", label: "Proje Kodu", type: "text", help: "İşverenin proje kodu, ör. P.87.1019" },
  { key: "seri", label: "Yazı Serisi", type: "text", help: "ör. L25" },
  { key: "departman", label: "Departman", type: "text" },
  { key: "sube", label: "Şube", type: "text" },
];

export const BUILT_IN_WORK_TYPES: BuiltInWorkType[] = [
  {
    key: "gelen-yazi",
    name: "Gelen Yazı",
    category: "correspondence",
    numberingPattern: "{Proje}-GLN-{YYYY}-{0000}",
    counterGroup: null,
    fields: [
      { key: "sayi", label: "Gönderenin Sayısı", type: "text", help: "Yazının üzerindeki sayı (ör. E-12345678-000-1234)" },
      ...LETTER_FIELDS,
    ],
    settings: { incoming: true, replyTypeKey: "giden-yazi" },
    icon: "📥",
    color: "#1f4e79",
  },
  {
    key: "giden-yazi",
    name: "Giden Yazı",
    category: "correspondence",
    numberingPattern: "{Proje}-{Gönderen}-{Alıcı}-{YYYY}-{0000}",
    counterGroup: "yazi",
    fields: [
      { key: "belge_no", label: "Belge No", type: "text", help: "Yazının belge numarası; resmi yazı PDF'inde Belge No olarak basılır" },
      ...LETTER_FIELDS,
    ],
    settings: { replyTypeKey: "giden-yazi" },
    icon: "📤",
    color: "#18794e",
  },
  {
    key: "transmittal",
    name: "Gönderim Formu",
    category: "transmittal",
    numberingPattern: "{Proje}-GF-{Gönderen}-{YYYY}-{0000}",
    counterGroup: null,
    fields: [
      { key: "amac", label: "Amaç", type: "list", options: [...TRANSMITTAL_PURPOSES], required: true },
      { key: "not", label: "Not", type: "textarea" },
    ],
    settings: {},
    icon: "📦",
    color: "#9a6700",
  },
];
