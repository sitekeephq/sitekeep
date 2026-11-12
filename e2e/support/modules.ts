/**
 * Enterprise modules in the e2e run. SiteKeep Community has no `@7dimensions-project/sitekeep-ee-*`
 * package installed, so the module's pages, menus and admin tabs are not there. Specs about a module
 * skip themselves with `needsModules(...)`; lists that mix core and module entries filter the module
 * ones with `moduleInstalled(...)`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";

export type ModuleId = "cost" | "field" | "coordinate" | "planning" | "ai" | "manage" | "connect";

const root = path.resolve(__dirname, "../..");
const cache = new Map<ModuleId, boolean>();

/** The module's package is installed at the repository root (node_modules/@7dimensions-project/sitekeep-ee-<id>). */
export function moduleInstalled(id: ModuleId): boolean {
  let hit = cache.get(id);
  if (hit === undefined) {
    hit = existsSync(path.join(root, "node_modules/@7dimensions-project", `sitekeep-ee-${id}`, "package.json"));
    cache.set(id, hit);
  }
  return hit;
}

/** Every listed module is installed. */
export function modulesInstalled(...ids: ModuleId[]): boolean {
  return ids.every(moduleInstalled);
}

/**
 * Skips the current test (inside a test or hook) or every test of the file / describe block (at top
 * level) unless all `ids` are installed.
 */
export function needsModules(...ids: ModuleId[]): void {
  const missing = ids.filter((id) => !moduleInstalled(id));
  test.skip(missing.length > 0, `needs SiteKeep Enterprise module(s): ${missing.join(", ")}`);
}

/** Keeps the entries whose module (if any) is installed: `[label, …, module?]` lists of core and module entries. */
export function withInstalled<T extends { module?: ModuleId }>(items: readonly T[]): T[] {
  return items.filter((item) => !item.module || moduleInstalled(item.module));
}
