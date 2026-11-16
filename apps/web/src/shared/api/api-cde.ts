/** API client for the ISO 19650 CDE settings and codes (docs/features/CDE_STATES.md). */
import type {
  CdeApplyCodesReportDto,
  CdeCodeWarningDto,
  CdeFolderCodesDto,
  CdeSettingsDto,
  CdeSettingsInput,
  CdeUnmappedCodeDto,
  CdeVersionCodesInput,
  FileDto,
  FileVersionDto,
} from "@sitekeep/shared";
import { request } from "./client";

export const cdeApi = {
  settings: (pid: string) => request<CdeSettingsDto>("GET", `/projects/${pid}/cde/settings`),
  saveSettings: (pid: string, input: CdeSettingsInput) => request<CdeSettingsDto>("PUT", `/projects/${pid}/cde/settings`, input),
  /** Profile and state of a folder, for the code inputs. */
  folderCodes: (pid: string, folderId: string) => request<CdeFolderCodesDto>("GET", `/projects/${pid}/folders/${folderId}/cde/codes`),
  setVersionCodes: (pid: string, versionId: string, input: CdeVersionCodesInput) =>
    // `warnings`: codes stored although they do not fit the state (the project does not enforce the rules).
    request<FileVersionDto & { warnings?: CdeCodeWarningDto[] }>("PATCH", `/projects/${pid}/versions/${versionId}/codes`, input),
  /** Administrator override of the transition rules: moves the file, with a reason (audit cde.override). */
  overrideTransition: (pid: string, fileId: string, input: { toFolderId: string; reason: string }) =>
    request<FileDto>("POST", `/projects/${pid}/files/${fileId}/transition`, input),
  /** Legacy attribute values that are not codes of the project's profile (project administrators). */
  unmappedCodes: (pid: string) => request<{ items: CdeUnmappedCodeDto[]; truncated: boolean }>("GET", `/projects/${pid}/cde/codes/unmapped`),
  /** Maps the legacy attribute values into empty codes under the current scheme (project administrators; audit cde.codes_applied). */
  applyCodes: (pid: string) => request<CdeApplyCodesReportDto>("POST", `/projects/${pid}/cde/codes/apply`, {}),
};
