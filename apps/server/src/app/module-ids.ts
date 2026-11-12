/**
 * Module ids of this build and of this installation (SITEKEEP_MODULES), without loading any module:
 * code that the SDK itself exports may ask which products are installed (projects/modules.ts).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { licensedModules } from "../license/state.js";

/** Modules SiteKeep knows (Enterprise). Which are installed depends on the build. */
export const KNOWN_MODULES = ["field", "coordinate", "planning", "cost", "ai", "manage", "connect"] as const;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const installedCache = new Map<string, boolean>();

/** The module's package is installed (node_modules up the tree); a Community build has none. */
export function modulePackageInstalled(id: string): boolean {
  const hit = installedCache.get(id);
  if (hit !== undefined) return hit;
  let found = false;
  for (let dir = HERE; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "node_modules/@7dimensions-project", `sitekeep-ee-${id}`, "package.json"))) {
      found = true;
      break;
    }
    if (path.dirname(dir) === dir) break;
  }
  installedCache.set(id, found);
  return found;
}

/** The module packages to load: SITEKEEP_MODULES, or when it is not set every installed one. */
export function loadedModuleIds(env: string | undefined = process.env.SITEKEEP_MODULES): string[] {
  if (env === undefined) return KNOWN_MODULES.filter(modulePackageInstalled);
  return env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The modules that are on: the loaded ones, limited to the licence when licences are enforced
 * (SITEKEEP_LICENSE_ENFORCE=1, license/state.ts). Read on every use: a licence uploaded at run time
 * turns modules on without a restart (their background jobs start at the next restart).
 */
export function moduleIds(env: string | undefined = process.env.SITEKEEP_MODULES): string[] {
  const licensed = licensedModules();
  const loaded = loadedModuleIds(env);
  return licensed === null ? loaded : loaded.filter((id) => licensed.includes(id));
}

/** The edition this installation runs: no module is SiteKeep Community, any module SiteKeep Enterprise. */
export function editionName(ids: readonly string[] = moduleIds()): "SiteKeep Community" | "SiteKeep Enterprise" {
  return ids.length ? "SiteKeep Enterprise" : "SiteKeep Community";
}

/** The module is on in this process (installed, in SITEKEEP_MODULES and, when enforced, licensed). */
export function moduleInstalled(id: string): boolean {
  return moduleIds().includes(id);
}
