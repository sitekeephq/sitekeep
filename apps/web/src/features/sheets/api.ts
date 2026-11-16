/** API client for drawing sheets and sheet sets (docs/features/SHEETS.md). */
import type {
  CdeState,
  DrawingSheetDetailDto,
  DrawingSheetDto,
  DrawingSheetListDto,
  DrawingSheetUpdate,
  SheetSetDto,
  SheetSetPublicationDto,
  SheetSetSummaryDto,
  SheetSettingsDto,
} from "@sitekeep/shared";
import { del, get, patch, post, put, qs } from "../../shared/api/client";

export interface SheetFilters {
  q?: string;
  discipline?: string;
  revision?: string;
  state?: CdeState | "none" | "";
  setId?: string;
}

const filterQuery = (f: SheetFilters) =>
  qs({ q: f.q?.trim() || undefined, discipline: f.discipline, revision: f.revision, state: f.state || undefined, setId: f.setId });

export const sheetsApi = {
  list: (pid: string, f: SheetFilters) => get<DrawingSheetListDto>(`/projects/${pid}/sheets${filterQuery(f)}`),
  detail: (pid: string, sid: string) => get<DrawingSheetDetailDto>(`/projects/${pid}/sheets/${sid}`),
  update: (pid: string, sid: string, body: DrawingSheetUpdate) => patch<DrawingSheetDto>(`/projects/${pid}/sheets/${sid}`, body),
  rescan: (pid: string) => post<{ queued: number }>(`/projects/${pid}/sheets/rescan`),
  versionSheets: (pid: string, vid: string) =>
    get<{ sheets: DrawingSheetDto[]; inScope: boolean; canEdit: boolean }>(`/projects/${pid}/versions/${vid}/sheets`),
  extract: (pid: string, vid: string) => post<{ queued: boolean }>(`/projects/${pid}/versions/${vid}/sheets/extract`),
  exportUrl: (pid: string, f: SheetFilters, format: "csv" | "xlsx") => {
    const q = filterQuery(f);
    return `/api/v1/projects/${pid}/sheets/export${q ? `${q}&` : "?"}format=${format}`;
  },
  settings: (pid: string) => get<SheetSettingsDto>(`/projects/${pid}/sheet-settings`),
  saveSettings: (pid: string, body: { states?: CdeState[]; folderIds?: string[] }) => put<SheetSettingsDto>(`/projects/${pid}/sheet-settings`, body),
  sets: (pid: string) => get<{ sets: SheetSetSummaryDto[] }>(`/projects/${pid}/sheet-sets`),
  set: (pid: string, setId: string) => get<SheetSetDto>(`/projects/${pid}/sheet-sets/${setId}`),
  createSet: (pid: string, body: { name: string; description?: string | null; sheetIds?: string[] }) =>
    post<SheetSetDto>(`/projects/${pid}/sheet-sets`, body),
  updateSet: (pid: string, setId: string, body: { name?: string; description?: string | null }) =>
    patch<SheetSetDto>(`/projects/${pid}/sheet-sets/${setId}`, body),
  deleteSet: (pid: string, setId: string) => del<{ ok: true }>(`/projects/${pid}/sheet-sets/${setId}`),
  addItems: (pid: string, setId: string, sheetIds: string[]) => post<{ added: number }>(`/projects/${pid}/sheet-sets/${setId}/items`, { sheetIds }),
  removeItems: (pid: string, setId: string, keys: string[]) =>
    post<{ removed: number }>(`/projects/${pid}/sheet-sets/${setId}/items/remove`, { keys }),
  publish: (pid: string, setId: string, note: string | null) => post<SheetSetPublicationDto>(`/projects/${pid}/sheet-sets/${setId}/publish`, { note }),
  issue: (pid: string, setId: string, issue: number) => get<SheetSetPublicationDto>(`/projects/${pid}/sheet-sets/${setId}/issues/${issue}`),
  setExportUrl: (pid: string, setId: string, format: "csv" | "xlsx", issue?: number | null) =>
    `/api/v1/projects/${pid}/sheet-sets/${setId}/export?format=${format}${issue ? `&issue=${issue}` : ""}`,
  setZipUrl: (pid: string, setId: string, issue?: number | null) => `/api/v1/projects/${pid}/sheet-sets/${setId}/zip${issue ? `?issue=${issue}` : ""}`,
};
