import type {
  BcfImportMapping,
  BcfImportPreview,
  BcfImportResult,
  BcfVersion,
  IssueViewpointDto,
  CompareSummaryDto,
  ModelAskResultDto,
  ModelQuery,
  ModelQueryResultDto,
  ModelVocabDto,
  AuditEntryDto,
  AdminStatusDto,
  AdminCapacityDto,
  CapacityRunDto,
  CapacityRunMode,
  GoogleAuthSettings,
  CompanyDto,
  DashboardDto,
  DashboardSummaryDto,
  DashboardVersionDto,
  ReportCatalogDto,
  ReportDataResult,
  ReportDraft,
  ReportGenerateResult,
  ReportModule,
  ReportQueryRef,
  ReportRepairResult,
  ReportSharing,
  ReportStampDto,
  FileVersionDto,
  FinalOutcomeMap,
  IssueCommentDto,
  IssueDto,
  IssueLinkDto,
  IssueLinkKind,
  MarkupDto,
  MarkupShape,
  MemberDto,
  MyTaskDto,
  NamingStandard,
  NamingStandardDto,
  NotificationDto,
  OutcomeCode,
  ProjectDto,
  ProjectRoleDto,
  ReviewDetailDto,
  RolePackage,
  RolePackageKey,
  RolePackagePlanDto,
  ReviewSummaryDto,
  UserDto,
  WorkflowAssignee,
  WorkflowKind,
  WorkflowStep,
  WorkflowTemplateDto,
  ReviewChainConfig,
  VersionCompareDto,
  CreateFromTemplateRequest,
  ProjectTemplate,
  TemplateCounts,
  TemplatePreviewDto,
  TemplateSummaryDto,
  VersionInfoDto,
  FormAttachmentDto,
  FormDetailDto,
  FormLibraryItemDto,
  FormSummaryDto,
  FormTemplateDto,
  FormTemplateInput,
  FormTemplateSchema,
  FormValues,
  FormFlowBody,
  FormFlowDraftDto,
  FormFlowDto,
  PdfAnalysisDto,
  PdfNamingDto,
  LocationDto,
  LocationLinkDto,
  LocationLinkKind,
  TemplateSimilarityDto,
  ClashDto,
  ClashGroupDto,
  ClashResultsDto,
  ClashRunDto,
  ClashSelection,
  ClashSummaryDto,
  ClashTestDto,
  IdsReportDto,
  IssueViewpoint,
  ModelSetDto,
  ModelSetItem,
  ModelSetViewDto,
  ModelSetViewState,
  SubmittalRegisterDto,
  SubmittalRegisterItem,
  SubmittalRegisterSummaryDto,
  DocCompareDto,
  PageRegions,
} from "@sitekeep/shared";
import { ApiError, del, get, patch, post, put, request, safeJson } from "./client";

export { ApiError, request } from "./client";

export type ModelVersion = FileVersionDto & {
  fileName: string;
  folderId: string;
  folderPath: string;
  isLatest: boolean;
};
export type TokenScope = "read" | "write";
export interface ApiTokenDto {
  id: string;
  name: string;
  scope: TokenScope;
  projectIds: string[] | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}
export interface TokenPolicy {
  canCreate: boolean;
  reason: string | null;
  allowWriteTokens: boolean;
  maxTokenDays: number | null;
  tokenCreators: TokenCreators;
  mcpEnabled: boolean;
}
export type TokenCreators = "everyone" | "project_admins" | "admins";
export type AiMode = "off" | "local_only" | "allow_external";
export type ProviderKind = "openai_compatible" | "anthropic";
export interface McpSettings {
  enabled: boolean;
  allowWriteTokens: boolean;
  tokenCreators: TokenCreators;
  maxTokenDays: number | null;
}
export interface AiProviderDto {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  embeddingModel: string | null;
  disableThinking: boolean;
  hasApiKey: boolean;
  external: boolean;
  presetId?: string | null;
  capabilities?: { tools: boolean; jsonMode: boolean; vision: boolean; contextTokens: number | null };
}
/** AI task queue ("Yapay Zekâya Gönder"). */
export interface AiTaskQueueSettings {
  enabled: boolean;
  allowExternalClients: boolean;
  ttlHours: number;
}
export interface AdminSettings {
  mcp: McpSettings;
  ai: {
    mode: AiMode;
    /** Mode the administrator chose; differs from `mode` while "Tüm Dış Bağlantıları Kapat" is on. */
    storedMode?: AiMode;
    killSwitch?: boolean;
    defaultProviderId: string | null;
    providers: AiProviderDto[];
    taskQueue?: AiTaskQueueSettings;
  };
}
export interface ProviderInput {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  embeddingModel?: string | null;
  disableThinking?: boolean;
  /** undefined keeps the stored key, null removes it. */
  apiKey?: string | null;
  /** Preset (packages/shared ai-presets.ts). */
  presetId?: string | null;
}
export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  model?: string;
  reply?: string;
  error?: string;
  /** First streamed text after this many ms (null when the provider answers in one piece). */
  firstTokenMs?: number | null;
  outputTokens?: number;
  tokensPerSecond?: number | null;
  /** Token count estimated from the text length. */
  estimated?: boolean;
}
export interface ProjectAiDto {
  systemMode: AiMode;
  policy: { enabled: boolean; providerId: string | null; allowExternal: boolean };
  defaultProviderId: string | null;
  providers: { id: string; name: string; kind: ProviderKind; model: string; external: boolean; allowedBySystem: boolean }[];
  effective: {
    enabled: boolean;
    providerId: string | null;
    providerName: string | null;
    model: string | null;
    models: readonly { id: string; label: string }[];
    reason: string | null;
  };
  personal: {
    allowed: boolean;
    reason: string | null;
    providers: PersonalAiCredentialDto[];
  };
}

