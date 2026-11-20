/**
 * Server texts in the reader's language (docs/architecture/i18n.md §8).
 *
 * Code does not write sentences; it names them: `msg("works:errors.closed", { number })` makes a
 * Msg (key + parameters, plain JSON). A Msg is rendered as late as possible, in the language of
 * whoever reads it:
 *   - HTTP errors: the error handler renders `HttpError.msg` in the request's language;
 *   - notifications: stored as Msg, rendered when the list is read (core/platform http + workflow);
 *   - exports and e-mails: `render(lang, m)` / `tFor(lang)` with the reader's language.
 *
 * Languages are the folders under ./locales (copied to dist by scripts/copy-locales.mjs); the web
 * app has the same list (apps/web/src/i18n/locales, test: test/i18n/server-parity.test.ts).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import i18next from "i18next";
import type { FastifyRequest } from "fastify";
import { labelText, registerSharedLocale } from "@sitekeep/shared";
import { DEFAULT_NAMESPACE, type ServerNamespace, type ServerResources } from "./resources.js";

const LOCALES = path.join(path.dirname(fileURLToPath(import.meta.url)), "locales");

// ---- Keys --------------------------------------------------------------------------------------

type Plural = "zero" | "one" | "two" | "few" | "many" | "other";
type Base<K extends string> = K extends `${infer B}_${Plural}` ? B : K;
type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${Base<K>}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

/** "works:errors.closed": a key of an English file, with its namespace. */
export type MsgKey = { [N in ServerNamespace]: `${N}:${Leaves<ServerResources[N]>}` }[ServerNamespace];

export type MsgParam = string | number | boolean | null | undefined | Msg;

/** A text to be rendered later, in the reader's language. Plain JSON: storable in the database. */
export interface Msg {
  key: MsgKey;
  params?: Record<string, MsgParam>;
}

export function msg(key: MsgKey, params?: Record<string, MsgParam>): Msg {
  return params ? { key, params } : { key };
}

export function isMsg(v: unknown): v is Msg {
  return !!v && typeof v === "object" && typeof (v as Msg).key === "string" && (v as Msg).key.includes(":");
}

// ---- Languages and texts -----------------------------------------------------------------------

interface LanguageMeta {
  code: string;
  name: string;
  /** Intl locale for dates and numbers ("tr-TR"). */
  intl: string;
  status: "complete" | "beta";
}

function dropEmpty(tree: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tree)) {
    if (typeof v === "string") {
      if (v.trim()) out[k] = v;
    } else if (v && typeof v === "object") out[k] = dropEmpty(v as Record<string, unknown>);
  }
  return out;
}

function loadLocales() {
  const languages: LanguageMeta[] = [];
  const resources: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const code of readdirSync(LOCALES)) {
    const dir = path.join(LOCALES, code);
    let meta: Omit<LanguageMeta, "code">;
    try {
      meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"));
    } catch {
      continue;
    }
    languages.push({ code, name: meta.name, intl: meta.intl, status: meta.status });
    resources[code] = {};
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json") || file === "meta.json") continue;
      resources[code][file.replace(/\.json$/, "")] = dropEmpty(JSON.parse(readFileSync(path.join(dir, file), "utf8")));
    }
  }
  return { languages, resources };
}

const loaded = loadLocales();
export const SERVER_LANGUAGES: readonly LanguageMeta[] = loaded.languages;

/**
 * The shared package bundles English and Turkish; other languages' shared texts (enum labels,
 * validation messages) are registered from its locale folders: packages/shared/src/locales in
 * development, packages/shared/dist/locales in the image (copied by its build).
 */
