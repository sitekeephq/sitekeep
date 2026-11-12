// The installed modules' texts (ServerModule.locales) are merged into the core's namespaces in
// every language the core has (docs/architecture/i18n.md §9).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadedModules as serverModules } from "../../src/app/modules.js";
import { labelFor, msg, render, type MsgKey } from "../../src/i18n/index.js";

type Tree = { [k: string]: string | Tree };
const firstLeaf = (t: Tree, p = ""): [string, string] | null => {
  for (const [k, v] of Object.entries(t)) {
    if (typeof v === "string") { if (v.trim() && !v.includes("{{")) return [p + k.replace(/_(one|other)$/, ""), v]; }
    else { const hit = firstLeaf(v, `${p}${k}.`); if (hit) return hit; }
  }
  return null;
};

describe("module texts", () => {
  const withTexts = serverModules.filter((m) => m.locales && existsSync(m.locales));
  it.runIf(withTexts.length > 0)("renders each module namespace in English and Turkish", () => {
    for (const m of withTexts) {
      for (const file of readdirSync(path.join(m.locales!, "en"))) {
        const ns = file.replace(/\.json$/, "");
        const read = (lang: string) => JSON.parse(readFileSync(path.join(m.locales!, lang, file), "utf8")) as Tree;
        const [key, english] = firstLeaf(read("en"))!;
        const k = `${ns}:${key}` as MsgKey;
        expect(render("en", msg(k)), `${m.id} ${k}`).toBe(english);
        const turkish = key.split(".").reduce<Tree | string | undefined>((t, part) => (t as Tree)?.[part], read("tr"));
        if (typeof turkish === "string" && turkish.trim()) expect(render("tr", msg(k)), `${m.id} ${k}`).toBe(turkish);
      }
    }
  });
});

describe("module label tables", () => {
  const withLabels = serverModules
    .map((m) => m.locales && path.join(path.dirname(m.locales), "shared", "en", "labels.json"))
    .filter((f): f is string => !!f && existsSync(f));
  it.runIf(withLabels.length > 0)("labels a module's enums in English and Turkish", () => {
    for (const file of withLabels) {
      for (const [table, values] of Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, string>>)) {
        const [key, english] = Object.entries(values)[0]!;
        expect(labelFor("en", table, key), `${table}.${key}`).toBe(english);
        expect(labelFor("tr", table, key), `${table}.${key} in Turkish`).not.toBe(key);
      }
    }
  });
});
