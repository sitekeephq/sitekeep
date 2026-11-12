// Declarations of the core's SDK for modules built outside this repository (docs/modules/README.md):
// tsc emits the .d.ts of apps/server/src/sdk, apps/web/src/sdk and packages/shared into types/
// (declarations only, no code); the workspace packages they import are rewritten to relative
// paths, and the JSON / ambient files the declarations refer to are copied next to them.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(pkg, "../..");
const types = path.join(pkg, "types");
const tsc = path.join(root, "node_modules/typescript/bin/tsc");

rmSync(types, { recursive: true, force: true });
for (const cfg of ["tsconfig.types-server.json", "tsconfig.types-web.json"]) execFileSync(process.execPath, [tsc, "-p", path.join(pkg, cfg)], { stdio: "inherit" });

// JSON imports (i18n resources typed from the English files) and ambient declarations.
for (const side of ["server", "web"]) cpSync(path.join(root, `apps/${side}/src/i18n/locales/en`), path.join(types, `apps/${side}/src/i18n/locales/en`), { recursive: true });
cpSync(path.join(root, "apps/server/src/previews/dxf-viewer-src.d.ts"), path.join(types, "apps/server/src/previews/dxf-viewer-src.d.ts"));
cpSync(path.join(root, "apps/web/src/i18n/i18next.d.ts"), path.join(types, "apps/web/src/i18n/i18next.d.ts"));

// Workspace packages → relative paths inside types/.
const WORKSPACE = { "@sitekeep/shared": "packages/shared/src/index.js", "@sitekeep/cde-tools": "packages/cde-tools/src/index.js" };
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : [path.join(d, n)]));
for (const f of walk(types).filter((f) => f.endsWith(".d.ts"))) {
  let text = readFileSync(f, "utf8");
  let changed = false;
  for (const [name, target] of Object.entries(WORKSPACE)) {
    const rel = path.relative(path.dirname(f), path.join(types, target)).split(path.sep).join("/");
    const spec = rel.startsWith(".") ? rel : `./${rel}`;
    const next = text.replaceAll(`"${name}"`, `"${spec}"`);
    if (next !== text) (text = next), (changed = true);
  }
  if (changed) writeFileSync(f, text);
}
const missing = Object.values(WORKSPACE).filter((t) => text(t) === null);
function text(t) {
  const p = path.join(types, t.replace(/\.js$/, ".d.ts"));
  return existsSync(p) ? p : null;
}
if (missing.includes(WORKSPACE["@sitekeep/shared"])) throw new Error("shared declarations were not emitted");
console.log(`sdk types: ${walk(types).length} files`);