export type AiProviderSelection = "project" | "anthropic" | "cursor";
export interface PersonalAiCredentialDto {
  id: Exclude<AiProviderSelection, "project">;
  name: string;
  hasApiKey: boolean;
  maskedKey: string | null;
  model: string;
  models: { id: string; label: string }[];
  /** Claude only: anthropic-workspace-id sent with every request (null = the key's own Workspace). */
  workspaceId: string | null;
}

export interface AskSource {
  ref: string;
  type: "file" | "folder" | "issue" | "review" | "model" | "work" | "form" | "report" | "spec";
  id: string;
  label: string;
  url: string;
  cited: boolean;
}
export interface AskResult {
  answer: string;
  sources: AskSource[];
  toolCalls: { tool: string; ms: number; ok: boolean; error?: string }[];
  model: string;
  provider: string;
  ms: number;
  rounds: number;
  protocol: "native" | "json" | "router";
  conversationId: string;
}
export interface AskJob {
  id: string;
  status: "running" | "done" | "error" | "cancelled";
  steps: { label: string; state: "running" | "done" | "ok" | "error"; ms?: number }[];
  partial: string;
  elapsedMs: number;
  result?: AskResult;
  error?: { status: number; code: string; message: string };
}
export interface AskSettings {
  perMinute: number;
  burst: number;
}

export interface AutodeskConnectionDto {
  id: string;
  projectId: string;
  externalHubId: string | null;
  externalProjectId: string;
  externalProjectName: string | null;
  authorizedEmail: string | null;
  scopes: string[];
  enabled: boolean;
  intervalMinutes: number;
  status: "disconnected" | "ready" | "syncing" | "error";
  lastSyncStartedAt: string | null;
  lastSyncCompletedAt: string | null;
  nextSyncAt: string | null;
  lastError: string | null;
  counts: Record<string, number>;
  /** Record kinds the sync brings (all by default). */
  syncKinds: AutodeskRecordKind[];
  connected: boolean;
  /** Last Autodesk sign-in; the project's ACC project is the last one signed in to. */
  authorizedAt: string | null;
  createdAt: string;
}

export interface AutodeskIntegrationDto {
  configured: boolean;
  callbackUrl: string | null;
  connections: AutodeskConnectionDto[];
}

export type AutodeskRecordKind = "issue" | "review" | "form" | "rfi" | "submittal" | "location" | "user";

/** One record kind in "Autodesk'ten Getir": chosen or not, at ACC at the last sync (null: never read), in CDE. */
export interface AutodeskRecordKindDto {
  kind: AutodeskRecordKind;
  selected: boolean;
  inAcc: number | null;
  inCde: number;
}

/** One ACC record of an opened kind in Seçerek Getir. */
export interface AutodeskRecordDto {
  kind: AutodeskRecordKind | "company";
  externalId: string;
  name: string;
  number: string | null;
  status: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedInAcc: boolean;
  /** Its CDE counterpart, when brought. */
  native: { type: string; id: string } | null;
  /** Every plain field ACC gave, as ACC names them. */
  details: [string, string][];
}

export type AutodeskSyncStepState = "waiting" | "running" | "done" | "unavailable" | "cancelled";

/** The latest record sync, step by step (Forma Eşitleme → Aktarım). */
export interface AutodeskSyncProgressDto {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  trigger: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  steps: { kind: AutodeskRecordKind; state: AutodeskSyncStepState; count: number | null }[];
  /** Bringing the read records into the project tabs. */
  projectStep: AutodeskSyncStepState;
  percent: number;
}

/** ACC hubs and projects the installation's APS app reaches (connect form). */
export interface AutodeskCatalogDto {
  /** False for public (PKCE-only) APS apps: they have no app token, the ids are typed in. */
  available: boolean;
  hubs: { id: string; name: string; projects: { id: string; name: string }[] }[];
}

/** Autodesk Docs, live (Forma Eşitleme → Autodesk'ten Getir). */
export interface AutodeskDocsFolderDto {
  id: string;
  name: string;
  updatedAt: string | null;
}

export interface AutodeskDocsFileDto {
  itemId: string;
  versionId: string;
  versionNumber: number | null;
  name: string;
  size: number | null;
  updatedAt: string | null;
  fileType: string | null;
  downloadable: boolean;
  /** The CDE file this item was brought into, and the Autodesk version it holds. */
  imported: { fileId: string; versionNumber: number | null } | null;
}

export interface AutodeskDocsListingDto {
  folderId: string | null;
  folders: AutodeskDocsFolderDto[];
  files: AutodeskDocsFileDto[];
}

