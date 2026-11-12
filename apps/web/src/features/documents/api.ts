import type {
  AttributeDefinition,
  AttributeDefinitionDto,
  EffectiveAttributeDto,
  FileDto,
  FileVersionDto,
  FolderDto,
  FolderSettingsDto,
  GrantDto,
  NamingResult,
  NamingStandard,
  SearchResultDto,
  SubjectType,
  PermissionLevel,
  TrashDto,
  VersionApprovalDto,
  WhoCanSeeDto,
  ZipRequest,
  NamingSuggestionDto,
  SubmittalRegisterDto,
  SuggestFileResultDto,
  VersionDocIntelDto,
  VirtualFolderDto,
} from "@sitekeep/shared";
import { ApiError, del, get, patch, post, put, request, safeJson } from "../../shared/api/client";

export type FolderWithPath = FolderDto & { path: FolderDto[] };
export type FileDetail = FileDto & { versions: FileVersionDto[] };
export type FolderContents = {
  folder: FolderDto;
  folders: FolderDto[];
  files: FileDto[];
  virtualFolders?: VirtualFolderDto[];
};
export interface ExternalDocumentSource {
  id: string;
  projectId: string;
  provider: string;
  externalHubId: string;
  externalProjectId: string;
  name: string;
  metadata: Record<string, unknown>;
  syncedAt: string;
  counts: { folders: number; files: number };
}
export interface ExternalDocumentEntry {
  id: string;
  sourceId: string;
  externalId: string;
  parentExternalId: string | null;
  kind: "folder" | "file";
  name: string;
  path: string;
  versionNumber: number | null;
  webUrl: string | null;
  sourceCreatedAt: string | null;
  sourceModifiedAt: string | null;
  metadata: Record<string, unknown>;
}
export interface ExternalFolderContents {
  source: Omit<ExternalDocumentSource, "counts">;
  current: ExternalDocumentEntry | null;
  entries: ExternalDocumentEntry[];
}
export interface UploadResult {
  standard: string | null;
  results: { name: string; ok: boolean; errors: string[]; fileId?: string; version?: number }[];
}
export interface DocIntelSuggestResult {
  standard: NamingStandard | null;
  aiAvailable: boolean;
  results: SuggestFileResultDto[];
}

