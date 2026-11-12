/**
 * Every language has what English has (docs/architecture/i18n.md §6): same keys for a "complete"
 * language, no unknown keys for a "beta" one, same {{placeholders}} and <tags>, no empty values.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NAMESPACES } from "../../src/i18n/resources";
import * as shared from "@sitekeep/shared";
import { turkishLabels } from "../../src/i18n/labels";
import { currentIntlLocale, i18n, setLanguage } from "../../src/i18n";
import { formatDay, formatNumber } from "../../src/shared/lib/format";

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCALES = path.resolve(here, "../../src/i18n/locales");

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    if (typeof v === "string") out.set(prefix + k, v);
    else for (const [kk, vv] of flatten(v, `${prefix}${k}.`)) out.set(kk, vv);
  }
  return out;
}

/** Enum labels are in the shared package (the server renders them too). */
const SHARED_LOCALES = path.resolve(here, "../../../../packages/shared/src/locales");

const read = (lang: string, ns: string): Tree | null => {
  const file = ns === "labels" ? path.join(SHARED_LOCALES, lang, "labels.json") : path.join(LOCALES, lang, `${ns}.json`);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Tree) : null;
};

/**
 * The core's Turkish label tables: the shared package's own `*_LABELS_TR` (turkishLabels() also has
 * the installed modules' tables; those are checked in the modules and in module-locales.test.ts).
 */
const coreTurkishLabels = (): Tree => {
  const ownTables = new Set(
    Object.keys(shared)
      .filter((n) => /_LABELS?_TR$/.test(n))
      .map((n) => n.replace(/_LABELS?_TR$/, "").toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())),
  );
  return Object.fromEntries(Object.entries(turkishLabels()).filter(([table]) => ownTables.has(table))) as Tree;
};

/** A language's namespace: the file, or for Turkish labels the shared tables. */
const bundle = (lang: string, ns: string): Tree | null => (lang === "tr" && ns === "labels" ? coreTurkishLabels() : read(lang, ns));

const languages = fs
  .readdirSync(LOCALES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({ code: d.name, meta: JSON.parse(fs.readFileSync(path.join(LOCALES, d.name, "meta.json"), "utf8")) as Record<string, string> }));

/** "{{count}}", "{{name}}" and "<b>", "</0>": what a translation must carry over. */
const tokens = (s: string) => [...s.matchAll(/\{\{\s*[\w.]+\s*\}\}|<\/?\w+\s*\/?>/g)].map((m) => m[0].replace(/\s+/g, "")).sort();

/** Plural forms are per language (Intl.PluralRules): compare "x_one" / "x_other" by their base key. */
const base = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, "");

describe("translation files", () => {
  it("every language folder has a valid meta.json", () => {
    expect(languages.map((l) => l.code)).toEqual(expect.arrayContaining(["en", "tr"]));
    for (const { code, meta } of languages) {
      expect(meta.name, code).toBeTruthy();
      expect(meta.short?.length, code).toBeLessThanOrEqual(3);
      expect(["ltr", "rtl"], code).toContain(meta.dir);
      expect(["complete", "beta"], code).toContain(meta.status);
      expect(Intl.DateTimeFormat.supportedLocalesOf([meta.intl!]), `${code} intl`).toHaveLength(1);
    }
    expect(languages.find((l) => l.code === "en")!.meta.status).toBe("complete");
  });

  it("English has a file for every namespace and no empty value", () => {
    for (const ns of NAMESPACES) {
      const tree = read("en", ns);
      expect(tree, `en/${ns}.json`).not.toBeNull();
      for (const [k, v] of flatten(tree!)) expect(v.trim(), `en ${ns}:${k}`).not.toBe("");
    }
  });

  for (const { code, meta } of languages.filter((l) => l.code !== "en")) {
    it(`${code} (${meta.status}) matches English keys, placeholders and tags`, () => {
      const missing: string[] = [];
      const extra: string[] = [];
      const mismatched: string[] = [];
      for (const ns of NAMESPACES) {
        const en = flatten(bundle("en", ns) ?? {});
        const other = flatten(bundle(code, ns) ?? {});
        const enBases = new Set([...en.keys()].map(base));
        const otherBases = new Set([...other.keys()].map(base));
        for (const k of enBases) if (!otherBases.has(k)) missing.push(`${ns}:${k}`);
        for (const k of otherBases) if (!enBases.has(k)) extra.push(`${ns}:${k}`);
        for (const [k, v] of other) {
          // Empty = not translated yet: allowed in a beta language (English shows), not in a complete one.
          if (!v.trim()) {
            if (meta.status === "complete") mismatched.push(`${ns}:${k} is empty`);
            continue;
          }
          const source = en.get(k) ?? en.get(`${base(k)}_other`) ?? en.get(base(k));
          if (source === undefined) continue;
          const want = tokens(source).filter((t) => t !== "{{count}}");
          const got = tokens(v).filter((t) => t !== "{{count}}");
          if (want.join() !== got.join()) mismatched.push(`${ns}:${k} ${got.join(" ")} ≠ ${want.join(" ")}`);
        }
      }
      expect(extra, "keys English does not have").toEqual([]);
      expect(mismatched).toEqual([]);
      if (meta.status === "complete") expect(missing, "untranslated keys").toEqual([]);
    });
  }
  // English labels covering every shared *_LABELS_TR table: packages/shared/test/i18n.test.ts.
});

describe("switching language", () => {
  it("changes texts, enum labels and formats, and falls back to the default for an unknown code", async () => {
    try {
      expect(await setLanguage("en", { persist: false })).toBe("en");
      expect(i18n.t("common:actions.save")).toBe("Save");
      expect(i18n.t("labels:issueStatus.open")).toBe("Open");
      expect(currentIntlLocale()).toBe("en-GB");
      expect(formatDay("2026-10-24")).toBe("24/10/2026");
      await setLanguage("tr", { persist: false });
      expect(i18n.t("common:actions.save")).toBe("Kaydet");
      expect(i18n.t("labels:issueStatus.open")).toBe("Açık");
      expect(formatDay("2026-10-24")).toBe("24.10.2026");
      expect(formatNumber(1234.5)).toBe("1.234,5");
      expect(await setLanguage("xx", { persist: false })).toBe("en");
      expect(await setLanguage("tr-TR", { persist: false })).toBe("tr");
    } finally {
      await setLanguage("tr", { persist: false });
    }
  });
});
