/**
 * The JSON object in a language model's answer, for every core feature that asks a model for JSON
 * (document intelligence, model query, letter translation, report draft schema) and for the modules
 * through the SDK (`extractJson`).
 */

import { removeThinkBlocks } from "./think.js";

/** Removes Qwen3-style reasoning blocks before the answer is parsed. */
function withoutReasoning(text: string): string {
  const rest = removeThinkBlocks(text, true, false);
  // A closer without an opener: the model's reasoning started before the answer we were given.
  const close = rest.search(/<\/think>/i);
  return (close >= 0 ? rest.slice(close + "</think>".length) : rest).trim();
}

/** The text between the first ``` fence (optionally ```json) and the next one; linear (literal searches only). */
function fencedBlock(text: string): string | null {
  const open = text.indexOf("```");
  if (open < 0) return null;
  let from = open + 3;
  if (text.slice(from, from + 4).toLowerCase() === "json") from += 4;
  const close = text.indexOf("```", from);
  return close < 0 ? null : text.slice(from, close).trim();
}

/** The first JSON object in a model answer (handles ``` fences and surrounding prose). */
export function extractJson(text: string): unknown {
  const clean = withoutReasoning(text);
  const candidates = [clean, fencedBlock(clean) ?? ""];
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(clean.slice(start, end + 1));
  for (const c of candidates) {
    const t = c.trim();
    if (!t.startsWith("{")) continue;
    try {
      return JSON.parse(t);
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error("Yanıtta geçerli bir JSON nesnesi bulunamadı."); // i18n-ok: model call error detail, also fed back to the model
}