export interface AutodeskFileImportDto {
  id: string;
  name: string;
  sourcePath: string | null;
  versionNumber: number | null;
  sizeBytes: number | null;
  targetFolderId: string;
  targetFolderName: string | null;
  status: "queued" | "running" | "done" | "skipped" | "failed" | "cancelled";
  /** Downloaded so far while running; null before the download starts and after it ends. */
  bytesReceived: number | null;
  /** Queued, or still downloading: "İptal" stops it. */
  cancellable: boolean;
  action: "new" | "version" | "skipped" | null;
  fileId: string | null;
  error: string | null;
  requestedBy: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AutodeskImportRequest {
  targetFolderId: string;
  files: { itemId: string; versionId: string; versionNumber: number | null; name: string; path: string; size: number | null }[];
}

export const api = {
  ask: (pid: string, question: string, conversationId?: string, model?: string, provider: AiProviderSelection = "project") =>
    post<AskJob>(`/projects/${pid}/ask`, {
      question,
      provider,
      ...(conversationId && { conversationId }),
      ...(model && { model }),
    }),
  askJob: (pid: string, jobId: string) => get<AskJob>(`/projects/${pid}/ask/${jobId}`),
  cancelAsk: (pid: string, jobId: string) => post<AskJob>(`/projects/${pid}/ask/${jobId}/cancel`),
  askSettings: () => get<AskSettings>("/admin/settings/ask"),
  updateAskSettings: (s: Partial<AskSettings>) => put<AskSettings>("/admin/settings/ask", s),

  login: (email: string, password: string) => post<UserDto>("/auth/login", { email, password }),
  authMethods: () => get<{ password: boolean; google: boolean }>("/auth/methods"),
  logout: () => post("/auth/logout"),
  me: () => get<UserDto | null>("/auth/me"),
  changePassword: (currentPassword: string, newPassword: string) =>
    post("/auth/password", { currentPassword, newPassword }),
  tokens: () => get<ApiTokenDto[]>("/auth/tokens"),
  tokenPolicy: () => get<TokenPolicy>("/auth/token-policy"),
  createToken: (t: { name: string; scope: TokenScope; projectIds: string[] | null; expiresInDays: number | null }) =>
    post<ApiTokenDto & { token: string }>("/auth/tokens", t),
  deleteToken: (id: string) => del(`/auth/tokens/${id}`),

  companies: () => get<CompanyDto[]>("/companies"),
  createCompany: (name: string, code?: string | null) => post<CompanyDto>("/companies", { name, ...(code ? { code } : {}) }),
  updateCompany: (id: string, c: { name?: string; code?: string | null; address?: string | null; email?: string | null }) =>
    patch<CompanyDto>(`/companies/${id}`, c),
  users: () => get<UserDto[]>("/users"),
  createUser: (u: { email: string; name: string; password: string; companyId: string | null; isAdmin: boolean }) =>
    post<UserDto>("/users", u),
  updateUser: (id: string, u: Partial<{ name: string; companyId: string | null; isAdmin: boolean; disabled: boolean; password: string }>) =>
    patch<UserDto>(`/users/${id}`, u),

  adminStatus: () => get<AdminStatusDto>("/admin/status"),
  adminCapacity: () => get<AdminCapacityDto>("/admin/capacity"),
  capacityRuns: () => get<CapacityRunDto[]>("/admin/capacity/runs"),
  capacityRun: (id: string) => get<CapacityRunDto>(`/admin/capacity/runs/${id}`),
  startCapacityRun: (mode: CapacityRunMode) => post<CapacityRunDto>("/admin/capacity/runs", { mode }),
  cancelCapacityRun: (id: string) => post<CapacityRunDto>(`/admin/capacity/runs/${id}/cancel`),
  capacityReportUrl: (id: string, format: "html" | "json" = "html") => `/api/v1/admin/capacity/runs/${id}/report?format=${format}`,
  googleAuthSettings: () => get<GoogleAuthSettings>("/admin/google-auth"),
  updateGoogleAuthSettings: (s: GoogleAuthSettings) => put<GoogleAuthSettings>("/admin/google-auth", s),
  adminSettings: () => get<AdminSettings>("/admin/settings"),
  updateMcpSettings: (s: Partial<McpSettings>) => put<AdminSettings>("/admin/settings/mcp", s),
  updateAiSettings: (s: { mode?: AiMode; defaultProviderId?: string | null; taskQueue?: Partial<AiTaskQueueSettings> }) =>
    put<AdminSettings>("/admin/settings/ai", s),
  createProvider: (p: ProviderInput) => post<AiProviderDto>("/admin/ai/providers", p),
  updateProvider: (id: string, p: Partial<ProviderInput>) => patch<AiProviderDto>(`/admin/ai/providers/${id}`, p),
  deleteProvider: (id: string) => del(`/admin/ai/providers/${id}`),
  testProvider: (id: string) => post<ProviderTestResult>(`/admin/ai/providers/${id}/test`),
  personalAiCredentials: () => get<{ providers: PersonalAiCredentialDto[] }>("/me/ai-credentials"),
  updatePersonalAiCredential: (
    provider: PersonalAiCredentialDto["id"],
    body: { apiKey?: string | null; model?: string; workspaceId?: string | null },
  ) =>
    patch<{ providers: PersonalAiCredentialDto[]; test: ProviderTestResult | null }>(
      `/me/ai-credentials/${provider}`,
      body,
    ),
  /** Claude models the given (or the stored) key can use, read from Anthropic. */
  claudeModels: (body: { apiKey?: string; workspaceId?: string | null }) =>
    post<{ models: { id: string; label: string }[] }>("/me/ai-credentials/anthropic/models", body),
  testPersonalAiCredential: (pid: string, provider: PersonalAiCredentialDto["id"]) =>
    post<ProviderTestResult>(`/projects/${pid}/ai/personal/${provider}/test`),
  projectAi: (pid: string) => get<ProjectAiDto>(`/projects/${pid}/ai`),
  autodeskIntegration: (pid: string) => get<AutodeskIntegrationDto>(`/projects/${pid}/integrations/autodesk`),
  autodeskCatalog: (pid: string) => get<AutodeskCatalogDto>(`/projects/${pid}/integrations/autodesk/catalog`),
  connectAutodesk: (
    pid: string,
    body: { externalProjectId: string; externalHubId?: string | null; name?: string | null; intervalMinutes: number },
  ) => post<{ authorizeUrl: string; connection: AutodeskConnectionDto }>(`/projects/${pid}/integrations/autodesk/connect`, body),
  syncAutodesk: (pid: string, connectionId: string) =>
    post<{ queued: boolean }>(`/projects/${pid}/integrations/autodesk/${connectionId}/sync`),
  updateAutodesk: (pid: string, connectionId: string, body: { enabled?: boolean; intervalMinutes?: number }) =>
    patch<AutodeskConnectionDto>(`/projects/${pid}/integrations/autodesk/${connectionId}`, body),
  autodeskDocs: (pid: string, connectionId: string, folderId?: string | null) =>
    get<AutodeskDocsListingDto>(
      `/projects/${pid}/integrations/autodesk/${connectionId}/docs${folderId ? `?folder=${encodeURIComponent(folderId)}` : ""}`,
    ),
  importAutodeskFiles: (pid: string, connectionId: string, body: AutodeskImportRequest) =>
    post<{ queued: number; rejected: { name: string; error: string }[] }>(`/projects/${pid}/integrations/autodesk/${connectionId}/imports`, body),
  autodeskRecordKinds: (pid: string, connectionId: string) =>
    get<AutodeskRecordKindDto[]>(`/projects/${pid}/integrations/autodesk/${connectionId}/records`),
  bringAutodeskRecords: (pid: string, connectionId: string, kinds: AutodeskRecordKind[]) =>
    post<{ queued: boolean; connection: AutodeskConnectionDto }>(`/projects/${pid}/integrations/autodesk/${connectionId}/records`, { kinds }),
  autodeskRecords: (pid: string, connectionId: string, kind: AutodeskRecordKind, refresh: boolean) =>
    get<{ kind: AutodeskRecordKind; refused: string | null; records: AutodeskRecordDto[] }>(
      `/projects/${pid}/integrations/autodesk/${connectionId}/records/${kind}${refresh ? "?refresh=1" : ""}`,
    ),
  bringAutodeskRecordItems: (pid: string, connectionId: string, records: { kind: AutodeskRecordDto["kind"]; externalId: string }[]) =>
    post<{ brought: number }>(`/projects/${pid}/integrations/autodesk/${connectionId}/records/bring`, { records }),
  autodeskProgress: (pid: string, connectionId: string) =>
    get<{ run: AutodeskSyncProgressDto | null }>(`/projects/${pid}/integrations/autodesk/${connectionId}/progress`),
  cancelAutodeskSync: (pid: string, connectionId: string) =>
    post<{ cancelled: boolean }>(`/projects/${pid}/integrations/autodesk/${connectionId}/sync/cancel`),
  cancelAutodeskImport: (pid: string, importId: string) =>
    post<{ cancelled: boolean }>(`/projects/${pid}/integrations/autodesk/imports/${importId}/cancel`),
  autodeskImports: (pid: string) => get<AutodeskFileImportDto[]>(`/projects/${pid}/integrations/autodesk/imports`),
  updateProjectAi: (pid: string, p: ProjectAiDto["policy"]) => put<ProjectAiDto>(`/projects/${pid}/ai`, p),

  projects: () => get<ProjectDto[]>("/projects"),
  project: (pid: string) => get<ProjectDto>(`/projects/${pid}`),
  createProject: (p: { code: string; name: string; description?: string; template: "empty" | "iso19650" }) =>
    post<ProjectDto>("/projects", p),
  deleteProject: (pid: string) => del<{ ok: boolean }>(`/projects/${pid}`),
  templates: () => get<TemplateSummaryDto[]>("/templates"),
  previewTemplate: (body: Omit<CreateFromTemplateRequest, "name" | "code"> & { code?: string }) =>
    post<TemplatePreviewDto>("/templates/preview", body),
  createProjectFromTemplate: (body: CreateFromTemplateRequest) =>
    post<ProjectDto & { warnings: string[]; counts: TemplateCounts }>("/projects/from-template", body),
  exportTemplate: (pid: string) => get<ProjectTemplate>(`/projects/${pid}/export-template`),
  members: (pid: string) => get<MemberDto[]>(`/projects/${pid}/members`),
  addMember: (pid: string, m: { email: string; companyId?: string | null; isProjectAdmin: boolean; roleId?: string }) =>
    post(`/projects/${pid}/members`, m),
  updateMember: (pid: string, uid: string, m: { companyId?: string | null; isProjectAdmin?: boolean }) =>
    patch(`/projects/${pid}/members/${uid}`, m),
  removeMember: (pid: string, uid: string) => del(`/projects/${pid}/members/${uid}`),
  activity: (pid: string) => get<AuditEntryDto[]>(`/projects/${pid}/activity`),

  namingStandards: (pid: string) => get<NamingStandardDto[]>(`/projects/${pid}/naming-standards`),
  createNamingStandard: (pid: string, s: NamingStandard) => post<NamingStandardDto>(`/projects/${pid}/naming-standards`, s),
  updateNamingStandard: (pid: string, sid: string, s: NamingStandard) =>
    put<NamingStandardDto>(`/projects/${pid}/naming-standards/${sid}`, s),
  // asset=3: copies cached as immutable before 24.10.2026 (asset=2) would keep the coarse-curve
  // derivative and never ask the server, which also rebuilds it on that request.
  modelUrl: (pid: string, vid: string) => `/api/v1/projects/${pid}/versions/${vid}/model?asset=3`,
  models: (pid: string) => get<ModelVersion[]>(`/projects/${pid}/models`),

  issues: (pid: string, status?: string) => get<IssueDto[]>(`/projects/${pid}/issues${status ? `?status=${status}` : ""}`),
  issue: (pid: string, iid: string) => get<IssueDto>(`/projects/${pid}/issues/${iid}`),
  createIssue: (pid: string, i: Partial<IssueDto> & { title: string }) => post<IssueDto>(`/projects/${pid}/issues`, i),
  updateIssue: (pid: string, iid: string, i: Partial<IssueDto>) => patch<IssueDto>(`/projects/${pid}/issues/${iid}`, i),
  comments: (pid: string, iid: string) => get<IssueCommentDto[]>(`/projects/${pid}/issues/${iid}/comments`),
  addComment: (pid: string, iid: string, body: string) =>
    post<IssueCommentDto>(`/projects/${pid}/issues/${iid}/comments`, { body }),
  issueViewpoints: (pid: string, iid: string) => get<IssueViewpointDto[]>(`/projects/${pid}/issues/${iid}/viewpoints`),

  /** Downloads a .bcfzip (selected issues, or the current filter); returns the server's warnings. */
  bcfExport: async (pid: string, o: { version: BcfVersion; ids?: string[]; status?: string }): Promise<string[]> => {
    const params = new URLSearchParams({ version: o.version });
    if (o.ids?.length) params.set("ids", o.ids.join(","));
    if (o.status) params.set("status", o.status);
    const res = await fetch(`/api/v1/projects/${pid}/bcf/export?${params.toString()}`, { credentials: "same-origin" });
    if (!res.ok) {
      const data = safeJson(await res.text()) as { message?: string } | null;
      throw new ApiError(res.status, data?.message ?? `HTTP ${res.status}`, data);
    }
    const name = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get("content-disposition") ?? "")?.[1];
    const href = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = href;
    a.download = name ? decodeURIComponent(name) : "sorunlar.bcfzip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
    const warnings = res.headers.get("x-bcf-warnings");
    return warnings ? decodeURIComponent(warnings).split(" | ") : [];
  },
  bcfImportPreview: (pid: string, file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return request<BcfImportPreview>("POST", `/projects/${pid}/bcf/import/preview`, form);
  },
  bcfImport: (pid: string, file: File, mapping: BcfImportMapping) => {
    const form = new FormData();
    form.append("mapping", JSON.stringify(mapping));
    form.append("file", file, file.name);
    return request<BcfImportResult>("POST", `/projects/${pid}/bcf/import`, form);
  },

