/** API client for "İşler" (works), work types, automation and the "Bugün" inbox. */
import type {
  ActionSuggestionDto,
  BuildNumberingPreset,
  MeetingAgendaItem,
  MeetingAttendee,
  RegisterImportResultDto,
  RfiDraftDto,
  RfiLogRowDto,
  SubmittalRegisterRowDto,
  DeliveryChannelDto,
  DeliveryStatus,
  LetterData,
  LetterLang,
  RecordDraftAiDto,
  RecordDraftDto,
  RecordFromFileDto,
  TodayDto,
  WorkAutomationDto,
  WorkDetailDto,
  WorkFieldValues,
  WorkLinkKind,
  WorkLinkRole,
  WorkSummaryDto,
  WorkThreadItemDto,
  WorkTypeDto,
} from "@sitekeep/shared";
import { request } from "./client";

export interface WorkInput {
  typeId?: string;
  typeKey?: string;
  title: string;
  fields?: WorkFieldValues;
  status?: string;
  fromCompanyId?: string | null;
  toCompanyIds?: string[];
  ccCompanyIds?: string[];
  assigneeUserId?: string | null;
  dueDate?: string | null;
  replyRequired?: boolean;
  links?: LinkInput[];
  parentWorkId?: string | null;
  /** "Bırak, kaydet": signed reference of the dropped original, stored as the work's "ek". */
  sourceUploadId?: string | null;
}
export interface LinkInput {
  kind: WorkLinkKind;
  targetId: string;
  role?: WorkLinkRole;
}
export interface WorkFilter {
  type?: string;
  status?: string;
  q?: string;
  open?: boolean;
  due?: "overdue" | "soon";
  mine?: boolean;
  category?: string;
  parent?: string;
  /** Correspondence views: awaiting, unmailed, archived, cancelled. */
  view?: string;
}
/** Editable part of a letter (mailSentAt is set by the server). */
export type LetterInput = Partial<Omit<LetterData, "mailSentAt" | "translations">> & {
  translations?: Partial<Record<LetterLang, LetterData["translations"][LetterLang] | null>>;
};
export interface LetterTranslationSuggestion {
  language: LetterLang;
  subject: string;
  body: string;
  body2: string;
  signerTitle: string;
}
export type WorkTypeInput = Omit<WorkTypeDto, "id" | "projectId" | "statuses" | "builtIn" | "archived">;

const P = (pid: string) => `/projects/${pid}`;

