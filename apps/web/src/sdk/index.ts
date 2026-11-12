/**
 * The web core's public surface for modules (docs/modules/README.md). A module imports the core
 * only from here (enforced by test/architecture/module-boundary.test.ts); everything else in
 * apps/web/src is private.
 */

// Module contract and capabilities
export { defineWebModule, type WebModule } from "./module";
export { provideWebCapability, webCapability, type NewFormDialogProps, type ViewerClash, type WebCapabilities } from "./capabilities";

// App context
export { useAuth } from "../app/context/auth";
export { useLoad, useProject, useRevealOnNarrow } from "../app/context/project";
export { useEmbedded } from "../app/context/embedded";

// API client
export { ApiError, del, get, patch, post, put, qs, request } from "../shared/api/client";
export { api, type ClashTestInput, type ModelVersion } from "../shared/api/api";
export { viewersApi } from "../shared/api/api-viewers";
export { documentsApi, type FolderContents } from "../features/documents/api";

// UI
export { Dialog } from "../shared/ui/Dialog";
export { AssigneePicker, namesFrom } from "../shared/ui/AssigneePicker";
export { LoadingIndicator, LoadingSpinner } from "../shared/ui/LoadingIndicator";
export { LocationSelect } from "../shared/ui/LocationSelect";
export { MoreMenu } from "../shared/ui/MoreMenu";
export { RecordCards, usePhoneWidth } from "../shared/ui/RecordCards";
export { PdfPages, prefetchPdf } from "../features/documents/components/PdfPages";
// AI: the task queue client and shared bits (the AI module's UI is the ai.ui capability)
export { AiTaskButton, useAiTaskMode, type AiTaskButtonProps } from "../shared/ai/AiTaskButton";
export {
  AI_TASK_POLL_MS,
  aiTaskApi,
  aiTaskButtonMode,
  isOpenTask,
  waitingText,
  type AiQueueStatus,
  type AiTaskButtonMode,
  type AiTaskDto,
  type AiTaskKind,
} from "../shared/ai/ai-tasks";
export { MODE_LABEL, ModeBadge, Snippet, isExternalUrl, mcpUrl, modeLabel } from "../shared/ai/AiBits";
export { Markdown } from "../shared/ui/Markdown";
export type {
  AdminSettings,
  AiMode,
  AiProviderDto,
  AiProviderSelection,
  AiTaskQueueSettings,
  AskJob,
  AskSource,
  McpSettings,
  PersonalAiCredentialDto,
  ProjectAiDto,
  ProviderInput,
  ProviderKind,
  ProviderTestResult,
} from "../shared/api/api";
export { useAsk } from "../shared/ui/Ask";
export { ReportShortcut, reportBuilderUrl } from "../features/documents/components/ReportShortcut";

// Formatting, i18n, PDF
export { dataLocale, formatDate, formatDay, formatNumber, formatPercent, formatSize, intlLocale, money, qty, trDate } from "../shared/lib/format";

export { currentLanguage, i18n, useLabel } from "../i18n";
export { openPdf } from "../pdf/pdfjs";

// Model rules (shared by 4D and 5D)
export { RuleMatchEditor, cleanMatch, isEmptyMatch } from "../shared/ui/RuleMatchEditor";
export { useModelChoices, useVocab, type ModelChoice } from "../shared/model/model-choices";

// Works (İşler): the API clients and the create dialog Manage builds on
export { buildApi, worksApi, type LinkInput, type MinutesItemInput } from "../shared/api/api-works";
export { CreateWorkDialog, type WorkPrefill } from "../features/works/components/CreateWorkDialog";
export { WORK_SECTIONS } from "../app/navigation/nav";

// Connect: office editing and Forma sync clients and DTOs
export { clearEditorClosed, editorClosedAt, isOfficeExtension, markEditorClosed, officeApi } from "../shared/api/api-office";
export type { AutodeskCatalogDto, AutodeskConnectionDto, AutodeskDocsFileDto, AutodeskDocsListingDto, AutodeskFileImportDto, AutodeskRecordDto, AutodeskRecordKind, AutodeskSyncProgressDto } from "../shared/api/api";
export { Icon } from "../shared/ui/Icon";