  workflowTemplates: (pid: string, kind?: WorkflowKind) =>
    get<WorkflowTemplateDto[]>(`/projects/${pid}/workflow-templates${kind ? `?kind=${kind}` : ""}`),
  createWorkflowTemplate: (pid: string, t: WorkflowTemplateInput) =>
    post<WorkflowTemplateDto>(`/projects/${pid}/workflow-templates`, t),
  updateWorkflowTemplate: (pid: string, tid: string, t: WorkflowTemplateInput) =>
    put<WorkflowTemplateDto>(`/projects/${pid}/workflow-templates/${tid}`, t),
  deleteWorkflowTemplate: (pid: string, tid: string) => del(`/projects/${pid}/workflow-templates/${tid}`),

  reviews: (pid: string, status?: string) =>
    get<ReviewSummaryDto[]>(`/projects/${pid}/reviews${status ? `?status=${status}` : ""}`),
  review: (pid: string, rid: string) => get<ReviewDetailDto>(`/projects/${pid}/reviews/${rid}`),
  startReview: (
    pid: string,
    r: StartReviewInput,
  ) => post<ReviewDetailDto>(`/projects/${pid}/reviews`, r),
  previewReview: (pid: string, r: StartReviewInput) => post<ReviewPreview>(`/projects/${pid}/reviews/preview`, r),
  submitReview: (
    pid: string,
    rid: string,
    body: {
      comment?: string | null;
      files: { reviewFileId: string; outcome: OutcomeCode | string; comment?: string | null }[];
      attributes?: Record<string, Record<string, string>>;
    },
  ) => post<ReviewDetailDto>(`/projects/${pid}/reviews/${rid}/submit`, body),
  cancelReview: (pid: string, rid: string, comment?: string) =>
    post<ReviewDetailDto>(`/projects/${pid}/reviews/${rid}/cancel`, { comment: comment || null }),
  reassignReview: (pid: string, rid: string, assignees: WorkflowAssignee[]) =>
    post<ReviewDetailDto>(`/projects/${pid}/reviews/${rid}/reassign`, { assignees }),
  reviewFileDownloadUrl: (pid: string, rid: string, rfid: string) =>
    `/api/v1/projects/${pid}/reviews/${rid}/files/${rfid}/download`,
  notifications: () => get<NotificationDto[]>("/notifications"),
  notificationCount: () => get<{ unread: number }>("/notifications/count"),
  readNotification: (id: string) => post<NotificationDto>(`/notifications/${id}/read`),
  readAllNotifications: () => post("/notifications/read-all"),
  myTasks: () => get<MyTaskDto[]>("/my-tasks"),
  // PDF viewer, markups and issue links
  contentUrl: (pid: string, vid: string) => `/api/v1/projects/${pid}/versions/${vid}/content`,
  versionInfo: (pid: string, vid: string) => get<VersionInfoDto>(`/projects/${pid}/versions/${vid}/info`),
  markups: (pid: string, vid: string) => get<MarkupDto[]>(`/projects/${pid}/versions/${vid}/markups`),
  createMarkup: (pid: string, vid: string, m: { page: number; shapes: MarkupShape[]; published?: boolean }) =>
    post<MarkupDto>(`/projects/${pid}/versions/${vid}/markups`, m),
  updateMarkup: (pid: string, mid: string, m: { page?: number; shapes?: MarkupShape[] }) =>
    patch<MarkupDto>(`/projects/${pid}/markups/${mid}`, m),
  deleteMarkup: (pid: string, mid: string) => del(`/projects/${pid}/markups/${mid}`),
  publishMarkup: (pid: string, mid: string) => post<MarkupDto>(`/projects/${pid}/markups/${mid}/publish`),
  versionIssueLinks: (pid: string, vid: string) => get<IssueLinkDto[]>(`/projects/${pid}/versions/${vid}/issue-links`),
  issueLinks: (pid: string, iid: string) => get<IssueLinkDto[]>(`/projects/${pid}/issues/${iid}/links`),
  linkIssue: (pid: string, iid: string, kind: IssueLinkKind, targetId: string) =>
    post<IssueLinkDto>(`/projects/${pid}/issues/${iid}/links`, { kind, targetId }),
  unlinkIssue: (pid: string, iid: string, lid: string) => del(`/projects/${pid}/issues/${iid}/links/${lid}`),

