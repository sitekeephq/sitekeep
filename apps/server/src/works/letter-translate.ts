/**
 * "Yapay zekâ ile çevir" for official letters: suggestions only; the model comes from the core's
 * door (ai/provider.ts), so without the AI module the route answers "yapay zekâ kapalı".
 */
import { z } from "zod";
import type { AiProvider } from "../ai/provider.js";
import { extractJson } from "../reports/llm.js";
import { HttpError } from "../core/platform/http.js";
import { msg } from "../i18n/index.js";

export const translationSchema = z.object({
  subject: z.string().max(1000).nullish(),
  body: z.string().max(60000).nullish(),
  body2: z.string().max(60000).nullish(),
  signerTitle: z.string().max(400).nullish(),
});

export interface LetterTranslationSuggestion {
  subject: string;
  body: string;
  body2: string;
  signerTitle: string;
}

/**
 * "Yapay zekâ ile çevir": translates the Turkish letter texts into `language` (e.g. "English").
 * Suggestions only; the user reviews them in the translation form and saves.
 */
export async function translateLetter(
  provider: AiProvider,
  language: string,
  source: LetterTranslationSuggestion,
): Promise<LetterTranslationSuggestion> {
  const filled = Object.fromEntries(Object.entries(source).filter(([, v]) => v.trim()));
  if (!Object.keys(filled).length) return { subject: "", body: "", body2: "", signerTitle: "" };
  const system =
    `Translate the Turkish texts of an official construction-project letter into ${language}. ` +
    'Return only JSON with the same keys: {"subject":"…","body":"…","body2":"…","signerTitle":"…"}. ' +
    'Keep line breaks, "- " bullets, **bold** markers, numbers, codes and names unchanged. Formal register, no additions.';
  const res = await provider.chat(
    [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(filled) },
    ],
    { maxTokens: 6000, timeoutMs: 180_000, json: true },
  );
  const parsed = translationSchema.safeParse(extractJson(res.text));
  if (!parsed.success) throw new HttpError(502, "ai_bad_answer", msg("works:errors.aiBadTranslation"));
  const pick = (k: keyof LetterTranslationSuggestion) => (source[k].trim() ? (parsed.data[k] ?? "").trim() : "");
  return { subject: pick("subject"), body: pick("body"), body2: pick("body2"), signerTitle: pick("signerTitle") };
}
