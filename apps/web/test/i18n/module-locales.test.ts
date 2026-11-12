// The installed modules' texts (<package>/locales/web) join the core's namespaces: English bundled,
// other languages loaded when chosen (docs/architecture/i18n.md §9).
import { describe, expect, it } from "vitest";
import { moduleLocales } from "virtual:sitekeep-modules";
import { i18n, setLanguage } from "../../src/i18n";

type Tree = { [k: string]: string | Tree };
const firstLeaf = (t: Tree, p = ""): [string, string] | null => {
  for (const [k, v] of Object.entries(t)) {
    if (typeof v === "string") { if (v.trim() && !v.includes("{{") && !/_(one|other|zero|few|many|two)$/.test(k)) return [p + k, v]; }
    else { const hit = firstLeaf(v, `${p}${k}.`); if (hit) return hit; }
  }
  return null;
};

describe("module texts", () => {
  it.runIf(moduleLocales.length > 0)("renders each module namespace in English and Turkish", async () => {
    try {
      for (const entry of moduleLocales.filter((e) => e.lang === "en")) {
        const [key, english] = firstLeaf(entry.data as Tree)!;
        await setLanguage("en", { persist: false });
        expect(i18n.t(`${entry.ns}:${key}` as never), `${entry.ns}:${key}`).toBe(english);
        const tr = moduleLocales.find((e) => e.lang === "tr" && e.ns === entry.ns);
        if (!tr) continue;
        const turkish = key.split(".").reduce<Tree | string | undefined>((t, part) => (t as Tree)?.[part], (await tr.load!()) as Tree);
        await setLanguage("tr", { persist: false });
        if (typeof turkish === "string" && turkish.trim()) expect(i18n.t(`${entry.ns}:${key}` as never), `${entry.ns}:${key}`).toBe(turkish);
      }
    } finally {
      await setLanguage("tr", { persist: false });
    }
  });
});

describe("module label tables", () => {
  const tables = moduleLocales.filter((e) => e.lang === "en" && e.ns === "labels");
  it.runIf(tables.length > 0)("shows a module's enum labels in English and Turkish", async () => {
    const { label } = await import("../../src/i18n");
    try {
      for (const entry of tables) {
        for (const [table, values] of Object.entries(entry.data as Record<string, Record<string, string>>)) {
          const [key, english] = Object.entries(values)[0]!;
          await setLanguage("en", { persist: false });
          expect(label(table as never, key), `${table}.${key}`).toBe(english);
          await setLanguage("tr", { persist: false });
          const turkish = label(table as never, key);
          expect(turkish, `${table}.${key} in Turkish`).not.toBe(key);
          expect(turkish, `${table}.${key} in Turkish`).not.toBe(english);
        }
      }
    } finally {
      await setLanguage("tr", { persist: false });
    }
  });
});
