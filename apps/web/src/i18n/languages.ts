/**
 * The languages the interface offers: every folder under ./locales with a meta.json. Adding a
 * language is adding a folder (docs/architecture/i18n.md); nothing in this file changes.
 */

export interface LanguageMeta {
  /** BCP 47 code: the folder name ("en", "tr", "es", "pt-BR"). */
  code: string;
  /** The language's own name, shown in the switcher ("Español"). */
  name: string;
  /** Short label of the top bar button ("ES"). */
  short: string;
  /** Locale for Intl dates and numbers ("es-ES"). */
  intl: string;
  dir: "ltr" | "rtl";
  /**
   * complete: every key translated (the parity test enforces it). beta: may lack keys, which fall
   * back to English; listed in the switcher with "beta".
   */
  status: "complete" | "beta";
}

export const DEFAULT_LANGUAGE = "en";
/** Missing keys of any language fall back to this one; it must stay complete. */
export const FALLBACK_LANGUAGE = "en";
/** Browser memory of the choice, read before the user is known (login page, first paint). */
export const LANGUAGE_STORAGE_KEY = "cde.language";

const metas = import.meta.glob<Omit<LanguageMeta, "code">>("./locales/*/meta.json", { eager: true, import: "default" });

export const LANGUAGES: LanguageMeta[] = Object.entries(metas)
  .map(([file, meta]) => ({ ...meta, code: file.split("/")[2]! }))
  .sort((a, b) => (a.code === DEFAULT_LANGUAGE ? -1 : b.code === DEFAULT_LANGUAGE ? 1 : a.name.localeCompare(b.name)));

export function languageMeta(code: string): LanguageMeta {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES.find((l) => l.code === DEFAULT_LANGUAGE)!;
}

/** A stored or requested code we offer ("es-MX" → "es" when only "es" exists), else null. */
export function supportedLanguage(code: string | null | undefined): string | null {
  if (!code) return null;
  const exact = LANGUAGES.find((l) => l.code.toLowerCase() === code.toLowerCase());
  if (exact) return exact.code;
  const base = code.split("-")[0]!.toLowerCase();
  return LANGUAGES.find((l) => l.code.toLowerCase() === base)?.code ?? null;
}
