/**
 * Vite plugin: `virtual:sitekeep-modules` imports the installed modules' web entries
 * (docs/modules/README.md). SITEKEEP_MODULES is the same comma list the server reads; unset means
 * every module of this build, empty means none (the Community build).
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The installed package's folder (node_modules up the tree: workspace or hoisted). */
function packageDir(pkg: string): string | null {
  for (let dir = HERE; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", pkg);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * A module's web texts: `<package>/locales/web/<language>/<namespace>.json`. English is bundled
 * (imported), other languages are chunks loaded when chosen, like the core's (src/i18n/index.ts).
 */
function localeEntries(pkg: string): { lang: string; ns: string; file: string }[] {
  const dir = packageDir(pkg);
  if (!dir) return [];
  // locales/web: the module's namespaces; locales/shared: its enum label tables (labels.json), shared with its server side
  return ["web", "shared"].flatMap((side) => {
    const root = path.join(dir, "locales", side);
    if (!existsSync(root)) return [];
    return readdirSync(root).flatMap((lang) =>
      existsSync(path.join(root, lang))
        ? readdirSync(path.join(root, lang))
            .filter((f) => f.endsWith(".json") && f !== "meta.json" && (side === "web" || f === "labels.json"))
            .map((f) => ({ lang, ns: f.replace(/\.json$/, ""), file: path.join(root, lang, f) }))
        : [],
    );
  });
}

export const KNOWN_MODULES = ["field", "coordinate", "planning", "cost", "ai", "manage", "connect"]; // apps/server/src/app/modules.ts

/** SITEKEEP_MODULES, or when it is not set every installed module package (a Community build has none). */
export function moduleIds(env: string | undefined = process.env.SITEKEEP_MODULES): string[] {
  if (env === undefined) return KNOWN_MODULES.filter((id) => packageDir(`@7dimensions-project/sitekeep-ee-${id}`) !== null);
  return env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const ID = "virtual:sitekeep-modules";

export function sitekeepModules(): Plugin {
  return {
    name: "sitekeep-modules",
    resolveId: (id) => (id === ID ? `\0${ID}` : null),
    load(id) {
      if (id !== `\0${ID}`) return null;
      const ids = moduleIds();
      const locales = ids.flatMap((m) => localeEntries(`@7dimensions-project/sitekeep-ee-${m}`).map((l) => ({ ...l, module: m })));
      const english = locales.filter((l) => l.lang === "en");
      const others = locales.filter((l) => l.lang !== "en");
      return [
        ...ids.map((m, i) => `import m${i} from "@7dimensions-project/sitekeep-ee-${m}/web";`),
        ...english.map((l, i) => `import l${i} from ${JSON.stringify(l.file)};`),
        // Every module this build carries; the app turns on those the server runs (app/modules.ts).
        `export const bundledModules = [${ids.map((_, i) => `m${i}`).join(", ")}];`,
        `export const moduleLocales = [`,
        ...english.map((l, i) => `  { module: ${JSON.stringify(l.module)}, lang: "en", ns: ${JSON.stringify(l.ns)}, data: l${i} },`),
        ...others.map((l) => `  { module: ${JSON.stringify(l.module)}, lang: ${JSON.stringify(l.lang)}, ns: ${JSON.stringify(l.ns)}, load: () => import(${JSON.stringify(l.file)}).then((x) => x.default) },`),
        `];`,
      ].join("\n");
    },
  };
}
