// Smoke test against a running dev server: creates an API token for the dev admin,
// starts the MCP server over stdio and calls a few read tools.
//   node --env-file=../server/.env.development scripts/smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const url = `http://127.0.0.1:${process.env.PORT ?? 8787}`;
const login = await fetch(`${url}/api/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
});
const cookie = login.headers.get("set-cookie").split(";")[0];
const tokenRes = await fetch(`${url}/api/v1/auth/tokens`, {
  method: "POST",
  headers: { cookie, "content-type": "application/json" },
  body: JSON.stringify({ name: "mcp smoke test" }),
});
const { id: tokenId, token } = await tokenRes.json();

const client = new Client({ name: "smoke", version: "0" });
await client.connect(
  new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, CDE_URL: url, CDE_TOKEN: token } }),
);
try {
  const tools = await client.listTools();
  console.log(`${tools.tools.length} tools:`, tools.tools.map((t) => t.name).join(", "));
  const projects = JSON.parse((await client.callTool({ name: "cde_projects_list", arguments: {} })).content[0].text);
  console.log("projects:", projects.map((p) => p.code).join(", "));
  const tree = await client.callTool({ name: "cde_folder_tree", arguments: { projectId: projects[0].id, depth: 2 } });
  console.log(tree.content[0].text.slice(0, 600));
  const check = await client.callTool({
    name: "cde_naming_validate",
    arguments: { projectId: projects[0].id, folderId: JSON.parse(tree.content[0].text).children[0].id, names: ["ZAVM-PAS-ZZ-A-01-0101-DR-CD-0007.pdf", "yanlis.pdf"] },
  });
  console.log(check.content[0].text.slice(0, 400));
} finally {
  await client.close();
  await fetch(`${url}/api/v1/auth/tokens/${tokenId}`, { method: "DELETE", headers: { cookie } });
}
