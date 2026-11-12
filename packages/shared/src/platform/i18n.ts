/**
 * Texts the shared package produces for people (validation problems, capacity findings, enum
 * labels), in the reader's language (docs/architecture/i18n.md §9). The web app and the server
 * pass the language in; this module has no i18next dependency so it runs in both.
 *
 *   sharedText(lang, "naming.missingField", { field })   messages: locales/<lang>/messages.json
 *   labelText(lang, "issueStatus", "open")               enum labels: Turkish from the *_LABELS_TR
 *                                                        tables, other languages locales/<lang>/labels.json
 *
 * English and Turkish are bundled. Another language is registered by the app that found its
 * folder (web: import.meta.glob, server: the copied dist/locales) with registerSharedLocale().
 */
import enLabels from "../locales/en/labels.json" with { type: "json" };
import enMessages from "../locales/en/messages.json" with { type: "json" };
import trMessages from "../locales/tr/messages.json" with { type: "json" };
import * as shared from "../index.js";

type Tree = { [key: string]: string | Tree };

/** Functions without a `lang` argument keep their old Turkish output. */
export const SHARED_DEFAULT_LANGUAGE = "tr";
const FALLBACK = "en";

const catalogs: Record<string, { labels?: Tree; messages?: Tree }> = {
  en: { labels: enLabels as Tree, messages: enMessages as Tree },
  tr: { messages: trMessages as Tree },
};

/** Adds a language's shared texts (tables merge, so modules' label tables stay); empty values are ignored so English shows. */
export function registerSharedLocale(lang: string, part: { labels?: unknown; messages?: unknown }) {
  const current = (catalogs[lang] ??= {});
  if (part.labels) current.labels = { ...current.labels, ...(part.labels as Tree) };
  if (part.messages) current.messages = part.messages as Tree;
}

/** Label tables of the installed modules in Turkish, from their own `*_LABELS_TR` constants. */
const moduleTurkish: Record<string, unknown> = {};

/**
 * A module's enum label tables (docs/architecture/i18n.md §9): Turkish from its `*_LABELS_TR`
 * constants, `registerTurkishLabels({ CONTRACT_STATUS_LABELS_TR, … })` (a module namespace works
 * too); other languages from its `locales/shared/<lang>/labels.json`, which the core registers.
 */
export function registerTurkishLabels(constants: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(constants)) {
    if (/_LABELS?_TR$/.test(name) && value && typeof value === "object") moduleTurkish[tableKey(name)] = value;
  }
  turkish = null;
}

function lookup(tree: Tree | undefined, key: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of key.split(".")) {
    if (!node || typeof node === "string") return undefined;
    node = node[part];
  }
  return typeof node === "string" && node.trim() ? node : undefined;
}

function base(lang: string): string {
  return lang.toLowerCase().split("-")[0]!;
}

/** Intl locale for numbers and dates in `lang`: "tr-TR", "en-GB", otherwise the language itself. */
export function sharedIntlLocale(lang: string): string {
  const l = base(lang);
  return l === "tr" ? "tr-TR" : l === "en" ? "en-GB" : lang;
}

export type SharedParams = Record<string, string | number | null | undefined>;

function interpolate(text: string, params: SharedParams | undefined): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, name: string) => {
    const v = params?.[name];
    return v === null || v === undefined ? "" : String(v);
  });
}

/** A message in `lang` (→ English → the key). `count` picks the plural form (`key_one` / `key_other`). */
export function sharedText(lang: string, key: string, params?: SharedParams): string {
  for (const l of [base(lang), FALLBACK]) {
    const messages = catalogs[l]?.messages;
    if (!messages) continue;
    let text: string | undefined;
    if (typeof params?.count === "number") {
      const form = new Intl.PluralRules(l).select(params.count);
      text = lookup(messages, `${key}_${form}`) ?? lookup(messages, `${key}_other`);
    }
    text ??= lookup(messages, key);
    if (text !== undefined) return interpolate(text, params);
  }
  return key;
}

/** "ISSUE_STATUS_LABELS_TR" → "issueStatus": the table names of locales/<lang>/labels.json. */
function tableKey(exportName: string): string {
  return exportName
    .replace(/_LABELS?_TR$/, "")
    .toLowerCase()
    .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

let turkish: Record<string, unknown> | null = null;

/** Turkish labels: the *_LABELS_TR tables themselves (also used by the server for e-mails). */
export function turkishLabelTables(): Record<string, unknown> {
  if (turkish) return turkish;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(shared)) {
    if (/_LABELS?_TR$/.test(name) && value && typeof value === "object") out[tableKey(name)] = value;
  }
  Object.assign(out, moduleTurkish);
  return (turkish = out);
}

/** Label of an enum value: `labelText("en", "issueStatus", "open")` → "Open". Unknown → the key. */
export function labelText(lang: string, table: string, key: string): string {
  const trTable = turkishLabelTables()[table] as Record<string, unknown> | undefined;
  const trValue = (k: string) => {
    let node: unknown = trTable;
    for (const part of k.split(".")) node = node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
    return typeof node === "string" ? node : undefined;
  };
  // Keys may hold dots ("documents:read" has a colon; reportValue uses "status.open" on purpose).
  const fromCatalog = (l: string) => {
    const t = catalogs[l]?.labels?.[table];
    if (!t || typeof t === "string") return undefined;
    return (typeof t[key] === "string" && (t[key] as string).trim() ? (t[key] as string) : undefined) ?? lookup(t, key);
  };
  const l = base(lang);
  if (l === "tr") return trValue(key) ?? fromCatalog(FALLBACK) ?? key;
  return fromCatalog(l) ?? fromCatalog(FALLBACK) ?? trValue(key) ?? key;
}