function registerSharedLocales() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const roots = ["../../../../packages/shared/src/locales", "../../../../packages/shared/dist/locales"].map((p) => path.resolve(here, p));
  const root = roots.find((r) => existsSync(r));
  if (!root) return;
  for (const { code } of SERVER_LANGUAGES) {
    if (code === "en" || code === "tr") continue;
    const part: Record<string, unknown> = {};
    for (const name of ["labels", "messages"]) {
      const file = path.join(root, code, `${name}.json`);
      if (existsSync(file)) part[name] = dropEmpty(JSON.parse(readFileSync(file, "utf8")));
    }
    registerSharedLocale(code, part);
  }
}
registerSharedLocales();

/**
 * Language when neither the request nor the profile names one (API clients, e-mails to a user who
 * never chose): English, or the installation's CDE_DEFAULT_LANGUAGE (a Turkish customer: "tr").
 * Translations missing in any language fall back to English.
 */
export const FALLBACK_LANGUAGE = "en";
export const DEFAULT_LANGUAGE =
  SERVER_LANGUAGES.find((l) => l.code === process.env.CDE_DEFAULT_LANGUAGE?.trim())?.code ?? FALLBACK_LANGUAGE;

const i18n = i18next.createInstance();
void i18n.init({
  resources: loaded.resources,
  lng: DEFAULT_LANGUAGE,
  fallbackLng: FALLBACK_LANGUAGE,
  ns: Object.keys(loaded.resources[FALLBACK_LANGUAGE] ?? {}),
  defaultNS: DEFAULT_NAMESPACE,
  interpolation: { escapeValue: false },
  initAsync: false,
});

/**
 * A module's texts (ServerModule.locales): `<dir>/<language>/<namespace>.json`, merged into the
 * core's namespaces; `labels.json` (enum label tables, `<package>/locales/shared`) goes to the
 * shared package's labels (a module may add keys to "admin", or bring its own "contracts"). Languages
 * the core does not have are ignored; a beta language's empty values fall back to English.
 */
export function registerLocaleFolder(dir: string): void {
  if (!existsSync(dir)) return;
  for (const code of readdirSync(dir)) {
    if (!SERVER_LANGUAGES.some((l) => l.code === code)) continue;
    const langDir = path.join(dir, code);
    for (const file of readdirSync(langDir)) {
      if (!file.endsWith(".json") || file === "meta.json") continue;
      const ns = file.replace(/\.json$/, "");
      const texts = dropEmpty(JSON.parse(readFileSync(path.join(langDir, file), "utf8")));
      // Enum label tables are the shared package's (labelFor), not an i18next namespace.
      if (ns === "labels") registerSharedLocale(code, { labels: texts });
      else i18n.addResourceBundle(code, ns, texts, true, true);
    }
  }
}

/** "tr", "tr-TR", "TR" → "tr" when we have it; otherwise null. */
export function supportedLanguage(code: string | null | undefined): string | null {
  if (!code) return null;
  const lower = code.trim().toLowerCase();
  const exact = SERVER_LANGUAGES.find((l) => l.code.toLowerCase() === lower);
  if (exact) return exact.code;
  const base = lower.split("-")[0];
  return SERVER_LANGUAGES.find((l) => l.code.toLowerCase() === base)?.code ?? null;
}

