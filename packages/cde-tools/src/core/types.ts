import type { z } from "zod";
export type CdeCall = <T = unknown>(method: string, url: string, body?: unknown) => Promise<T>;
export interface CdeToolDef {
  name: string; description: string; shape: Record<string, z.ZodType>; write: boolean; local: boolean; dev?: boolean; destructive?: boolean;
  run(args: Record<string, unknown>): Promise<unknown>;
}
export interface CdeToolsOptions {
  readOnly?: boolean; localFiles?: boolean; download?: (url: string) => Promise<Response>; maxOutput?: number; devTools?: boolean;
  /** Installed SiteKeep modules; when set, tools of other modules are left out (TOOL_MODULES). */
  modules?: readonly string[];
  onToolCall?: (event: { tool: string; args: Record<string, unknown>; ok: boolean; error?: string }) => void | Promise<void>;
}
