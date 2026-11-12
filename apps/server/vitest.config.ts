import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const KNOWN_MODULES = ["field", "coordinate", "planning", "cost", "ai", "manage", "connect"]; // app/modules.ts
const packageInstalled = (id: string) => {
  for (let dir = here; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "node_modules/@7dimensions-project", `sitekeep-ee-${id}`, "package.json"))) return true;
    if (path.dirname(dir) === dir) return false;
  }
};
const installed = process.env.SITEKEEP_MODULES === undefined ? KNOWN_MODULES.filter(packageInstalled) : process.env.SITEKEEP_MODULES.split(",").map((s) => s.trim());
const notInstalled = KNOWN_MODULES.filter((id) => !installed.includes(id));

export default defineConfig({
  // Tests run against the shared sources, so `npm test` works without building packages/shared first.
  // Modules are installed packages (node_modules/@7dimensions-project/sitekeep-ee-*), run as published.
  resolve: { alias: { "@sitekeep/shared": path.resolve(here, "../../packages/shared/src/index.ts") } },
  // Server texts in Turkish: the expectations were written against the Turkish messages
  // (docs/architecture/i18n.md §8). test/i18n covers English.
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: { CDE_DEFAULT_LANGUAGE: "tr" },
    setupFiles: ["test/setup-sdk.ts"],
    // test/modules/<id> covers an installed module; a build without it (SITEKEEP_MODULES) skips them.
    exclude: [...configDefaults.exclude, ...notInstalled.map((id) => `test/modules/${id}/**`)],
  },
});
