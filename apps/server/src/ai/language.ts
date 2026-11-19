/**
 * Output language of the AI features (docs/architecture/i18n.md §8.4).
 *
 * Prompts may be written in any language (most are Turkish or English); what the model writes for
 * the user follows one of two rules, chosen per feature:
 *
 *   - answer language (summaries, reports, answers): the requester's interface language
 *     (requestLanguage), unless the user's own request explicitly asks for another language;
 *   - source language (extraction from a text the user gives): the language of that text, with
 *     the interface language as the fallback when it is unclear.
 *
 * Turkish output also gets the CDE's Turkish terms (termsInstructionTr), so Turkish users keep
 * seeing "bilgi talebi", "sıradaki taraf"… instead of the English construction-software words.
 */
import { termsInstructionTr } from "@sitekeep/shared";
import { DEFAULT_LANGUAGE } from "../i18n/index.js";

/** English name of a language code for prompts ("tr" → "Turkish"); the code itself when unknown. */
export function aiLanguageName(lang: string | null | undefined): string {
  const code = (lang || DEFAULT_LANGUAGE).trim();
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
    if (name && name.toLowerCase() !== code.toLowerCase()) return name;
  } catch {
    /* not a valid tag */
  }
  return code;
}

const isTurkish = (lang: string | null | undefined) => (lang || DEFAULT_LANGUAGE).toLowerCase().split("-")[0] === "tr";

/** Prompt rule: write in the user's interface language unless the request explicitly asks otherwise. */
export function answerLanguageRule(lang: string | null | undefined): string {
  const name = aiLanguageName(lang);
  return (
    `Write every text the user will read in ${name} (the user's interface language), whatever the language of these instructions or of the data, ` +
    `unless the user's request explicitly asks for another language; then use that language.` +
    (isTurkish(lang) ? ` ${termsInstructionTr()}` : "")
  );
}

/** Prompt rule for extraction: keep the language of the given text; the interface language when unclear. */
export function sourceLanguageRule(lang: string | null | undefined, source = "the given text"): string {
  return (
    `Write the extracted texts in the language of ${source}, whatever the language of these instructions; ` +
    `if that is unclear or mixed, use ${aiLanguageName(lang)} (the user's interface language).`
  );
}
