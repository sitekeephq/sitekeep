/** API client of the full project export and restore (docs/features/PROJECT_EXPORT.md). */
import type { ProjectExportDto, ProjectExportStateDto, ProjectImportDto } from "@sitekeep/shared";
import { request } from "./client";

export const portabilityApi = {
  state: (pid: string) => request<ProjectExportStateDto>("GET", `/projects/${pid}/exports`),
  create: (pid: string) => request<ProjectExportDto>("POST", `/projects/${pid}/exports`, {}),
  get: (pid: string, id: string) => request<ProjectExportDto>("GET", `/projects/${pid}/exports/${id}`),
  remove: (pid: string, id: string) => request<{ ok: true }>("DELETE", `/projects/${pid}/exports/${id}`),
  downloadUrl: (pid: string, id: string) => `/api/v1/projects/${pid}/exports/${id}/download`,
  /** System administrators: restore a package as a new project. */
  imports: () => request<ProjectImportDto[]>("GET", "/project-imports"),
  importOne: (id: string) => request<ProjectImportDto>("GET", `/project-imports/${id}`),
  startImport: (file: File, code: string, name?: string) => {
    const form = new FormData();
    form.append("code", code);
    if (name) form.append("name", name);
    form.append("file", file, file.name);
    return request<ProjectImportDto>("POST", "/project-imports", form);
  },
};
