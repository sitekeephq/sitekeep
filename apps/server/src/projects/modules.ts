/**
 * Module switches per project (Proje Ayarları → Modüller). An off module keeps its data and its
 * read API; only new records are refused (403 module_disabled, in the reader's language).
 */
import { eq } from "drizzle-orm";
import {
  moduleOfWorkCategory,
  moduleOffMessage,
  resolveModules,
  type ProjectModule,
  type ProjectModuleState,
  type ProjectSettings,
} from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { projects } from "../db/schema.js";
import { HttpError } from "../core/platform/http.js";
import { moduleInstalled } from "../app/module-ids.js";

type ProjectRow = { settings?: ProjectSettings | null };

/**
 * Project switches that belong to an Enterprise product (docs/modules/manage.md): without the
 * product they are off in every project, whatever is stored, so its records are neither offered
 * nor accepted. The stored switches are kept for when the product is installed again.
 */
export const PRODUCT_SWITCHES: Readonly<Record<string, readonly ProjectModule[]>> = {
  manage: ["correspondence", "rfi", "submittals", "meetings", "spec"],
};

/** Stored switches with those of products that are not installed turned off. */
export function installedModules(stored?: Partial<Record<string, unknown>> | null): ProjectModuleState {
  const state = resolveModules(stored);
  for (const [product, switches] of Object.entries(PRODUCT_SWITCHES)) if (!moduleInstalled(product)) for (const m of switches) state[m] = false;
  return state;
}

export function projectModules(p: ProjectRow): ProjectModuleState {
  return installedModules(p.settings?.modules);
}

export function moduleDisabled(m: ProjectModule): HttpError {
  return new HttpError(403, "module_disabled", (lang) => moduleOffMessage(m, lang), { module: m });
}

/** Refuses a new record of an off module. */
export function requireModule(a: { project: ProjectRow }, m: ProjectModule): void {
  if (!projectModules(a.project)[m]) throw moduleDisabled(m);
}

/** Refuses a new work of a category whose module is off (generic works are always allowed). */
export function requireWorkModule(a: { project: ProjectRow }, category: string): void {
  const m = moduleOfWorkCategory(category);
  if (m) requireModule(a, m);
}

/** The work category's module is on (generic works always). */
export function workModuleOn(modules: ProjectModuleState, category: string): boolean {
  const m = moduleOfWorkCategory(category);
  return !m || modules[m];
}

export async function modulesOf(db: Db, projectId: string): Promise<ProjectModuleState> {
  const [p] = await db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId));
  return installedModules(p?.settings?.modules);
}
