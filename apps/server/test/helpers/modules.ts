/** Installed modules for tests (SITEKEEP_MODULES, app/modules.ts): steps of a module run only when it is. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { moduleIds } from "../../src/app/modules.js";

export const installed = (id: string): boolean => moduleIds().includes(id);
export const hasField = installed("field");
export const hasCoordinate = installed("coordinate");
export const hasPlanning = installed("planning");
export const hasAi = installed("ai");
export const hasManage = installed("manage");
export const hasConnect = installed("connect");
export const hasCost = installed("cost");

/** Version of an installed module package ("0.7.0"), or null. */
export function moduleVersion(id: string): string | null {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const file = path.join(dir, "node_modules/@sitekeephq", `sitekeep-ee-${id}`, "package.json");
    if (existsSync(file)) return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
    if (path.dirname(dir) === dir) return null;
  }
}

/** The installed module is at least this version (features a test needs). */
export function moduleAtLeast(id: string, version: string): boolean {
  const v = moduleVersion(id);
  if (!v) return false;
  const [a, b] = [v, version].map((x) => x.split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((a![i] ?? 0) !== (b![i] ?? 0)) return (a![i] ?? 0) > (b![i] ?? 0);
  return true;
}
