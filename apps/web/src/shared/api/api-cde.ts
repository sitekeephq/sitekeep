/** API client for the ISO 19650 CDE settings (docs/features/CDE_STATES.md). */
import type { CdeSettingsDto, CdeSettingsInput } from "@sitekeep/shared";
import { request } from "./client";

export const cdeApi = {
  settings: (pid: string) => request<CdeSettingsDto>("GET", `/projects/${pid}/cde/settings`),
  saveSettings: (pid: string, input: CdeSettingsInput) => request<CdeSettingsDto>("PUT", `/projects/${pid}/cde/settings`, input),
};