export const documentsApi = {
  folder: (projectId: string, folderId: string, signal?: AbortSignal) =>
    get<FolderWithPath>(`/projects/${projectId}/folders/${folderId}`, { signal }),
  contents: (projectId: string, folderId: string, signal?: AbortSignal) =>
    get<FolderContents>(`/projects/${projectId}/folders/${folderId}/contents`, { signal }),
  externalSources: (projectId: string, signal?: AbortSignal) =>
    get<ExternalDocumentSource[]>(`/projects/${projectId}/external-documents/sources`, { signal }),
  externalContents: (projectId: string, sourceId: string, parentId?: string | null, signal?: AbortSignal) => {
    const query = parentId ? `?parentId=${encodeURIComponent(parentId)}` : "";
    return get<ExternalFolderContents>(
      `/projects/${projectId}/external-documents/sources/${sourceId}/contents${query}`,
      { signal },
    );
  },
  materializeFolder: (projectId: string, folderId: string, path: string[]) =>
    post<{ folder: FolderDto; created: string[] }>(`/projects/${projectId}/folders/${folderId}/materialize`, { path }),
  createFolder: (projectId: string, parentId: string, name: string) =>
    post<FolderDto>(`/projects/${projectId}/folders`, { parentId, name }),
  updateFolder: (
    projectId: string,
    folderId: string,
    input: Partial<Pick<FolderDto, "name" | "description" | "state" | "namingStandardId">>,
  ) => patch<FolderDto>(`/projects/${projectId}/folders/${folderId}`, input),
  deleteFolder: (projectId: string, folderId: string) =>
    del(`/projects/${projectId}/folders/${folderId}`),
  permissions: (projectId: string, folderId: string) =>
    get<GrantDto[]>(`/projects/${projectId}/folders/${folderId}/permissions`),
  setPermissions: (
    projectId: string,
    folderId: string,
    entries: { subjectType: SubjectType; subjectId: string; level: PermissionLevel }[],
    mode: "add" | "replace",
  ) =>
    put<{ results: { subjectId: string; status: string }[]; grants: GrantDto[] }>(
      `/projects/${projectId}/folders/${folderId}/permissions`,
      { entries, mode },
    ),
  whoCanSee: (projectId: string, folderId: string, fileId?: string) =>
    get<WhoCanSeeDto>(
      `/projects/${projectId}/folders/${folderId}/who-can-see${fileId ? `?fileId=${fileId}` : ""}`,
    ),
  validateNames: (projectId: string, folderId: string, names: string[]) =>
    post<{ standard: string | null; results: (NamingResult & { name: string })[] }>(
      `/projects/${projectId}/naming/validate`,
      { folderId, names },
    ),
  upload: (
    projectId: string,
    folderId: string,
    files: File[],
    comment?: string,
    attributes?: Record<string, string>,
  ) => {
    const form = new FormData();
    if (comment) form.append("comment", comment);
    if (attributes && Object.keys(attributes).length) form.append("attributes", JSON.stringify(attributes));
    for (const file of files) form.append("file", file, file.name);
    return request<UploadResult>("POST", `/projects/${projectId}/folders/${folderId}/files`, form);
  },
  file: (projectId: string, fileId: string, signal?: AbortSignal) =>
    get<FileDetail>(`/projects/${projectId}/files/${fileId}`, { signal }),
  updateFile: (
    projectId: string,
    fileId: string,
    input: { name?: string; folderId?: string; attributes?: Record<string, string>; description?: string | null },
  ) => patch<FileDto>(`/projects/${projectId}/files/${fileId}`, input),
  copyFile: (projectId: string, fileId: string, input: { folderId: string; name?: string }) =>
    post<FileDto>(`/projects/${projectId}/files/${fileId}/copy`, input),
  deleteFile: (projectId: string, fileId: string) =>
    del(`/projects/${projectId}/files/${fileId}`),
  downloadUrl: (projectId: string, versionId: string) =>
    `/api/v1/projects/${projectId}/versions/${versionId}/download`,
  attributeDefinitions: (projectId: string) =>
    get<AttributeDefinitionDto[]>(`/projects/${projectId}/attribute-definitions`),
  createAttributeDefinition: (projectId: string, definition: AttributeDefinition) =>
    post<AttributeDefinitionDto>(`/projects/${projectId}/attribute-definitions`, definition),
  updateAttributeDefinition: (
    projectId: string,
    definitionId: string,
    definition: Partial<AttributeDefinition>,
  ) =>
    patch<AttributeDefinitionDto>(
      `/projects/${projectId}/attribute-definitions/${definitionId}`,
      definition,
    ),
  deleteAttributeDefinition: (projectId: string, definitionId: string) =>
    del(`/projects/${projectId}/attribute-definitions/${definitionId}`),
  folderAttributes: (projectId: string, folderId: string, signal?: AbortSignal) =>
    get<EffectiveAttributeDto[]>(
      `/projects/${projectId}/folders/${folderId}/attribute-definitions`,
      { signal },
    ),
  setFolderAttributes: (projectId: string, folderId: string, definitionIds: string[]) =>
    put<EffectiveAttributeDto[]>(
      `/projects/${projectId}/folders/${folderId}/attribute-bindings`,
      { definitionIds },
    ),
  search: (
    projectId: string,
    params: { q?: string; folderId?: string; ext?: string; attrs?: Record<string, string> },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (params.q) query.set("q", params.q);
    if (params.folderId) query.set("folderId", params.folderId);
    if (params.ext) query.set("ext", params.ext);
    for (const [key, value] of Object.entries(params.attrs ?? {})) {
      if (value) query.set(`attr.${key}`, value);
    }
    return get<SearchResultDto>(`/projects/${projectId}/search?${query.toString()}`, { signal });
  },
  trash: (projectId: string) => get<TrashDto>(`/projects/${projectId}/trash`),
  restoreFile: (projectId: string, fileId: string, name?: string) =>
    post<{ ok: true; name: string; folderId: string }>(
      `/projects/${projectId}/trash/files/${fileId}/restore`,
      name ? { name } : {},
    ),
  restoreFolder: (projectId: string, folderId: string, name?: string) =>
    post<{ ok: true; name: string; folders: number; files: number }>(
      `/projects/${projectId}/trash/folders/${folderId}/restore`,
      name ? { name } : {},
    ),
  purgeFile: (projectId: string, fileId: string) =>
    del<{ versions: number; removedObjects: number }>(
      `/projects/${projectId}/trash/files/${fileId}`,
    ),
  purgeFolder: (projectId: string, folderId: string) =>
    del<{ folders: number; files: number; removedObjects: number }>(
      `/projects/${projectId}/trash/folders/${folderId}`,
    ),
  folderApprovals: (projectId: string, folderId: string, signal?: AbortSignal) =>
    get<VersionApprovalDto[]>(`/projects/${projectId}/folders/${folderId}/approvals`, { signal }),
  fileApprovals: (projectId: string, fileId: string, signal?: AbortSignal) =>
    get<VersionApprovalDto[]>(`/projects/${projectId}/files/${fileId}/approvals`, { signal }),
  folderSettings: (projectId: string, folderId: string, signal?: AbortSignal) =>
    get<FolderSettingsDto>(`/projects/${projectId}/folders/${folderId}/settings`, { signal }),
  updateFolderSettings: (
    projectId: string,
    folderId: string,
    input: { requireApprovedReview: boolean },
  ) => put<FolderSettingsDto>(`/projects/${projectId}/folders/${folderId}/settings`, input),
  docIntelSuggest: (projectId: string, folderId: string, files: File[], ai = false) => {
    const form = new FormData();
    for (const file of files) form.append("file", file, file.name);
    return request<DocIntelSuggestResult>(
      "POST",
      `/projects/${projectId}/docintel/suggest?folderId=${folderId}${ai ? "&ai=1" : ""}`,
      form,
    );
  },
  versionDocIntel: (projectId: string, versionId: string, signal?: AbortSignal) =>
    get<VersionDocIntelDto>(`/projects/${projectId}/versions/${versionId}/docintel`, { signal }),
  reExtract: (projectId: string, versionId: string) =>
    post<{ status: string }>(`/projects/${projectId}/versions/${versionId}/docintel/extract`),
  versionSuggest: (projectId: string, versionId: string, ai: boolean) =>
    post<NamingSuggestionDto>(
      `/projects/${projectId}/versions/${versionId}/docintel/suggest`,
      { ai },
    ),
  buildSpecRegister: (projectId: string, versionId: string, ai = false) =>
    post<SubmittalRegisterDto>(`/projects/${projectId}/docintel/spec-register`, {
      versionId,
      ai,
    }),
  downloadZip: async (projectId: string, input: ZipRequest, name?: string) => {
    const query = new URLSearchParams();
    if (input.fileIds?.length) query.set("fileIds", input.fileIds.join(","));
    if (input.folderIds?.length) query.set("folderIds", input.folderIds.join(","));
    if (input.versionIds?.length) query.set("versionIds", input.versionIds.join(","));
    if (name) query.set("name", name);
    const url = `/api/v1/projects/${projectId}/download-zip?${query.toString()}`;
    if (url.length < 6000) {
      const anchor = document.createElement("a");
      anchor.href = url;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return;
    }
    const response = await fetch(`/api/v1/projects/${projectId}/download-zip`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, name }),
    });
    if (!response.ok) {
      const data = safeJson(await response.text()) as { message?: string } | null;
      throw new ApiError(response.status, data?.message ?? `HTTP ${response.status}`, data);
    }
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${name ?? "dosyalar"}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  },
};
