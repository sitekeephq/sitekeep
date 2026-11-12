/**
 * Modules (docs/modules/README.md), loaded by package name. SITEKEEP_MODULES is a comma list of module
 * ids ("cost"); unset means every installed module package, empty means none (SiteKeep Community).
 *
 * Loaded and on are different: every loaded module's code, texts and database tables are there (data
 * stays when a licence lapses), but only the modules that are on (moduleIds(): loaded, and licensed
 * when licences are enforced) serve their routes, capabilities, report datasets, tasks and reminders.
 * The SDK is bound before any module loads.
 */
import "../sdk/bind.js";
import path from "node:path";
import type { ServerModule } from "../sdk/module.js";
import { registerLocaleFolder } from "../i18n/index.js";
import { setLoadingModule } from "./module-owner.js";

export { KNOWN_MODULES, moduleIds } from "./module-ids.js";
import { loadedModuleIds, moduleIds } from "./module-ids.js";

async function load(id: string): Promise<ServerModule> {
  const pkg = `@7dimensions-project/sitekeep-ee-${id}/server`;
  // One at a time, so what the module registers while loading is attributed to it (module-owner.ts).
  setLoadingModule(id);
  try {
    const m = (await import(pkg)) as { default?: ServerModule };
    if (!m.default || m.default.id !== id) throw new Error(`${pkg} does not export the "${id}" module as default`);
    return m.default;
  } finally {
    setLoadingModule(null);
  }
}

const loaded: ServerModule[] = [];
for (const id of loadedModuleIds()) loaded.push(await load(id));

/** Every loaded module (migrations, texts, developer tables). */
export const loadedModules: readonly ServerModule[] = loaded;

/** The modules that are on now (routes, tasks, reminders, background jobs). */
export function activeModules(): ServerModule[] {
  const on = moduleIds();
  return loaded.filter((m) => on.includes(m.id));
}

for (const m of loadedModules) {
  if (!m.locales) continue;
  registerLocaleFolder(m.locales);
  // Enum label tables, shared by the module's server and web: <package>/locales/shared/<lang>/labels.json
  registerLocaleFolder(path.join(path.dirname(m.locales), "shared"));
}

/** A module's table for developer tools (dev/, scripts/); undefined when the module is not loaded. */
export function moduleTable<T = unknown>(moduleId: string, name: string): T | undefined {
  return loadedModules.find((m) => m.id === moduleId)?.tables?.[name] as T | undefined;
}
