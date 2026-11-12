/**
 * cde_dev_project: test projects. Create from a template (with demo companies and members), add
 * members, set module switches, reset a test project's records or archive it (confirm: true).
 */
import { moduleTable } from "../app/modules.js";
import { and, eq, sql } from "drizzle-orm";
import {
  files,
  issues,
  modelSets,
  projects,
  reviews,
  works,
} from "../db/schema.js";
import type { DevContext } from "./context.js";
import { link } from "./context.js";
import { ensureActors, ensureDemoCompanies } from "./actors.js";
import { removeRecords } from "./seed.js";
import { HttpError } from "../core/platform/http.js";
import { TEST_CODE_RE, findProject, isTestProject, readRegistry, requireTestProject, updateRegistry, type ProjectRow } from "./registry.js";
import { projectPath } from "@sitekeep/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Slot keys of the built-in templates → demo company codes. */
const SLOT_CODES: [RegExp, string][] = [
  [/yuklenici|contractor/i, "YUK"],
  [/musavir|consultant/i, "MSV"],
  [/idare|client|owner/i, "IDR"],
  [/tasarim|designer/i, "TSR"],
];

export async function devProject(ctx: DevContext, a: Record<string, unknown>) {
  switch (a.action) {
    case "list": {
      const reg = await readRegistry(ctx.db);
      const rows = await ctx.db.select().from(projects).orderBy(projects.code);
      return rows.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        archived: p.archived,
        test: isTestProject(p, reg),
        createdByDev: !!reg.projects[p.id]?.createdByDev,
        seeds: Object.keys(reg.projects[p.id]?.seeds ?? {}),
      }));
    }
    case "create":
      return create(ctx, a);
    case "add_members": {
      const p = await findProject(ctx.db, String(a.project));
      const actors = await ensureActors(ctx, p.id);
      return { project: p.code, members: actors.all.map((x) => ({ role: x.role, company: x.code, user: x.userName })) };
    }
    case "set_modules": {
      const p = await findProject(ctx.db, String(a.project));
      return setModules(ctx, p, a.modules);
    }
    case "reset":
      return reset(ctx, a);
    case "archive": {
      const p = await findProject(ctx.db, String(a.project));
      await requireTestProject(ctx.db, p, a.confirm as boolean, "Projeyi arşivlemek");
      await ctx.call("PATCH", `/projects/${p.id}`, { archived: true });
      return { project: p.code, archived: true };
    }
    default:
      throw new Error(`Bilinmeyen işlem: ${String(a.action)}`);
  }
}

async function create(ctx: DevContext, a: Record<string, unknown>) {
  const base = String(a.code ?? `DEV-${new Date().toISOString().slice(2, 16).replace(/[-T:]/g, "")}`).toUpperCase();
  const code = TEST_CODE_RE.test(base) ? base : `${base}-TEST`;
  const name = String(a.name ?? `Geliştirici Test Projesi (${code})`);
  const template = String(a.template ?? "iso19650");
  let project: Any;
  let warnings: unknown;
  if (template === "empty" || template === "iso19650") {
    project = await ctx.call<Any>("POST", "/projects", { code, name, template });
  } else {
    // Built-in project template: slots get the demo companies of the same role.
    const t = await ctx.call<Any>("GET", `/templates/${template}`);
    const demo = a.members === false ? null : await ensureDemoCompanies(ctx);
    const slotCompanies: Record<string, string> = {};
    for (const slot of (t.slots ?? []) as Any[]) {
      const key = String(slot.key ?? "");
      const code = SLOT_CODES.find(([re]) => re.test(key))?.[1];
      if (code && demo?.[code]) slotCompanies[key] = demo[code]!.id;
    }
    const r = await ctx.call<Any>("POST", "/projects/from-template", { templateId: template, code, name, slotCompanies, slotCodes: {}, dimensions: {} });
    project = r;
    warnings = r.warnings;
  }
  await updateRegistry(ctx.db, ctx.admin.id, (r) => {
    r.projects[project.id] = { ...(r.projects[project.id] ?? {}), createdByDev: true, createdAt: new Date().toISOString() };
  });
  const actors = a.members === false ? null : await ensureActors(ctx, project.id);
  const modules = a.modules ? (await setModules(ctx, { id: project.id, code }, a.modules)).modules : undefined;
  return {
    id: project.id,
    code,
    name,
    template,
    link: link(ctx, projectPath(project.id)),
    members: actors?.all.map((x) => ({ role: x.role, company: x.code, user: x.userName })) ?? [],
    ...(modules ? { modules } : {}),
    ...(warnings ? { warnings } : {}),
  };
}

