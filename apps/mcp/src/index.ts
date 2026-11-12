#!/usr/bin/env node
/**
 * SiteKeep MCP server (stdio). The tools live in @sitekeep/cde-tools and are shared with the MCP
 * endpoint hosted by the CDE server itself (https://cde.example.local/mcp). Use this stdio server
 * when the client needs local file access (upload from / download to local paths).
 *
 * Environment:
 *   CDE_URL    server address, e.g. https://cde.example.local (default http://127.0.0.1:8080)
 *   CDE_TOKEN  API token created under "Hesabım → API token'ları"
 *   CDE_READ_ONLY=1  disables write tools
 *   CDE_DEV_TOOLS=1  adds the developer tools (cde_dev_*); the CDE server must also run with
 *                    CDE_DEV_TOOLS=1 and the token must be a system administrator's write token
 *   Local development server: CDE_URL=http://127.0.0.1:8787 (docs/onboarding/DEVELOPER_MCP.md)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CdeError, cdeInstructions, cdeResult, registerCdeTools, type CdeCall } from "@sitekeep/cde-tools";

const BASE = (process.env.CDE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "") + "/api/v1";
const TOKEN = process.env.CDE_TOKEN ?? "";
const READ_ONLY = process.env.CDE_READ_ONLY === "1";
const DEV_TOOLS = process.env.CDE_DEV_TOOLS === "1";
const MAX_OUTPUT = Number(process.env.CDE_MAX_OUTPUT ?? 60_000);

function requireToken() {
  if (!TOKEN) throw new CdeError("CDE_TOKEN tanımlı değil. CDE'de Hesabım → API erişim anahtarları bölümünden bir erişim anahtarı oluşturun.");
}

const call: CdeCall = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
  requireToken();
  const isForm = body instanceof FormData;
  const res = await fetch(BASE + url, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined && !isForm ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  return cdeResult<T>(res.status, await res.text(), isForm);
};

const server = new McpServer({ name: "sitekeep", version: "0.1.0" }, { instructions: cdeInstructions(READ_ONLY) });

/** Installed SiteKeep modules of the server; unknown (older server, no token) → every tool is listed. */
async function installedModules(): Promise<string[] | undefined> {
  if (!TOKEN) return undefined;
  try {
    const res = await fetch(BASE + "/modules", { headers: { authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { modules?: unknown };
    return Array.isArray(body.modules) ? body.modules.filter((m): m is string => typeof m === "string") : undefined;
  } catch {
    return undefined;
  }
}

registerCdeTools(server, call, {
  modules: await installedModules(),
  readOnly: READ_ONLY,
  localFiles: true,
  devTools: DEV_TOOLS && !READ_ONLY,
  maxOutput: MAX_OUTPUT,
  download: async (url) => {
    requireToken();
    return fetch(BASE + url, { headers: { authorization: `Bearer ${TOKEN}` } });
  },
});

await server.connect(new StdioServerTransport());
