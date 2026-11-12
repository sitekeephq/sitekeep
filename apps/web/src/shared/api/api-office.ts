/** API client for the office integration (browser editing through WOPI, office → PDF converter). */
import type {
  FileOfficeDto,
  OfficeSessionDto,
  OfficeSettingsDto,
  OfficeSettingsInput,
  OfficeStatusDto,
  OfficeTestResultDto,
} from "@sitekeep/shared";
import { request } from "./client";

export interface AdminOfficeDto {
  settings: OfficeSettingsDto;
  status: OfficeStatusDto;
}

export const officeApi = {
  adminOffice: () => request<AdminOfficeDto>("GET", "/admin/office"),
  saveAdminOffice: (input: OfficeSettingsInput) => request<AdminOfficeDto>("PUT", "/admin/office", input),
  testAdminOffice: () => request<OfficeTestResultDto>("POST", "/admin/office/test", {}),
  fileOffice: (pid: string, fileId: string) => request<FileOfficeDto>("GET", `/projects/${pid}/files/${fileId}/office`),
  session: (pid: string, fileId: string, mode: "edit" | "view" = "edit") =>
    request<OfficeSessionDto>("POST", `/projects/${pid}/files/${fileId}/office/session`, { mode }),
  clearLock: (pid: string, fileId: string) => request<{ ok: true; cleared: boolean }>("DELETE", `/projects/${pid}/files/${fileId}/office/lock`),
};

/** Office formats the editors can open (the server decides per discovery; this only hides the button early). */
const OFFICE_EXTENSIONS = new Set([
  "docx", "docm", "dotx", "doc", "odt", "ott", "rtf", "txt",
  "xlsx", "xlsm", "xlsb", "xls", "ods", "csv",
  "pptx", "pptm", "ppsx", "ppt", "pps", "odp",
]);

export function isOfficeExtension(ext: string): boolean {
  return OFFICE_EXTENSIONS.has(ext.replace(/^\.+/, "").toLowerCase());
}

// The editor page marks a file when it closes an edit session; the file drawer then waits for the
// editor's last save (it can arrive after the page closed and even after the lock was released).
const closedKey = (fileId: string) => `cde.office.closed.${fileId}`;

export function markEditorClosed(fileId: string): void {
  try {
    sessionStorage.setItem(closedKey(fileId), String(Date.now()));
  } catch {
    /* storage unavailable: the drawer simply does not wait */
  }
}

export function editorClosedAt(fileId: string): number | null {
  try {
    const v = Number(sessionStorage.getItem(closedKey(fileId)));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function clearEditorClosed(fileId: string): void {
  try {
    sessionStorage.removeItem(closedKey(fileId));
  } catch {
    /* ignore */
  }
}