/**
 * Module switches (projects.settings.modules) of a test/demo project. Goes through the Proje
 * Ayarları → Modüller endpoint (PUT /projects/:pid/modules): same validation (known module keys,
 * booleans), audit and merge with the stored switches. Reversible, so no confirm is needed.
 */
async function setModules(ctx: DevContext, p: Pick<ProjectRow, "id" | "code">, modules: unknown) {
  const reg = await readRegistry(ctx.db);
  if (!isTestProject(p, reg))
    throw new HttpError(
      403,
      "not_test_project",
      `"${p.code}" bir test/demo projesi değil. Modül anahtarları yalnız kodu -DEMO / -TEST ile biten ya da geliştirici araçlarının oluşturduğu projelerde değiştirilir.`,
    );
  if (!modules || typeof modules !== "object" || !Object.keys(modules).length)
    throw new HttpError(400, "bad_request", 'modules gerekli, ör. {"schedule": false, "rfi": true}.');
  const state = await ctx.call<Record<string, boolean>>("PUT", `/projects/${p.id}/modules`, { modules });
  return {
    project: p.code,
    modules: state,
    off: Object.entries(state)
      .filter(([, on]) => !on)
      .map(([m]) => m),
  };
}

/** Removes every work, review, form, issue, clash test, model set and schedule (and files unless keepFiles). */
async function reset(ctx: DevContext, a: Record<string, unknown>) {
  const p = await findProject(ctx.db, String(a.project));
  await requireTestProject(ctx.db, p, a.confirm as boolean, "Projeyi sıfırlamak");
  const forms = moduleTable<Any>("field", "forms"); // Field's table, when installed
  const clashTests = moduleTable<Any>("coordinate", "clashTests"); // Coordinate's, when installed
  const schedules = moduleTable<Any>("planning", "schedules"); // Planning's, when installed
  const all = async (table: Any, idCol: Any, projectCol: Any, extra?: Any) =>
    (await ctx.db.select({ id: idCol }).from(table).where(extra ? and(eq(projectCol, p.id), extra) : eq(projectCol, p.id))).map((r: Any) => r.id as string);
  const records: Record<string, string[]> = {
    works: await all(works, works.id, works.projectId),
    reviews: await all(reviews, reviews.id, reviews.projectId),
    forms: forms ? await all(forms, forms.id, forms.projectId) : [],
    issues: await all(issues, issues.id, issues.projectId),
    clashTests: clashTests ? await all(clashTests, clashTests.id, clashTests.projectId) : [],
    modelSets: await all(modelSets, modelSets.id, modelSets.projectId),
    schedules: schedules ? await all(schedules, schedules.id, schedules.projectId) : [],
    ...(a.keepFiles === false ? { files: await all(files, files.id, files.projectId, sql`${files.deletedAt} is null`) } : {}),
  };
  const removed = await removeRecords(ctx, p.id, records);
  await updateRegistry(ctx.db, ctx.admin.id, (r) => {
    if (r.projects[p.id]) r.projects[p.id]!.seeds = {};
  });
  return { project: p.code, removed, keptFiles: a.keepFiles !== false };
}