export const worksApi = {
  types: (pid: string, all = false) => request<WorkTypeDto[]>("GET", `${P(pid)}/work-types${all ? "?all=1" : ""}`),
  /** Types a new work may be created with: not archived, module on ("+ Yeni"). */
  creatableTypes: (pid: string) => request<WorkTypeDto[]>("GET", `${P(pid)}/work-types?creatable=1`),
  createType: (pid: string, t: WorkTypeInput) => request<WorkTypeDto>("POST", `${P(pid)}/work-types`, t),
  updateType: (pid: string, tid: string, t: Partial<WorkTypeInput>) => request<WorkTypeDto>("PUT", `${P(pid)}/work-types/${tid}`, t),
  archiveType: (pid: string, tid: string) => request("DELETE", `${P(pid)}/work-types/${tid}`),
  restoreType: (pid: string, tid: string) => request<WorkTypeDto>("POST", `${P(pid)}/work-types/${tid}/restore`, {}),
  automation: (pid: string) => request<WorkAutomationDto[]>("GET", `${P(pid)}/work-automation`),
  setAutomation: (pid: string, tid: string, o: Omit<WorkAutomationDto, "templateId" | "templateName">) =>
    request("PUT", `${P(pid)}/work-automation/${tid}`, o),
  channels: () => request<DeliveryChannelDto[]>("GET", "/delivery-channels"),

  list: (pid: string, f: WorkFilter = {}) => {
    const q = new URLSearchParams();
    if (f.type) q.set("type", f.type);
    if (f.status) q.set("status", f.status);
    if (f.q) q.set("q", f.q);
    if (f.open) q.set("open", "1");
    if (f.due) q.set("due", f.due);
    if (f.mine) q.set("mine", "1");
    if (f.category) q.set("category", f.category);
    if (f.parent) q.set("parent", f.parent);
    if (f.view) q.set("view", f.view);
    const s = q.toString();
    return request<WorkSummaryDto[]>("GET", `${P(pid)}/works${s ? `?${s}` : ""}`);
  },
  get: (pid: string, wid: string) => request<WorkDetailDto>("GET", `${P(pid)}/works/${wid}`),
  create: (pid: string, w: WorkInput) => request<WorkDetailDto>("POST", `${P(pid)}/works`, w),
  update: (pid: string, wid: string, w: Partial<WorkInput>) => request<WorkDetailDto>("PATCH", `${P(pid)}/works/${wid}`, w),
  comment: (pid: string, wid: string, body: string) => request<WorkDetailDto>("POST", `${P(pid)}/works/${wid}/comments`, { body }),
  addLinks: (pid: string, wid: string, links: LinkInput[]) => request<WorkDetailDto>("POST", `${P(pid)}/works/${wid}/links`, { links }),
  setSigned: (pid: string, wid: string, lid: string, signed: boolean) =>
    request<WorkDetailDto>("PATCH", `${P(pid)}/works/${wid}/links/${lid}`, { signed }),
  removeLink: (pid: string, wid: string, lid: string) => request<WorkDetailDto>("DELETE", `${P(pid)}/works/${wid}/links/${lid}`),
  downloadUrl: (pid: string, wid: string, lid: string, inline = false) =>
    `/api/v1${P(pid)}/works/${wid}/links/${lid}/download${inline ? "?inline=1" : ""}`,
  send: (pid: string, wid: string, s: { channel: string; reference?: string | null; note?: string | null }) =>
    request<WorkDetailDto>("POST", `${P(pid)}/works/${wid}/send`, s),
  updateDelivery: (pid: string, wid: string, d: { status?: DeliveryStatus; reference?: string | null; note?: string | null }) =>
    request<WorkDetailDto>("PATCH", `${P(pid)}/works/${wid}/delivery`, d),
  receive: (pid: string, wid: string) => request<WorkDetailDto>("POST", `${P(pid)}/works/${wid}/receive`, {}),
  reply: (pid: string, wid: string) => request<WorkDetailDto>("POST", `${P(pid)}/works/${wid}/reply`, {}),
  cover: (pid: string, wid: string) => request<WorkDetailDto>("POST", `${P(pid)}/works/${wid}/cover`, {}),
  thread: (pid: string, wid: string) => request<WorkThreadItemDto[]>("GET", `${P(pid)}/works/${wid}/thread`),

  // Correspondence: official letter, status actions, e-mail
  saveLetter: (pid: string, wid: string, l: LetterInput) => request<WorkDetailDto>("PUT", `${P(pid)}/works/${wid}/letter`, l),
  letterPdfUrl: (pid: string, wid: string) => `/api/v1${P(pid)}/works/${wid}/letter.pdf?inline=1`,
  letterEmlUrl: (pid: string, wid: string) => `/api/v1${P(pid)}/works/${wid}/letter.eml`,
  mailLetter: (pid: string, wid: string) => request<WorkDetailDto>("POST", `${P(pid)}/works/${wid}/letter/mail`, {}),
  markMailed: (pid: string, wid: string) => request<WorkDetailDto>("POST", `${P(pid)}/works/${wid}/letter/mail-sent`, {}),
  translateLetter: (pid: string, wid: string, language: LetterLang) =>
    request<LetterTranslationSuggestion>("POST", `${P(pid)}/works/${wid}/letter/translate`, { language }),
  archive: (pid: string, wid: string) => request<WorkDetailDto>("POST", `${P(pid)}/works/${wid}/archive`, {}),
  cancel: (pid: string, wid: string, comment?: string) => request<{ id: string }>("POST", `${P(pid)}/works/${wid}/cancel`, { comment: comment || null }),
  reopen: (pid: string, wid: string) => request<WorkDetailDto>("POST", `${P(pid)}/works/${wid}/reopen`, {}),
  remove: (pid: string, wid: string) => request<{ ok: true }>("DELETE", `${P(pid)}/works/${wid}`),

  today: () => request<TodayDto>("GET", "/me/today"),
  /** "Bırak, kaydet": record draft from a dropped file (nothing is created). */
  recordFromFile: (pid: string, file: File, ai = false) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return request<RecordFromFileDto>("POST", `${P(pid)}/record-from-file${ai ? "?ai=1" : ""}`, form);
  },
  recordFromFileAi: (pid: string, excerpt: string, draft: RecordDraftDto) =>
    request<RecordDraftAiDto>("POST", `${P(pid)}/ai/record-from-file`, { excerpt, draft }),
};