  // Project roles (teams), role packages, who can see
  roles: (pid: string) => get<ProjectRoleDto[]>(`/projects/${pid}/roles`),
  createRole: (pid: string, r: { name: string; description?: string | null; color?: string | null }) =>
    post<ProjectRoleDto>(`/projects/${pid}/roles`, r),
  updateRole: (pid: string, rid: string, r: { name?: string; description?: string | null; color?: string | null }) =>
    patch<ProjectRoleDto>(`/projects/${pid}/roles/${rid}`, r),
  deleteRole: (pid: string, rid: string) => del<{ ok: true; removedGrants: number }>(`/projects/${pid}/roles/${rid}`),
  addRoleMember: (pid: string, rid: string, uid: string) => post<ProjectRoleDto>(`/projects/${pid}/roles/${rid}/members/${uid}`),
  removeRoleMember: (pid: string, rid: string, uid: string) => del<ProjectRoleDto>(`/projects/${pid}/roles/${rid}/members/${uid}`),
  rolePackages: (pid: string) => get<RolePackage[]>(`/projects/${pid}/role-packages`),
  previewRolePackage: (pid: string, b: { companyId: string; package: RolePackageKey; areaFolderId?: string | null }) =>
    get<RolePackagePlanDto>(
      `/projects/${pid}/role-packages/preview?companyId=${b.companyId}&package=${b.package}${b.areaFolderId ? `&areaFolderId=${b.areaFolderId}` : ""}`,
    ),
  applyRolePackage: (pid: string, b: { companyId: string; package: RolePackageKey; areaFolderId?: string | null }) =>
    post<RolePackagePlanDto>(`/projects/${pid}/role-packages/apply`, b),
  // IFC version comparison
  modelVersions: (pid: string) => get<ModelVersion[]>(`/projects/${pid}/models?all=1`),
  compare: (pid: string, from: string, to: string) =>
    get<VersionCompareDto>(`/projects/${pid}/compare?from=${from}&to=${to}`),
  compareSummary: (pid: string, from: string, to: string, ai: boolean, signal?: AbortSignal) =>
    request<CompareSummaryDto>("POST", `/projects/${pid}/compare/summary`, { from, to, ai }, signal),
  compareReportUrl: (pid: string, from: string, to: string) => `/api/v1/projects/${pid}/compare/report?from=${from}&to=${to}`,

