/** API client of the simple project screen: project Bugün, saved views, module switches, user prefs. */
import type { ProjectModule, ProjectModuleState, ProjectTodayDto, SavedViewDto, SavedViewInput, TodaySummaryDto, UserPrefs } from "@sitekeep/shared";
import { request } from "./client";

const P = (pid: string) => `/projects/${pid}`;

export const hubApi = {
  /** `ai: false` does not start an AI summary run (İşler → Bana Düşenler). */
  today: (pid: string, o: { ai?: boolean } = {}) => request<ProjectTodayDto>("GET", `${P(pid)}/today${o.ai === false ? "?ai=0" : ""}`),
  todaySummary: (pid: string) => request<TodaySummaryDto>("GET", `${P(pid)}/today/summary`),
  /** "Yenile": starts a new AI summary when the data changed (or the last one failed). */
  refreshTodaySummary: (pid: string) => request<TodaySummaryDto>("POST", `${P(pid)}/today/summary`, {}),

  savedViews: (pid: string) => request<SavedViewDto[]>("GET", `${P(pid)}/saved-views`),
  createView: (pid: string, v: SavedViewInput) => request<SavedViewDto>("POST", `${P(pid)}/saved-views`, v),
  updateView: (pid: string, id: string, v: Partial<SavedViewInput>) => request<SavedViewDto>("PATCH", `${P(pid)}/saved-views/${id}`, v),
  deleteView: (pid: string, id: string) => request<{ ok: true }>("DELETE", `${P(pid)}/saved-views/${id}`),
  orderViews: (pid: string, ids: string[]) => request<SavedViewDto[]>("PUT", `${P(pid)}/saved-views/order`, { ids }),

  modules: (pid: string) => request<ProjectModuleState>("GET", `${P(pid)}/modules`),
  setModules: (pid: string, modules: Partial<Record<ProjectModule, boolean>>) =>
    request<ProjectModuleState>("PUT", `${P(pid)}/modules`, { modules }),

  prefs: () => request<UserPrefs>("GET", "/me/prefs"),
  setPrefs: (p: UserPrefs) => request<UserPrefs>("PATCH", "/me/prefs", p),
};