// ---- Build works: RFI, submittal, meetings ------------------------------------------------------

export interface MinutesItemInput {
  id?: string | null;
  konu: string;
  karar?: string | null;
  sorumluUserId?: string | null;
  sorumluCompanyId?: string | null;
  termin?: string | null;
}

export const buildApi = {
  submit: (pid: string, wid: string, comment?: string) => request<{ id: string }>("POST", `${P(pid)}/works/${wid}/submit`, { comment: comment || null }),
  respond: (pid: string, wid: string, r: { outcome: string; comment?: string | null; response?: string | null }) =>
    request<{ id: string }>("POST", `${P(pid)}/works/${wid}/respond`, r),
  revise: (pid: string, wid: string) => request<{ id: string }>("POST", `${P(pid)}/works/${wid}/revise`, {}),
  cancel: (pid: string, wid: string, comment?: string) => request<{ id: string }>("POST", `${P(pid)}/works/${wid}/cancel`, { comment: comment || null }),
  addItems: (pid: string, wid: string, workIds: string[]) => request<{ id: string }>("POST", `${P(pid)}/works/${wid}/items`, { workIds }),
  removeItem: (pid: string, wid: string, iid: string) => request<{ id: string }>("DELETE", `${P(pid)}/works/${wid}/items/${iid}`),
  saveMeeting: (pid: string, wid: string, m: { attendees?: MeetingAttendee[]; agenda?: MeetingAgendaItem[] }) =>
    request<{ id: string }>("PUT", `${P(pid)}/works/${wid}/meeting`, m),
  saveMinutes: (pid: string, wid: string, m: { items: MinutesItemInput[]; notes?: string | null }) =>
    request<{ id: string; created: number; updated: number }>("PUT", `${P(pid)}/works/${wid}/minutes`, m),
  nextMeeting: (pid: string, wid: string, tarih?: string) =>
    request<{ id: string; number: string }>("POST", `${P(pid)}/works/${wid}/next-meeting`, { tarih: tarih || null }),
  minutesPdfUrl: (pid: string, wid: string) => `/api/v1${P(pid)}/works/${wid}/minutes.pdf?inline=1`,
  submittalRegister: (pid: string) => request<SubmittalRegisterRowDto[]>("GET", `${P(pid)}/submittals/register`),
  rfiLog: (pid: string) => request<RfiLogRowDto[]>("GET", `${P(pid)}/rfis/log`),
  submittalRegisterXlsxUrl: (pid: string) => `/api/v1${P(pid)}/submittals/register?format=xlsx`,
  rfiLogXlsxUrl: (pid: string) => `/api/v1${P(pid)}/rfis/log?format=xlsx`,
  importRegister: (
    pid: string,
    body: { format: "json" | "csv" | "xlsx"; content?: string; items?: unknown[]; dryRun: boolean; packages: "none" | "section" | "kind"; toCompanyIds?: string[] },
  ) => request<RegisterImportResultDto>("POST", `${P(pid)}/submittals/import`, body),
  numberingPreset: (pid: string, preset: BuildNumberingPreset) => request<{ changed: string[] }>("PUT", `${P(pid)}/build/numbering`, { preset }),
  minutesActions: (pid: string, text: string) => request<{ items: ActionSuggestionDto[] }>("POST", `${P(pid)}/ai/minutes-actions`, { text }),
  rfiDraft: (pid: string, description: string, fileVersionId?: string | null) =>
    request<RfiDraftDto & { links: { kind: "file_version"; targetId: string }[] }>("POST", `${P(pid)}/ai/rfi-draft`, {
      description,
      fileVersionId: fileVersionId || null,
    }),
};