  // "Modele sor"
  modelVocab: (pid: string, vid: string, compareFrom?: string | null, versionIds?: string[]) => {
    const qs = new URLSearchParams();
    if (compareFrom) qs.set("compareFrom", compareFrom);
    if (versionIds && versionIds.length > 1) qs.set("versions", versionIds.join(","));
    return get<ModelVocabDto>(`/projects/${pid}/versions/${vid}/model-vocab${qs.size ? `?${qs}` : ""}`);
  },
  modelQuery: (pid: string, vid: string, query: ModelQuery, compareFrom?: string | null, versionIds?: string[]) =>
    post<ModelQueryResultDto>(`/projects/${pid}/versions/${vid}/model-query`, {
      query,
      ...(compareFrom ? { compareFrom } : {}),
      ...(versionIds && versionIds.length > 1 ? { versionIds } : {}),
    }),
  modelAsk: (
    pid: string,
    vid: string,
    question: string,
    opts: {
      compareFrom?: string | null;
      versionIds?: string[];
      mode?: "auto" | "rules";
      refresh?: boolean;
      provider?: AiProviderSelection;
      model?: string;
      signal?: AbortSignal;
    } = {},
  ) =>
    request<ModelAskResultDto>(
      "POST",
      `/projects/${pid}/versions/${vid}/model-ask`,
      {
        question,
        mode: opts.mode ?? "auto",
        provider: opts.provider ?? "project",
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.compareFrom ? { compareFrom: opts.compareFrom } : {}),
        ...(opts.versionIds && opts.versionIds.length > 1 ? { versionIds: opts.versionIds } : {}),
        ...(opts.refresh ? { refresh: true } : {}),
      },
      opts.signal,
    ),
  modelReportDraft: (pid: string, vid: string, query: ModelQuery, question?: string | null) =>
    post<ReportDraft>(`/projects/${pid}/versions/${vid}/model-query/report-draft`, { query, question: question ?? null }),

  // Locations
  locations: (pid: string) => get<LocationDto[]>(`/projects/${pid}/locations`),
  createLocation: (pid: string, l: LocationInput) => post<LocationDto>(`/projects/${pid}/locations`, l),
  updateLocation: (pid: string, lid: string, l: Partial<LocationInput>) => patch<LocationDto>(`/projects/${pid}/locations/${lid}`, l),
  deleteLocation: (pid: string, lid: string, force = false) =>
    del<{ ok: true; nodes: number; links: number }>(`/projects/${pid}/locations/${lid}${force ? "?force=1" : ""}`),
  importLocationsCsv: (pid: string, csv: string, parentId?: string | null) =>
    post<{ created: number; updated: number; total: number }>(`/projects/${pid}/locations/import-csv`, { csv, parentId: parentId ?? null }),
  importLocationsIfc: (pid: string, fileVersionId: string, parentId?: string | null) =>
    post<{ jobId: string; status: string }>(`/projects/${pid}/locations/import-ifc`, { fileVersionId, parentId: parentId ?? null }),
  locationImportJob: (pid: string, jobId: string) =>
    get<{ jobId: string; status: string; error: string | null; result: { created: number; updated: number; total: number } | null }>(
      `/projects/${pid}/locations/import-jobs/${jobId}`,
    ),
  locationLinks: (pid: string, q: { kind?: LocationLinkKind; targetId?: string; locationId?: string; subtree?: boolean }) => {
    const qs = new URLSearchParams();
    if (q.kind) qs.set("kind", q.kind);
    if (q.targetId) qs.set("targetId", q.targetId);
    if (q.locationId) qs.set("locationId", q.locationId);
    if (q.subtree) qs.set("subtree", "1");
    return get<LocationLinkDto[]>(`/projects/${pid}/location-links?${qs.toString()}`);
  },
  setLocationLink: (pid: string, kind: LocationLinkKind, targetId: string, locationId: string | null) =>
    put(`/projects/${pid}/location-links`, { kind, targetId, locationId }),

  // Form templates (the Field module's own client: sitekeep-field web/api.ts)
  formTemplates: (pid: string) => get<FormTemplateDto[]>(`/projects/${pid}/form-templates`),
  reportCatalog: (pid: string) => get<ReportCatalogDto>(`/projects/${pid}/reports/catalog`),
  reports: (pid: string) => get<DashboardSummaryDto[]>(`/projects/${pid}/reports`),
  report: (pid: string, id: string) => get<DashboardDto>(`/projects/${pid}/reports/${id}`),
  createReport: (
    pid: string,
    r: Partial<ReportDraft> & { templateId?: string; sharing?: ReportSharing },
  ) => post<DashboardDto>(`/projects/${pid}/reports`, r),
  updateReport: (
    pid: string,
    id: string,
    r: Partial<ReportDraft> & { sharing?: ReportSharing; baseVersion?: number },
  ) => patch<DashboardDto>(`/projects/${pid}/reports/${id}`, r),
  deleteReport: (pid: string, id: string) => del(`/projects/${pid}/reports/${id}`),
  reportData: (pid: string, id: string) => get<ReportDataResult>(`/projects/${pid}/reports/${id}/data`),
  reportVersions: (pid: string, id: string) => get<DashboardVersionDto[]>(`/projects/${pid}/reports/${id}/versions`),
  restoreReportVersion: (pid: string, id: string, v: number) =>
    post<DashboardDto>(`/projects/${pid}/reports/${id}/versions/${v}/restore`),
  runReportQueries: (pid: string, queries: ReportQueryRef[]) =>
    post<ReportDataResult>(`/projects/${pid}/reports/query`, { queries, strict: false }),
  // Document intelligence (title block, naming suggestion, specification register)
  specRegisters: (pid: string) => get<SubmittalRegisterSummaryDto[]>(`/projects/${pid}/docintel/spec-registers`),
  specRegister: (pid: string, rid: string) => get<SubmittalRegisterDto>(`/projects/${pid}/docintel/spec-registers/${rid}`),
  updateSpecRegister: (pid: string, rid: string, items: SubmittalRegisterItem[]) =>
    put<SubmittalRegisterDto>(`/projects/${pid}/docintel/spec-registers/${rid}`, { items }),
  specRegisterExportUrl: (pid: string, rid: string, format: "csv" | "xlsx" | "json") =>
    `/api/v1/projects/${pid}/docintel/spec-registers/${rid}/export?format=${format}`,
  // Document revision comparison
  docCompare: (pid: string, from: string, to: string, rebuild = false) =>
    get<DocCompareDto>(`/projects/${pid}/doc-compare?from=${from}&to=${to}${rebuild ? "&rebuild=1" : ""}`),
  docComparison: (pid: string, cid: string) => get<DocCompareDto>(`/projects/${pid}/doc-compare/${cid}`),
  saveCompareRegions: (pid: string, cid: string, pages: PageRegions[]) =>
    put<DocCompareDto>(`/projects/${pid}/doc-compare/${cid}/regions`, { pages }),
  startCompareSummary: (pid: string, cid: string, force = false) =>
    post<DocCompareDto>(`/projects/${pid}/doc-compare/${cid}/summary`, { force }),
  compareReviewNote: (pid: string, cid: string, reviewId: string) =>
    post<{ ok: boolean }>(`/projects/${pid}/doc-compare/${cid}/review-note`, { reviewId }),
  compareReport: async (pid: string, cid: string, thumbnails: { page: number; image: string }[]): Promise<{ blob: Blob; name: string }> => {
    const res = await fetch(`/api/v1/projects/${pid}/doc-compare/${cid}/report`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ thumbnails }),
    });
    if (!res.ok) {
      const data = safeJson(await res.text()) as { message?: string } | null;
      throw new ApiError(res.status, data?.message ?? `HTTP ${res.status}`, data);
    }
    const cd = res.headers.get("content-disposition") ?? "";
    const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
    return { blob: await res.blob(), name: m ? decodeURIComponent(m[1]!) : "karsilastirma.pdf" };
  },
  generateReport: (
    pid: string,
    r: { prompt: string; dashboardId?: string; current?: ReportDraft; module?: ReportModule; datasets?: string[] },
  ) => post<ReportGenerateResult>(`/projects/${pid}/reports/generate`, r),
  /** Change stamp of a saved dashboard's data (live refresh polls this). */
  reportStamp: (pid: string, id: string) => get<ReportStampDto>(`/projects/${pid}/reports/${id}/stamp`),
  /** Change stamp of the data behind some datasets (unsaved drafts). */
  reportStampFor: (pid: string, datasets: string[]) =>
    get<ReportStampDto>(`/projects/${pid}/reports/stamp?datasets=${encodeURIComponent(datasets.join(","))}`),
  /** "Yapay zekâ ile onar": a corrected spec for one broken query (not saved). */
  repairReportQuery: (pid: string, id: string, queryId: string) =>
    post<ReportRepairResult>(`/projects/${pid}/reports/${id}/repair`, { queryId }),

  // Model coordination
  modelSets: (pid: string) => get<ModelSetDto[]>(`/projects/${pid}/model-sets`),
  modelSet: (pid: string, sid: string) => get<ModelSetDto>(`/projects/${pid}/model-sets/${sid}`),
  createModelSet: (pid: string, s: { name: string; description?: string | null; items: ModelSetItem[] }) =>
    post<ModelSetDto>(`/projects/${pid}/model-sets`, s),
  updateModelSet: (pid: string, sid: string, s: { name?: string; description?: string | null; items?: ModelSetItem[] }) =>
    patch<ModelSetDto>(`/projects/${pid}/model-sets/${sid}`, s),
  deleteModelSet: (pid: string, sid: string) => del(`/projects/${pid}/model-sets/${sid}`),
  saveModelSetView: (pid: string, sid: string, name: string, state: ModelSetViewState) =>
    post<ModelSetViewDto>(`/projects/${pid}/model-sets/${sid}/views`, { name, state }),
  deleteModelSetView: (pid: string, sid: string, vid: string) => del(`/projects/${pid}/model-sets/${sid}/views/${vid}`),
  clashTests: (pid: string) => get<ClashTestDto[]>(`/projects/${pid}/clash-tests`),
  clashTest: (pid: string, tid: string) => get<ClashTestDto>(`/projects/${pid}/clash-tests/${tid}`),
  createClashTest: (pid: string, t: ClashTestInput) => post<ClashTestDto>(`/projects/${pid}/clash-tests`, t),
  updateClashTest: (pid: string, tid: string, t: Partial<ClashTestInput>) => patch<ClashTestDto>(`/projects/${pid}/clash-tests/${tid}`, t),
  deleteClashTest: (pid: string, tid: string) => del(`/projects/${pid}/clash-tests/${tid}`),
  runClashTest: (pid: string, tid: string) => post<ClashRunDto>(`/projects/${pid}/clash-tests/${tid}/run`),
  clashResults: (pid: string, tid: string) => get<ClashResultsDto>(`/projects/${pid}/clash-tests/${tid}/results`),
  clash: (pid: string, tid: string, cid: string) =>
    get<ClashDto & { group: ClashGroupDto | null; test: { id: string; name: string; type: string; canManage: boolean } }>(
      `/projects/${pid}/clash-tests/${tid}/clashes/${encodeURIComponent(cid)}`,
    ),
  setClashStatus: (pid: string, tid: string, cid: string, status: "active" | "resolved" | "approved") =>
    patch<ClashDto>(`/projects/${pid}/clash-tests/${tid}/clashes/${encodeURIComponent(cid)}`, { status }),
  updateClashGroup: (
    pid: string,
    tid: string,
    gid: string,
    g: { status?: "active" | "resolved" | "approved"; assignedCompanyId?: string | null },
  ) => patch<ClashGroupDto>(`/projects/${pid}/clash-tests/${tid}/groups/${gid}`, g),
  clashGroupIssue: (
    pid: string,
    tid: string,
    gid: string,
    body: { title?: string; priority?: string; dueDate?: string | null; viewpoint?: IssueViewpoint | null },
  ) => post<{ issueId: string; number: number; title: string }>(`/projects/${pid}/clash-tests/${tid}/groups/${gid}/issue`, body),
  clashSummary: (pid: string, tid: string) => post<ClashSummaryDto>(`/projects/${pid}/clash-tests/${tid}/summary`),
  idsReports: (pid: string) => get<IdsReportDto[]>(`/projects/${pid}/ids-reports`),
  idsReport: (pid: string, rid: string) => get<IdsReportDto>(`/projects/${pid}/ids-reports/${rid}`),
  runIds: (pid: string, idsVersionId: string, ifcVersionId: string) =>
    post<IdsReportDto>(`/projects/${pid}/ids-reports`, { idsVersionId, ifcVersionId }),
  deleteIdsReport: (pid: string, rid: string) => del(`/projects/${pid}/ids-reports/${rid}`),
  idsCsvUrl: (pid: string, rid: string) => `/api/v1/projects/${pid}/ids-reports/${rid}/csv`,
};

