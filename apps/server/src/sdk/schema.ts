/**
 * Core tables a module may read and reference (foreign keys). Modules define their own tables in
 * their package; they never write core tables directly except through SDK services.
 */
export {
  companies,
  fileVersions,
  files,
  folders,
  issues,
  jobs,
  locationLinks,
  locations,
  memberRoles,
  modelSets,
  issueLinks,
  projectCompanies,
  projectMembers,
  projectRoles,
  projectAiSettings,
  projects,
  reviews,
  systemSettings,
  tokens,
  users,
  workflowActions,
  workflowInstances,
  workflowReminders,
  workflowTemplates,
  wopiLocks,
  wopiTokens,
  workRevisions,
  workTypes,
  works,
} from "../db/schema.js";

/**
 * @deprecated The report dashboards table belongs to the Platform module since SDK 0.14.0 (its own
 * migrations; docs/modules/platform.md). Kept for modules built against older SDKs (the AI module's
 * evaluation fixture); new code asks the Platform module.
 */
export { dashboards } from "./legacy-tables.js";
