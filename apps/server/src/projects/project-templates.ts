/**
 * Compatibility facade for project template schemas, built-ins, application, export and
 * on-demand folder materialization. Keep consumers importing this module unchanged.
 */
export {
  createRequestSchema,
  namingStandardSchema,
  parseProjectTemplate,
  previewRequestSchema,
  projectTemplateSchema,
} from "./template-schemas.js";
export { builtInTemplates, templateSummaries } from "./template-built-ins.js";
export {
  assertProjectCodeFree,
  createProjectFromTemplate,
  previewProjectTemplate,
} from "./template-apply.js";
export { exportProjectTemplate } from "./template-export.js";
export { materializeFolders, virtualFolderDtos } from "./template-materialize.js";
