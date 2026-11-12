/**
 * The core's public surface for modules (docs/modules/README.md). A module imports the core only
 * from here (enforced by test/architecture/module-boundary.test.ts); everything else in apps/server
 * is private and may change without notice. Additions are backwards compatible; removing or
 * changing an export is a breaking SDK change.
 */
import "../app/fastify-types.js";

// Module contract and cross-module capabilities
export { defineServerModule, type DevRunner, type ReminderCounts, type ServerModule, type TaskSource } from "./module.js";
export { capability, provideCapability, type Capabilities, type FormSummary, type PlanningSchedule } from "./capabilities.js";

// App, database, storage
export type { AppDeps, ResolvedDeps } from "../app/deps.js";
export type { Db } from "../db/index.js";
export type { Storage } from "../core/platform/storage.js";
export * from "./schema.js";

// HTTP errors, audit, access
export { HttpError, badRequest, conflict, forbidden, notFound } from "../core/platform/http.js";
export { audit } from "../core/platform/audit.js";
export { FolderTree, isUuid, projectAccess, requireAction, requireProjectAdmin, userNames, type AuthUser, type ProjectAccess } from "../core/security/access.js";
export { projectModules, requireModule } from "../projects/modules.js";

// i18n
export { DEFAULT_LANGUAGE, intlLocale, labelFor, msg, profileLanguage, render, requestLanguage, tFor, tReq, type Msg, type MsgKey } from "../i18n/index.js";

// Formats
export { readXlsx, writeXlsx, type Cell, type Sheet } from "../core/formats/xlsx.js";
export { pdfFontBytes } from "../core/formats/pdf-fonts.js";
export { extractJson } from "../reports/llm.js";
export { buildLines, type Segment } from "../docintel/text.js";

// Documents
export { effectiveDefinitions, loadVersion, requireView } from "../modules/documents/public.js";
export { loadFile } from "../modules/documents/files.js";
export { addVersion, afterVersionAdded, newVersionBlocker } from "../files/new-version.js";

// Workflow engine and notifications
export { assigneeMatches, combineStepOutcomes, finalOutcome, isAssignee, isStepComplete, stepDueDate, type StepSubmission } from "../workflow/engine.js";
export { parseTemplateBody } from "../workflow/template-schemas.js";
export type { TemplateSnapshot } from "../db/schema-workflow.js";
export { actorFor, notify, projectMemberRows, resolveAssigneeUsers } from "../workflow/service.js";

// Models: versions, element index, query, rules, comparison
export { ModelAiError } from "../model/ai.js";
export { ModelIndex, builtinField, compactFold, type ElementView } from "../model/model-index.js";
export { classMatcher, looseEquals, matchCandidates, normalizeQuery, versionCandidates, type Candidate, type Ctx } from "../model/query.js";
export { findStorey } from "../model/rules.js";
export {
  evaluateRules,
  isEmptyMatch,
  matchRule,
  normalizeMatch,
  previewRules,
  ruleMatchSchema,
  ruleQuery,
  type RuleTarget,
} from "../model/rule-match.js";
export { ensureOpeningsIndex, ifcVersion, preparing, versionModelIndex, type LoadedVersion } from "../model/service.js";
export { abortOnClose, loadComparePair, type ComparePair } from "../model/compare.js";
export { cleanAiQuery, vocabText } from "../model/ai.js";
export { indexForVersionId } from "../model/service.js";

// Reports: dataset registry
export { fileVisibility, folderInfo, iso, labelValues, reportDatasets, type FolderInfo, type ReportContext } from "../reports/datasets.js";

// Locations (location tree and links of issues, forms and files)
export { loadLocations, requireLocation, setLocationLink, subtreeIds } from "../locations/location-links.js";
export { locationPaths } from "../locations/paths.js";

// Model sets, IDS jobs and job workers (core coordination); issues
export { context as coordinationContext, fileVisible, loadSet, setsById, type Ctx as CoordinationCtx } from "../coordination/routes/coordination.js";
export { envNumber, isIfc, resolveItems, runWorker, workerFile } from "../coordination/service.js";
export { insertIssue } from "../coordination/routes/issues.js";
export { viewerStateFields } from "../bcf/viewpoint-schema.js";
export { wasmDir, type JobQueue, type JobRow } from "../jobs/queue.js";
export type { ParamWorkerItem, ParamWorkerOutcome } from "../jobs/param-change-worker.js";

// API contracts of Coordinate (parameter changes), shared with the AI features
export { paramPlanSchema, paramQuerySchema, setListSchema } from "../contracts/param-change.js";

// API contracts of Field (form templates, flows), shared with the AI features
export { flowOutputSchema, formTemplateInput, namingOutputSchema, templateCodeSchema, templateSchemaSchema, withIds } from "../contracts/forms.js";

// Installed SiteKeep modules (SITEKEEP_MODULES): a module offers what depends on another module only
// when that one is installed (the AI module's form, minutes, RFI and parameter-change features)
export { editionName, moduleIds, moduleInstalled } from "../app/module-ids.js";

