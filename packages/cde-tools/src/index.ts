import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CdeCall, CdeToolDef, CdeToolsOptions } from "./core/types.js";
import type { ToolAdder } from "./core/define.js";
import { registerTools } from "./core/register.js";
import { registerCoreRestTools } from "./tools/core-rest.js";
import { registerBcfTools } from "./tools/bcf.js";
import { registerWorksTools } from "./tools/modules/works.js";
import { registerWorkWriteTools } from "./tools/modules/works-write.js";
import { registerReviewTools } from "./tools/modules/reviews.js";
import { registerFormTools, registerFormWriteTools } from "./tools/modules/forms.js";
import { registerScheduleTools } from "./tools/modules/schedule.js";
import { registerCoordinationTools } from "./tools/modules/coordination.js";
import { registerDocumentTools } from "./tools/modules/documents.js";
import { registerModelTools } from "./tools/model.js";
import { registerParamChangeTools } from "./tools/param-change.js";
import { registerReportTools } from "./tools/report.js";
import { registerAiTools } from "./tools/ai.js";
import { registerDevTools } from "./tools/dev.js";
import { TOOL_MODULES } from "./core/modules.js";
export type { CdeCall, CdeToolDef, CdeToolsOptions } from "./core/types.js";
export { CdeError, cdeParseArgs, cdeResult, cdeToolJsonSchema } from "./core/result.js";
export { capList } from "./format/lists.js";
export { TOOL_MODULES } from "./core/modules.js";
export { workRow } from "./format/works.js";
export { chainText } from "./format/workflow.js";
export { activityRow, previousSchedule, schedulePair } from "./format/schedule.js";
export { matchByName } from "./tools/report.js";
export { unusedQueryIds } from "./tools/ai.js";
export { AI_EVAL_FEATURES, DEV_SCENARIOS, PROJECT_TEMPLATES, SAMPLE_KINDS, devToolShapes, parseDevArgs, type DevToolName } from "./tools/dev.js";
export function cdeInstructions(readOnly: boolean): string { return "Tools for SiteKeep, an on-premise common data environment (folders with permissions, file versions, naming standards, IFC models, issues, works such as RFIs / submittals / meetings, reviews, forms, schedules, clash tests). " + "Navigation: cde_projects_list → cde_folder_contents (root folder by default); cde_today for the caller's tasks across projects, cde_project_today for one project's Bugün page with its summary. " + "Write tools change live project data: confirm with the user before creating, updating or uploading." + (readOnly ? " The connection is read-only; write tools are disabled." : ""); }
export function cdeToolDefinitions(call: CdeCall, options: Pick<CdeToolsOptions, "readOnly" | "localFiles" | "download" | "devTools" | "modules"> = {}): CdeToolDef[] {
  const definitions: CdeToolDef[] = [];
  const tool: ToolAdder = (name, description, shape, run, flags = {}) => { if (flags.write && options.readOnly) return; if (flags.local && !options.localFiles) return; if (flags.dev && !options.devTools) return; const module = TOOL_MODULES[name]; if (module && options.modules && !options.modules.includes(module)) return; definitions.push({ name, description, shape, write: !!flags.write, local: !!flags.local, ...(flags.dev && { dev: true }), ...(flags.destructive && { destructive: true }), run: run as CdeToolDef["run"] }); };
  registerCoreRestTools(tool, call, options); registerBcfTools(tool, call, { localFiles: options.localFiles, download: options.download }); registerWorksTools(tool, call); registerReviewTools(tool, call); registerFormTools(tool, call); registerScheduleTools(tool, call); registerCoordinationTools(tool, call); registerDocumentTools(tool, call); registerWorkWriteTools(tool, call); registerFormWriteTools(tool, call); registerModelTools(tool, call); registerParamChangeTools(tool, call); registerReportTools(tool, call); registerAiTools(tool, call); registerDevTools(tool as never, call); return definitions;
}
export function registerCdeTools(server: McpServer, call: CdeCall, options: CdeToolsOptions = {}): string[] { return registerTools(server, call, options, cdeToolDefinitions); }