export interface LocationInput {
  parentId?: string | null;
  name: string;
  code?: string | null;
  type?: string | null;
  kmStart?: string | number | null;
  kmEnd?: string | number | null;
  sortOrder?: number;
}

export interface ClashTestInput {
  name: string;
  modelSetId: string;
  selectionA: ClashSelection;
  selectionB: ClashSelection;
  type: "hard" | "clearance";
  toleranceMm: number;
  groupBy: "elementA" | "storey" | "classPair" | "system";
}

export interface WorkflowTemplateInput {
  kind: WorkflowKind;
  name: string;
  steps: WorkflowStep[];
  finalOutcomes: FinalOutcomeMap;
  chain?: ReviewChainConfig;
}

export interface StartReviewInput {
  name?: string | null;
  note?: string | null;
  templateId: string;
  versionIds: string[];
  targetFolderId?: string | null;
  targetPattern?: string | null;
  targetFallback?: boolean;
}

export interface ReviewPreview {
  ok: boolean;
  problems: string[];
  code: string | null;
  steps: WorkflowStep[];
  targetFolderPath: string | null;
  targetPattern: string | null;
  files: { versionId: string; name: string; values: Record<string, string>; targetPath: string | null; unresolved: string[] }[];
}

export { dataLocale, formatDate, formatDay, formatNumber, formatPercent, formatRelative, formatSize, intlLocale } from "../lib/format";
