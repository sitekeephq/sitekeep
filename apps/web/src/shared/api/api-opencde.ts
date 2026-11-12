/**
 * CDE pages of the OpenCDE Documents API (docs/features/OPENCDE.md): "Dış Uygulamadan Yükleme" and
 * "Dış Uygulama İçin Belge Seç". The page key comes from the link the application opened.
 */
import type {
  OpenCdeDocumentRowDto,
  OpenCdeFolderDto,
  OpenCdeRedirectDto,
  OpenCdeSessionDto,
  OpenCdeUploadInput,
  OpenCdeUploadRulesDto,
} from "@sitekeep/shared";
import { request } from "./client";

const base = (key: string) => `/opencde/sessions/${encodeURIComponent(key)}`;

export const opencdeApi = {
  session: (key: string) => request<OpenCdeSessionDto>("GET", base(key)),
  folders: (key: string, pid: string) => request<OpenCdeFolderDto[]>("GET", `${base(key)}/projects/${pid}/folders`),
  rules: (key: string, pid: string, fid: string) => request<OpenCdeUploadRulesDto>("GET", `${base(key)}/projects/${pid}/folders/${fid}/rules`),
  documents: (key: string, pid: string, params: { folderId?: string; q?: string }) => {
    const q = new URLSearchParams();
    if (params.folderId) q.set("folderId", params.folderId);
    if (params.q) q.set("q", params.q);
    return request<OpenCdeDocumentRowDto[]>("GET", `${base(key)}/projects/${pid}/documents?${q}`);
  },
  upload: (key: string, input: OpenCdeUploadInput) => request<OpenCdeRedirectDto>("POST", `${base(key)}/upload`, input),
  select: (key: string, projectId: string, versionIds: string[]) =>
    request<OpenCdeRedirectDto>("POST", `${base(key)}/select`, { projectId, versionIds }),
  cancel: (key: string) => request<OpenCdeRedirectDto>("POST", `${base(key)}/cancel`, {}),
};
