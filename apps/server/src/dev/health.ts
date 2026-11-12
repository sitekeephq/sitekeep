/**
 * cde_dev_health: what a developer checks first — version and commit, migrations, database kind,
 * converters, AI provider and policy, MCP settings, recent server errors and row counts per table.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { count, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "../db/schema.js";
import { getAiMode, getDefaultProviderId, getMcpSettings, getProviders, toProviderDto } from "../ai/settings.js";
import { recentServerErrors } from "../core/platform/error-ring.js";
import type { DevContext } from "./context.js";
import { isTestProject, readRegistry } from "./registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "../..");

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function gitCommit(): Promise<string | null> {
  if (process.env.GIT_COMMIT) return Promise.resolve(process.env.GIT_COMMIT);
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--short", "HEAD"], { cwd: serverRoot, timeout: 3000, windowsHide: true }, (err, out) =>
      resolve(err ? null : out.trim() || null),
    );
  });
}

async function migrations(ctx: DevContext) {
  const journal = readJson<{ entries: { tag: string }[] }>(path.join(serverRoot, "drizzle/meta/_journal.json"));
  const tags = journal?.entries.map((e) => e.tag) ?? [];
  let applied: number | null = null;
  try {
    const r = (await ctx.db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)) as unknown as
      | { rows?: { n: number }[] }
      | { n: number }[];
    const rows = Array.isArray(r) ? r : (r.rows ?? []);
    applied = Number(rows[0]?.n ?? 0);
  } catch {
    applied = null;
  }
  return { applied, total: tags.length, latest: tags.at(-1) ?? null, upToDate: applied === tags.length };
}

async function tableCounts(ctx: DevContext): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of Object.values(schema)) {
    if (!is(t, PgTable)) continue;
    try {
      const [r] = await ctx.db.select({ n: count() }).from(t as PgTable);
      out[getTableName(t as PgTable)] = Number(r?.n ?? 0);
    } catch {
      /* table missing: migrations behind */
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export async function devHealth(ctx: DevContext, opts: { errors?: number } = {}) {
  const pkg = readJson<{ version: string }>(path.join(serverRoot, "package.json"));
  const [commit, mig, counts, mode, providers, defaultProviderId, mcp, office, reg] = await Promise.all([
    gitCommit(),
    migrations(ctx),
    tableCounts(ctx),
    getAiMode(ctx.db),
    getProviders(ctx.db),
    getDefaultProviderId(ctx.db),
    getMcpSettings(ctx.db),
    ctx.deps.office.status().catch((e: Error) => ({ error: e.message })),
    readRegistry(ctx.db),
  ]);
  const projects = await ctx.db.select({ id: schema.projects.id, code: schema.projects.code, archived: schema.projects.archived }).from(schema.projects);
  const jobs = await ctx.db
    .select({ status: schema.jobs.status, n: count() })
    .from(schema.jobs)
    .groupBy(schema.jobs.status);
  return {
    server: {
      version: pkg?.version ?? null,
      commit,
      node: process.version,
      nodeEnv: process.env.NODE_ENV ?? null,
      uptimeSeconds: Math.round(process.uptime()),
      devTools: true,
    },
    database: { kind: ctx.deps.dbKind ?? "bilinmiyor", migrations: mig },
    converters: { ...ctx.deps.converters.status(), office },
    ai: {
      mode,
      defaultProviderId,
      providers: providers.map(toProviderDto),
      reportBuilder: ctx.deps.reportLlm ? "açık (AI_BASE_URL / AI_MODEL)" : "kapalı",
    },
    mcp,
    jobs: Object.fromEntries(jobs.map((j) => [j.status, Number(j.n)])),
    testProjects: projects.filter((p) => isTestProject(p, reg)).map((p) => ({ code: p.code, id: p.id, archived: p.archived, seeds: Object.keys(reg.projects[p.id]?.seeds ?? {}) })),
    recentErrors: recentServerErrors(opts.errors ?? 20),
    tableCounts: counts,
  };
}
