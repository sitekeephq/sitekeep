import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CdeCall, CdeToolsOptions } from "./types.js";
import type { CdeToolDef } from "./types.js";
export type DefinitionsFactory = (call: CdeCall, options?: Pick<CdeToolsOptions, "readOnly" | "localFiles" | "download" | "devTools" | "modules">) => CdeToolDef[];
export function registerTools(server: McpServer, call: CdeCall, options: CdeToolsOptions, definitions: DefinitionsFactory): string[] {
  const maxOutput = options.maxOutput ?? 60_000;
  const output = (data: unknown) => { let text = typeof data === "string" ? data : JSON.stringify(data, null, 1); if (text.length > maxOutput) text = text.slice(0, maxOutput) + `\n… (kısaltıldı, ${text.length} karakter)`; return { content: [{ type: "text" as const, text }] }; };
  const failure = (error: unknown) => ({ content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true });
  const report = async (tool: string, args: Record<string, unknown>, ok: boolean, error?: string) => { if (!options.onToolCall) return; try { await options.onToolCall({ tool, args, ok, error }); } catch { /* audit must not break calls */ } };
  const defs = definitions(call, options);
  for (const def of defs) server.registerTool(def.name, { description: def.description, inputSchema: def.shape, annotations: { readOnlyHint: !def.write, destructiveHint: !!def.destructive } }, (async (args: Record<string, unknown>) => { try { const result = output(await def.run(args ?? {})); await report(def.name, args ?? {}, true); return result; } catch (error) { await report(def.name, args ?? {}, false, error instanceof Error ? error.message : String(error)); return failure(error); } }) as never);
  return defs.map((def) => def.name);
}
