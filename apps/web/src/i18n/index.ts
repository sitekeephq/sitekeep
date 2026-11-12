/**
 * Interface languages (docs/architecture/i18n.md).
 *
 *   initI18n()        before the first render: English bundled, the remembered language loaded
 *   setLanguage(code) switcher / profile: loads that language's files once, then switches
 *   useTranslation()  in components (react-i18next), keys typed from locales/en
 *
 * Choice order: the user's profile (users.prefs.language, applied after sign-in) → this browser
 * (localStorage) → English. The browser language is not consulted: the product default is English.
 */
import { initReactI18next } from "react-i18next";
import { registerSharedLocale } from "@sitekeep/shared";
import { i18n } from "./instance";
import { turkishLabels } from "./labels";
import {
  DEFAULT_LANGUAGE,
  FALLBACK_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  languageMeta,
  supportedLanguage,
} from "./languages";
import { DEFAULT_NAMESPACE, NAMESPACES, en } from "./resources";

export { i18n } from "./instance";
export { LANGUAGES, DEFAULT_LANGUAGE, languageMeta, supportedLanguage, type LanguageMeta } from "./languages";
export { useLabel, label, labelEntries, type LabelTable } from "./labels";

/**
 * The shared package's texts of each language (enum labels, validation messages): English and
 * Turkish are bundled with it; other languages are registered when chosen.
 */
const sharedLoaders = import.meta.glob<Record<string, unknown>>("../../../../packages/shared/src/locales/*/*.json", { import: "default" });

/** Every non-English namespace file, one chunk per file, fetched when its language is chosen. */
const loaders = import.meta.glob<Record<string, unknown>>(["./locales/*/*.json", "!./locales/*/meta.json", "!./locales/en/*.json"], {
  import: "default",
});

const loaded = new Set<string>([FALLBACK_LANGUAGE]);

/** A module's namespace file in one language: English inline, others loaded when chosen. */
export interface ModuleLocale {
  lang: string;
  ns: string;
  data?: Record<string, unknown>;
  load?: () => Promise<Record<string, unknown>>;
}

const moduleLocales: ModuleLocale[] = [];

async function moduleTexts(entry: ModuleLocale): Promise<Record<string, unknown>> {
  const texts = withoutEmpty(entry.data ?? (await entry.load!()));
  // A module's enum label tables also serve the shared package's labelText().
  if (entry.ns === "labels") registerSharedLocale(entry.lang, { labels: texts });
  return texts;
}

/**
 * The installed modules' texts (app/modules.ts), merged into the core's namespaces. Before
 * initI18n they join the start-up resources; later the languages already in are filled at once.
 */
export function addModuleLocales(entries: readonly ModuleLocale[]): void {
  moduleLocales.push(...entries);
  if (!i18n.isInitialized) return;
  for (const entry of entries) {
    if (!loaded.has(entry.lang)) continue;
    void moduleTexts(entry).then((texts) => i18n.addResourceBundle(entry.lang, entry.ns, texts, true, true));
  }
}

/** A beta language's untranslated keys are empty strings: drop them so English shows instead. */
function withoutEmpty(tree: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tree)) {
    if (typeof v === "string") {
      if (v.trim()) out[k] = v;
    } else if (v && typeof v === "object") out[k] = withoutEmpty(v as Record<string, unknown>);
  }
  return out;
}

async function loadLanguage(code: string): Promise<void> {
  if (loaded.has(code)) return;
  const files = Object.entries(loaders).filter(([file]) => file.split("/")[2] === code);
  await Promise.all(
    files.map(async ([file, load]) => {
      const ns = file.split("/")[3]!.replace(/\.json$/, "");
      i18n.addResourceBundle(code, ns, withoutEmpty(await load()), true, true);
    }),
  );
  // The modules' files of this language, over the core's.
  await Promise.all(
    moduleLocales
      .filter((entry) => entry.lang === code)
      .map(async (entry) => i18n.addResourceBundle(code, entry.ns, await moduleTexts(entry), true, true)),
  );
  // Turkish enum labels come from @sitekeep/shared, the source the server uses too.
  if (code === "tr") i18n.addResourceBundle("tr", "labels", turkishLabels(), true, true);
  for (const [file, load] of Object.entries(sharedLoaders)) {
    const [lang, name] = file.split("/").slice(-2);
    if (lang !== code || code === "en") continue;
    const part = withoutEmpty(await load());
    registerSharedLocale(code, { [name!.replace(/\.json$/, "")]: part });
    if (name === "labels.json") i18n.addResourceBundle(code, "labels", part, true, true);
  }
  loaded.add(code);
}

function readStored(): string | null {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function store(code: string) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
  } catch {
    // Private mode: the choice lasts for this page only (and the profile still has it).
  }
}

function applyToDocument(code: string) {
  if (typeof document === "undefined") return;
  const meta = languageMeta(code);
  document.documentElement.lang = meta.code;
  document.documentElement.dir = meta.dir;
}

export async function initI18n(): Promise<void> {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      resources: { [FALLBACK_LANGUAGE]: en },
      lng: FALLBACK_LANGUAGE,
      fallbackLng: FALLBACK_LANGUAGE,
      ns: [...NAMESPACES], // a copy: i18next adds the modules' namespaces to this list
      defaultNS: DEFAULT_NAMESPACE,
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
      saveMissing: import.meta.env.DEV,
      missingKeyHandler: (lngs, ns, key) => console.warn(`[i18n] missing ${lngs.join(",")}:${ns}:${key}`),
    });
  }
  for (const entry of moduleLocales.filter((e) => e.lang === FALLBACK_LANGUAGE)) {
    i18n.addResourceBundle(FALLBACK_LANGUAGE, entry.ns, await moduleTexts(entry), true, true);
  }
  await setLanguage(supportedLanguage(readStored()) ?? DEFAULT_LANGUAGE, { persist: false });
}

/** Switches the interface; unknown codes fall back to the default. Resolves once the texts are in. */
export async function setLanguage(code: string, options: { persist?: boolean } = {}): Promise<string> {
  const lang = supportedLanguage(code) ?? DEFAULT_LANGUAGE;
  await loadLanguage(lang);
  if (i18n.language !== lang) await i18n.changeLanguage(lang);
  applyToDocument(lang);
  if (options.persist !== false) store(lang);
  return lang;
}

export function currentLanguage(): string {
  return i18n.resolvedLanguage ?? i18n.language ?? DEFAULT_LANGUAGE;
}

/** Intl locale of the current language ("en-GB", "tr-TR"): dates, numbers, sorting. */
export function currentIntlLocale(): string {
  return languageMeta(currentLanguage()).intl;
}
