// End-to-end scenarios without MCP (CI or a developer):
//   npm run scenarios                       all scenarios on a fresh in-memory database
//   npm run scenarios -- rapor inceleme     only these
//   CDE_URL=http://127.0.0.1:8787 CDE_MCP_TOKEN=… npm run scenarios
//                                           against a running dev server (CDE_DEV_TOOLS=1,
//                                           a system administrator's write token)
// Exit code 1 when a scenario fails.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app/build-app.js";
import { hashPassword } from "../src/core/security/auth.js";
import { openDb } from "../src/db/index.js";
import { users } from "../src/db/schema.js";
import { JobQueue } from "../src/jobs/queue.js";
import { LocalStorage } from "../src/core/platform/storage.js";

interface Result {
  passed: number;
  failed: number;
  project: string;
  table: string;
  results: { scenario: string; ok: boolean }[];
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const body = wanted.length ? { scenarios: wanted } : {};

async function remote(url: string, token: string): Promise<Result> {
  const res = await fetch(`${url.replace(/\/+$/, "")}/api/v1/dev/tools/cde_dev_scenario`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return JSON.parse(text) as Result;
}

async function local(): Promise<Result> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "7dcde-scenarios-"));
  const { db, kind, close } = await openDb("memory://");
  const storage = new LocalStorage(path.join(dataDir, "storage"));
  const jobs = new JobQueue(db, storage);
  const app = await buildApp({ db, storage, jobs, devTools: true, dbKind: kind });
  try {
    const password = randomBytes(18).toString("base64url");
    await db.insert(users).values({ email: "senaryo@ornek.test", name: "Senaryo Yöneticisi", passwordHash: await hashPassword(password), isAdmin: true });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "senaryo@ornek.test", password } });
    const cookie = `cde_session=${login.cookies.find((c) => c.name === "cde_session")!.value}`;
    await app.inject({ method: "PUT", url: "/api/v1/admin/settings/mcp", headers: { cookie }, payload: { allowWriteTokens: true } });
    const tok = await app.inject({ method: "POST", url: "/api/v1/auth/tokens", headers: { cookie }, payload: { name: "senaryolar", scope: "write" } });
    const token = (tok.json() as { token: string }).token;
    const res = await app.inject({ method: "POST", url: "/api/v1/dev/tools/cde_dev_scenario", headers: { authorization: `Bearer ${token}` }, payload: body });
    if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}: ${res.body}`);
    return res.json() as Result;
  } finally {
    await app.close();
    await close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const url = process.env.CDE_URL;
const token = process.env.CDE_MCP_TOKEN ?? process.env.CDE_TOKEN;
const t0 = Date.now();
const r = url && token ? await remote(url, token) : await local();
console.log(r.table);
console.log(`\n${r.passed} senaryo geçti, ${r.failed} senaryo kaldı (${Math.round((Date.now() - t0) / 1000)} sn, proje ${r.project}).`);
process.exit(r.failed ? 1 : 0);
