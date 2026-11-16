/** API client of the close-out archive (docs/features/CLOSEOUT_ARCHIVE.md, ISO 19650-2 §5.8.1). */
import type { CloseoutArchiveDto, CloseoutOptions, CloseoutStateDto } from "@sitekeep/shared";
import { request } from "./client";

export const closeoutApi = {
  state: (pid: string) => request<CloseoutStateDto>("GET", `/projects/${pid}/closeout`),
  create: (pid: string, options: CloseoutOptions) => request<CloseoutArchiveDto>("POST", `/projects/${pid}/closeout/archives`, options),
  archive: (pid: string, id: string) => request<CloseoutArchiveDto>("GET", `/projects/${pid}/closeout/archives/${id}`),
  remove: (pid: string, id: string) => request<{ ok: true }>("DELETE", `/projects/${pid}/closeout/archives/${id}`),
  downloadUrl: (pid: string, id: string) => `/api/v1/projects/${pid}/closeout/archives/${id}/download`,
  close: (pid: string) => request<{ ok: true }>("POST", `/projects/${pid}/close`, {}),
  /** System administrators only. */
  reopen: (pid: string, reason?: string) => request<{ ok: true }>("POST", `/projects/${pid}/reopen`, reason ? { reason } : {}),
};
