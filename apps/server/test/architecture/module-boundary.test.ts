/**
 * Module boundary (docs/modules/README.md). Modules live in their own repositories
 * (7Dimensions-Project/sitekeep-<id>, which checks its side) and come in as published packages;
 * the core loads them by package name (app/modules.ts) and never imports their code.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KNOWN_MODULES } from "../../src/app/modules.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const MODULE_PREFIX = "@7dimensions-project/sitekeep-ee-";

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    if (n === "node_modules" || n === "dist") return [];
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mjs)$/.test(p) ? [p] : [];
  });
}

/** Import / export specifiers of a file, static and dynamic (string literals only). */
function specifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/(?:import|export)\s[^;]*?from\s+"([^"]+)"|import\s+"([^"]+)"|import\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
}

const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");

describe("module boundary", () => {
  it("the core never imports a module's code", () => {
    const core = [...walk(path.join(root, "apps/server/src")), ...walk(path.join(root, "apps/web/src"))];
    const offenders = core.flatMap((f) => specifiers(f).filter((s) => s.startsWith(MODULE_PREFIX)).map((s) => `${rel(f)} → ${s}`));
    expect(offenders).toEqual([]);
  });

  it("modules are optional installed packages, pinned in apps/server and apps/web (a Community install has none)", () => {
    expect(readdirSync(path.join(root, "packages")).filter((n) => n.startsWith("ee-"))).toEqual([]);
    for (const app of ["server", "web"]) {
      const pkg = JSON.parse(readFileSync(path.join(root, `apps/${app}/package.json`), "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
      expect(Object.keys(pkg.dependencies ?? {}).filter((n) => n.startsWith(MODULE_PREFIX)), `${app}: modules must not be required`).toEqual([]);
      // The public SiteKeep Community repository lists no module at all (tools/public-transform.sh).
      if (!Object.keys(pkg.optionalDependencies ?? {}).some((n) => n.startsWith(MODULE_PREFIX))) continue;
      for (const id of KNOWN_MODULES) {
        expect(pkg.optionalDependencies?.[`${MODULE_PREFIX}${id}`], `${app}: ${id}`).toMatch(/^\d+\.\d+\.\d+$/);
        expect(pkg.dependencies?.[`${MODULE_PREFIX}${id}`], `${app}: ${id} must not be required`).toBeUndefined();
      }
    }
  });
});
