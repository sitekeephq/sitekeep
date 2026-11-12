/**
 * Modules (docs/modules/README.md). The build carries the web entries of the installed module packages
 * (sitekeep-modules.ts); at start the app asks the server which modules it runs (GET /api/v1/app-info:
 * SITEKEEP_MODULES, later the licence) and turns on only those: pages, menu entries, capabilities, texts.
 * The SDK is bound before any module loads.
 */
import "../sdk/bind";
import { bundledModules, moduleLocales } from "virtual:sitekeep-modules";
import { addModuleLocales } from "../i18n";
import { activateWebModule, type WebModule } from "../sdk/module";

/** The modules turned on (read at render time; empty until enableModules). */
export let webModules: readonly WebModule[] = [];

/** Turns on the bundled modules among `ids`; their texts join the core's namespaces. */
const textsAdded = new Set<string>();

export function enableModules(ids: readonly string[]): void {
  webModules = bundledModules.filter((m) => ids.includes(m.id));
  for (const m of webModules) activateWebModule(m);
  const fresh = webModules.map((m) => m.id).filter((id) => !textsAdded.has(id));
  for (const id of fresh) textsAdded.add(id);
  addModuleLocales(moduleLocales.filter((l) => fresh.includes(l.module)));
}

/**
 * Before the first render (main.tsx): the modules the server runs. If the server cannot be asked, every
 * bundled module is turned on; the server still refuses what it does not run.
 */
export async function loadEnabledModules(): Promise<void> {
  let ids: string[] | null = null;
  try {
    const res = await fetch("/api/v1/app-info", { credentials: "same-origin" });
    if (res.ok) {
      const body = (await res.json()) as { modules?: unknown };
      if (Array.isArray(body.modules)) ids = body.modules.filter((m): m is string => typeof m === "string");
    }
  } catch {
    ids = null;
  }
  enableModules(ids ?? bundledModules.map((m) => m.id));
}
