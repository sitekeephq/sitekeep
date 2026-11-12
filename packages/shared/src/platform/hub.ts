/**
 * The simple project screen (docs/product/SADELESTIRME.md, 1. aşama): the "İşler" hub views, the user's
 * saved views and the project "Bugün" page.
 */
import type { MyTaskDto } from "../workflow/workflow.js";

/**
 * Views of the İşler hub. Work views are one list filtered by category (`?bolum=` in the URL);
 * Sorunlar, İncelemeler and Formlar render their own pages inside the hub.
 */
export const HUB_VIEW_KEYS = [
  "bana",
  "tum",
  "yazismalar",
  "bilgi-talepleri",
  "teknik-onaylar",
  "toplantilar",
  "gonderimler",
  "sorunlar",
  "incelemeler",
  "formlar",
] as const;
export type HubViewKey = (typeof HUB_VIEW_KEYS)[number];

export function isHubViewKey(v: unknown): v is HubViewKey {
  return typeof v === "string" && (HUB_VIEW_KEYS as readonly string[]).includes(v);
}

/** A named view: hub view + its URL filters (search, status, due, grouping…). */
export interface SavedViewDto {
  id: string;
  projectId: string;
  name: string;
  view: HubViewKey;
  /** URL query of the view without the view selector, e.g. {"q":"kablo","grup":"status"}. */
  params: Record<string, string>;
  /** Shared with every project member (set by project administrators). */
  shared: boolean;
  position: number;
  ownerId: string;
  ownerName?: string;
  /** The caller owns the view. */
  mine: boolean;
  /** The caller may rename, reorder or delete it. */
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SavedViewInput {
  name: string;
  view: HubViewKey;
  params?: Record<string, string>;
  shared?: boolean;
}

/** Limits of saved view filters. */
export const SAVED_VIEW_MAX_PARAMS = 20;
export const SAVED_VIEW_MAX_PER_USER = 50;

// ---- Project "Bugün" ----------------------------------------------------------------------

export type TodayRowKind = "work" | "review" | "form" | "issue" | "task";

/** One line of the Bugün page; every line links to its record. */
export interface TodayRowDto {
  kind: TodayRowKind;
  id: string;
  /** "ZAVM-EYL-0001", "#3", form number. */
  number: string;
  title: string;
  /** "Eylem", "Doküman İncelemesi", "Sorun", "Form · Günlük Şantiye Raporu". */
  typeLabel: string;
  statusLabel?: string;
  statusTone?: string;
  /** YYYY-MM-DD */
  dueDate: string | null;
  overdue: boolean;
  link: string;
  /** Why it is here: step name, "Cevap bekleniyor", "Toplantı günü"… (sentence case). */
  note?: string;
  /** Company that sent the work (who waits for an answer), when known. */
  party?: string;
}

/** Groups of "Bana Düşenler" in display order. */
export const TODAY_MINE_GROUPS = ["tasks", "works", "actions", "replies", "receipts", "forms", "issues"] as const;
export type TodayMineGroup = (typeof TODAY_MINE_GROUPS)[number];

export const TODAY_MINE_GROUP_LABELS_TR: Record<TodayMineGroup, string> = {
  tasks: "Onayımı Bekleyenler",
  works: "Bana Atanan İşler",
  actions: "Eylemlerim",
  replies: "Cevap Beklenen Yazılar",
  receipts: "Alındı Onayı Bekleyenler",
  forms: "Doldurulacak Formlar",
  issues: "Bana Atanan Sorunlar",
};

/** Recent changes of one person and one kind of action on one day ("Emel 3 dosya yükledi"). */
export interface TodayChangeDto {
  at: string;
  userName: string | null;
  action: string;
  /** "3 dosya yükledi" (sentence case, without the person). */
  text: string;
  count: number;
  /** Up to three records the change touched. */
  items: { label: string; link: string | null }[];
}

export interface TodayChangeDayDto {
  /** YYYY-MM-DD (server time zone). */
  day: string;
  changes: TodayChangeDto[];
}

export interface ProjectTodayDto {
  projectId: string;
  mine: Record<TodayMineGroup, TodayRowDto[]>;
  /** Open records past their due date (works the caller sees, issues, the caller's steps). */
  overdue: TodayRowDto[];
  /** Due dates and meetings within the next days. */
  upcoming: TodayRowDto[];
  upcomingDays: number;
  /** Activity log of the last days, grouped by day. */
  changes: TodayChangeDayDto[];
  changeDays: number;
  counts: { mine: number; overdue: number; upcoming: number; changes: number };
  /** "Günün Özeti": the deterministic summary, plus the AI summary when there is one (phase 2a). */
  summary: TodaySummaryDto;
  generatedAt: string;
}

// ---- "Günün Özeti" (docs/product/SADELESTIRME.md, 2. aşama) -----------------------------------------

/** The AI summary is regenerated at most this often (and only when the Bugün data changed). */
export const TODAY_SUMMARY_MIN_INTERVAL_MS = 15 * 60_000;
/** Record lines in the model's input (plus counts); never documents. */
export const TODAY_SUMMARY_MAX_LINES = 15;
export const TODAY_SUMMARY_MAX_BULLETS = 6;

/** One line of the summary; record numbers in the text link to their records. */
export interface TodaySummaryBullet {
  text: string;
  refs: { number: string; link: string }[];
}

/**
 * How the AI summary can be produced in this project:
 *   off       AI is off (system or project): only the deterministic summary
 *   provider  a configured model writes it in the background
 *   queue     no model, but "Yapay Zekâya Gönder" (task queue, kind today_summary) is available
 *   none      no model and no queue
 */
export type TodaySummaryAi = "off" | "provider" | "queue" | "none";

export interface TodaySummaryDto {
  /** Built without AI from the same data; always present and shown at once. */
  auto: TodaySummaryBullet[];
  /** The caller's AI summary of today (null when there is none yet or AI is off). */
  ai: {
    bullets: TodaySummaryBullet[];
    generatedAt: string;
    model: string | null;
    source: "provider" | "queue";
    /** Written from the current data (false: records changed since). */
    fresh: boolean;
  } | null;
  mode: TodaySummaryAi;
  /** A model is writing the summary now. */
  running: boolean;
  /** Last failure, when it is newer than the AI summary. */
  error: string | null;
  /** Open "Yapay Zekâya Gönder" task of this user and project. */
  queueTask: { id: string; status: "pending" | "claimed" } | null;
  /** Hash of the model input: the AI summary is fresh while it is unchanged. */
  stamp: string;
}

/** The raw "Görevlerim" rows behind the tasks group (same shape as /my-tasks). */
export type TodayTaskDto = MyTaskDto;

// ---- User preferences ---------------------------------------------------------------------

/** Per-user settings stored on the server (users.prefs). */
export interface UserPrefs {
  /** Proje Ayarları: "Gelişmiş Ayarları Göster". */
  advancedSettings?: boolean;
  /** Bugün: "Günün Özeti" collapsed. */
  todaySummaryCollapsed?: boolean;
  /** Set when the user still has the temporary provisioned password. */
  mustChangePassword?: boolean;
  /** Interface language chosen in the top bar (BCP 47, "en", "tr"); missing = the browser's choice / English. */
  language?: string;
}
