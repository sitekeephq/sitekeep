// Module code (packages/ee-*) reads the core's SDK from globalThis; bind it before any test imports it.
import "../src/sdk/bind.js";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerTurkishLabels } from "@sitekeep/shared";
import { moduleIds } from "../src/app/module-ids.js";
import { registerLocaleFolder } from "../src/i18n/index.js";

// The installed modules' texts and label tables, as loading the modules does (app/modules.ts and each
// module's entry): tests that import a module's internals directly render its messages and labels too.
const here = path.dirname(fileURLToPath(import.meta.url));
for (const id of moduleIds()) {
  for (let dir = here; path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    const pkg = path.join(dir, "node_modules/@7dimensions-project", `sitekeep-ee-${id}`);
    if (existsSync(path.join(pkg, "package.json"))) {
      registerLocaleFolder(path.join(pkg, "locales/server"));
      registerLocaleFolder(path.join(pkg, "locales/shared"));
      const shared = path.join(pkg, "dist/shared");
      for (const f of existsSync(shared) ? readdirSync(shared).filter((n) => n.endsWith(".js")) : []) {
        registerTurkishLabels(await import(pathToFileURL(path.join(shared, f)).href));
      }
      break;
    }
  }
}
