/**
 * The MCP tool catalogue for this installation: @sitekeep/cde-tools with `modules` defaulting to the
 * installed SiteKeep modules (SITEKEEP_MODULES), so MCP clients and "Sor" are never offered a tool
 * whose module is not installed. The SDK exports these in place of the package's own.
 */
import {
  cdeToolDefinitions as allToolDefinitions,
  registerCdeTools as registerAllCdeTools,
  type CdeCall,
  type CdeToolDef,
  type CdeToolsOptions,
} from "@sitekeep/cde-tools";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { moduleIds } from "../../app/module-ids.js";

type DefinitionOptions = Parameters<typeof allToolDefinitions>[1];

export function cdeToolDefinitions(call: CdeCall, options: DefinitionOptions = {}): CdeToolDef[] {
  return allToolDefinitions(call, { modules: moduleIds(), ...options });
}

export function registerCdeTools(server: McpServer, call: CdeCall, options: CdeToolsOptions = {}): string[] {
  return registerAllCdeTools(server, call, { modules: moduleIds(), ...options });
}