/** First supported language of an Accept-Language header ("tr-TR,tr;q=0.9,en;q=0.8"). */
export function fromAcceptLanguage(header: string | undefined): string | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...rest] = part.trim().split(";");
      const q = Number(rest.find((r) => r.trim().startsWith("q="))?.split("=")[1] ?? 1);
      return { tag: tag!.trim(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((x) => x.tag && x.tag !== "*" && x.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    const lang = supportedLanguage(tag);
    if (lang) return lang;
  }
  return null;
}

/** Header the web app sends with its current interface language (shared/api/client.ts). */
export const LANGUAGE_HEADER = "x-sitekeep-language";

/**
 * The language a request is answered in:
 * 1. the web app's interface language (LANGUAGE_HEADER);
 * 2. the signed-in user's profile language;
 * 3. the browser's Accept-Language (sign-in page, invitations, other clients without a profile);
 * 4. the installation default.
 * The profile comes before Accept-Language: a browser set to Turkish that calls the API directly
 * (a download link, a script) for a user who works in English gets English (#158).
 */
/** The language the client asks for, without the profile: the web app's header, else Accept-Language (null when neither). */
export function clientLanguage(req: Pick<FastifyRequest, "headers">): string | null {
  const explicit = req.headers[LANGUAGE_HEADER];
  return supportedLanguage(Array.isArray(explicit) ? explicit[0] : explicit) ?? fromAcceptLanguage(req.headers["accept-language"]);
}

export function requestLanguage(req: Pick<FastifyRequest, "headers"> & { user?: { language?: string | null } | null }): string {
  const explicit = req.headers[LANGUAGE_HEADER];
  return (
    supportedLanguage(Array.isArray(explicit) ? explicit[0] : explicit) ??
    supportedLanguage(req.user?.language) ??
    fromAcceptLanguage(req.headers["accept-language"]) ??
    DEFAULT_LANGUAGE
  );
}

// ---- Language of the running request ------------------------------------------------------------

const requestScope = new AsyncLocalStorage<() => string>();

/**
 * Runs fn with the request's language available to currentLanguage() (build-app.ts onRequest hook).
 * `lang` is read when asked, so the signed-in user's profile language counts once auth has run.
 */
export function withRequestLanguage<T>(lang: () => string, fn: () => T): T {
  return requestScope.run(lang, fn);
}

/**
 * The language of the request being answered; outside a request (jobs, startup, e-mails) the
 * installation default. For texts the requester reads where no `lang` is passed down: default
 * parameters, error texts built deep in a call, seeded labels shown in their language.
 * Stored data and texts for someone else keep an explicit language.
 */
export function currentLanguage(): string {
  const get = requestScope.getStore();
  return (get && supportedLanguage(get())) ?? DEFAULT_LANGUAGE;
}

/** The language of a person who is not the requester (notification e-mail, export for someone else). */
export function profileLanguage(prefs: { language?: string | null } | null | undefined): string {
  return supportedLanguage(prefs?.language) ?? DEFAULT_LANGUAGE;
}

function renderParams(lang: string, params: Record<string, MsgParam> | undefined): Record<string, unknown> | undefined {
  if (!params) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) out[k] = isMsg(v) ? render(lang, v) : v;
  return out;
}

/** A Msg in a language; a plain string (older stored text, user data) is returned as is. */
export function render(lang: string, m: Msg | string): string {
  if (typeof m === "string") return m;
  const t = i18n.getFixedT(supportedLanguage(lang) ?? DEFAULT_LANGUAGE);
  return t(m.key, { ...renderParams(lang, m.params), nsSeparator: ":" }) as string;
}

/** t() bound to a language, for code that builds many texts at once (exports, e-mails). */
export function tFor(lang: string) {
  return (key: MsgKey, params?: Record<string, MsgParam>) => render(lang, msg(key, params));
}

/** t() in the request's language (route handlers that build texts). */
export function tReq(req: Parameters<typeof requestLanguage>[0]) {
  return tFor(requestLanguage(req));
}

/** Intl locale of a language ("tr" → "tr-TR"), for dates and numbers in exports. */
export function intlLocale(lang: string): string {
  const code = supportedLanguage(lang) ?? DEFAULT_LANGUAGE;
  return SERVER_LANGUAGES.find((l) => l.code === code)?.intl ?? code;
}

/** An enum label of @sitekeep/shared in a language: `labelFor(lang, "issueStatus", "open")` → "Open" / "Açık". */
export function labelFor(lang: string, table: string, key: string): string {
  return labelText(supportedLanguage(lang) ?? DEFAULT_LANGUAGE, table, key);
}

/** A t() bound to one language (parsers and exports take one; default: the installation's). */
export type Translate = ReturnType<typeof tFor>;
export const defaultTranslate = (): Translate => tFor(DEFAULT_LANGUAGE);