// AI: the core's door to a model (ai/provider.ts; "off" without the AI module), settings, hosts,
// the in-process override (task queue, evaluation) and what the AI module's engine needs
export {
  AiError,
  aiInstalled,
  resolveProvider,
  resolveProviderSetup,
  resolveSelectedProvider,
  stripThinking,
  stripThinkingPartial,
  type AiProvider,
  type AiProviderSelection,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type ProviderConfig,
  type ToolCall,
  type ToolSpec,
} from "../ai/provider.js";
export {
  AI_MODES,
  externalAllowed,
  externalClientAllowed,
  getAiMode,
  getAiTaskQueueSettings,
  getDefaultProviderId,
  getMcpSettings,
  getProjectAiPolicy,
  getProviders,
  getSetting,
  getStoredAiMode,
  getStoredAiTaskQueueSettings,
  putSetting,
  toProviderDto,
  type ProviderKind,
  type StoredProvider,
} from "../ai/settings.js";
export { isExternalUrl } from "../ai/hosts.js";
export { adminSettingsDto } from "../admin/settings.js";
export { AnswerProvider, CANDIDATE_INVALID, CaptureProvider, MeteredProvider, PROMPT_CAPTURED, overrideProvider, withProvider } from "../ai/override.js";
export { bridgedCall, bridgedRaw, type RawCall } from "../core/platform/inprocess.js";
export { decryptSecret, encryptSecret } from "../core/platform/secrets.js";
export { OutboundBlockedError, outboundCall, outboundFetch } from "../privacy/outbound.js";
export { connectionDisabled, killSwitchOn, privacyState } from "../privacy/settings.js";
export { projectPeople } from "../privacy/people.js";
export { Redactor, type RedactPerson } from "../privacy/redact.js";
export { moduleDisabled, modulesOf } from "../projects/modules.js";
// Works engine (İşler: work types, works, workflow, links, events): Manage builds its categories on it
export {
  addDaysIso,
  addEvent,
  companyNames,
  createWork,
  isClosed,
  loadVisibleWork,
  projectTypes,
  requireEdit,
  toSummary,
  todayIso,
  viewerOf,
  type LinkInput,
  type TypeRow,
  type WorkRow,
} from "../works/service.js";
export { ballInCourt, flowDto, loadFlowRows, nameBook, revisionDto, revisionsOf, rollupParent, runsWorkflow } from "../works/workflow.js";
export { flowState, visibleWorks } from "../works/detail.js";
export { meetingDataOf } from "../works/meeting-data.js";
export { participantWorkIds } from "../works/participants.js";
export { pdfFonts } from "../works/pdf.js";
export { UPLOAD_TTL_MS, signUpload } from "../works/intake-upload.js";
export { requireWorkModule } from "../projects/modules.js";
export { cleanFileName } from "../modules/documents/files.js";
// Document text (record from file: PDF text layer, office text, dates)
export { extractPdfText } from "../docintel/extract.js";
export { parseDate } from "../docintel/text.js";
export { officeText } from "../previews/office-text.js";
export { aiProviderFor } from "../docintel/service.js";
// Connect: Autodesk import (files, versions, records), office editing (WOPI, discovery, proof)
export { assertDirectWriteAllowed } from "../workflow/service.js";
export { ensureBuiltInTypes } from "../works/service.js";
export { standardForFolder } from "../modules/documents/naming-routes.js";
export { hashPassword, hashToken } from "../core/security/auth.js";
export { outboundRefusal, withOutboundContext } from "../privacy/outbound.js";
export type { FileRow, VersionRow } from "../files/new-version.js";
export { buildActionUrl, findAction, toPublicUrl } from "../office/discovery.js";
export { verifyProof } from "../office/proof.js";
export type { OfficeIntegration } from "../office/service.js";
export type { OfficeConfig } from "../office/settings.js";
export type { WopiPermissionSnapshot } from "../db/schema.js";
// Output schemas of the core's AI-backed routes (the AI module's feature catalog validates against them)
export { modelQuerySchema } from "../model/query.js";
export { reportDraftSchema } from "../reports/draft.js";
export { actionsSchema, intakeAiSchema, rfiSchema, type IntakeAiAnswer } from "../contracts/works.js";
export { translationSchema } from "../works/letter-translate.js";
export { letterPatchSchema } from "../works/letter.js";
export { workflowTemplateBodySchema } from "../workflow/template-schemas.js";
// MCP tool catalogue (@sitekeep/cde-tools): the AI module serves it over MCP and to "Sor"
export {
  cdeInstructions,
  cdeParseArgs,
  cdeResult,
  cdeToolJsonSchema,
  schedulePair,
  CdeError,
  type CdeCall,
  type CdeToolDef,
} from "@sitekeep/cde-tools";
// The catalogue offers only the installed modules' tools (no 404s for tools of modules that are not here)
export { cdeToolDefinitions, registerCdeTools } from "../core/platform/cde-tools.js";
// Developer tools (CDE_DEV_TOOLS=1): helpers for a module's cde_dev_* tools
export type { DevContext } from "../dev/context.js";
export { ensureActors, ensureSeedFolder } from "../dev/actors.js";
export { findProject, readRegistry, requireTestProject, updateRegistry, type ProjectRow } from "../dev/registry.js";
export { fixture, pdfDrawing, pdfForm } from "../dev/samples.js";
export { waitForJobs } from "../dev/wait-jobs.js";
export { uploadFile } from "../dev/upload.js";

// Formats, translation and model versions (used by 5D, 4D and other model features)
export { addMonths } from "../core/formats/dates.js";
export { decodeText } from "../core/formats/text.js";
export { child, childText, children, deepText, findFirst, parseXml, type XmlNode } from "../core/formats/xml.js";
export { XlsxError, readZip } from "../core/formats/zip.js";
export { defaultTranslate, type Translate } from "../i18n/index.js";
export {
  canViewFolder,
  detailedIndex,
  newestVersions,
  visibleIfcFile,
  visibleVersion,
  versionCols,
  type ModelVersionRef,
  type SimDeps,
} from "../model/versions.js";
