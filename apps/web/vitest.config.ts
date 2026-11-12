import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { KNOWN_MODULES, moduleIds, sitekeepModules } from "./sitekeep-modules";

const here = path.dirname(fileURLToPath(import.meta.url));

// Unit tests of the web app's pure helpers (no DOM): office viewers' parsing and layout maths.
export default defineConfig({
  plugins: [sitekeepModules()],
  resolve: { alias: { "@sitekeep/shared": path.resolve(here, "../../packages/shared/src/index.ts") } },
  test: {
    include: ["test/**/*.test.ts"],
    // test/modules/<id> covers an installed module; a build without it (SITEKEEP_MODULES) skips them.
    exclude: KNOWN_MODULES.filter((id) => !moduleIds().includes(id)).map((id) => `test/modules/${id}/**`),
    environment: "node",
    setupFiles: ["test/setup.ts"],
  },
});
