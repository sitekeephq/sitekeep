/**
 * The JSON object in a language model's answer, for every core feature that asks a model for JSON
 * (document intelligence, model query, letter translation, report draft schema) and for the modules
 * through the SDK (`extractJson`).
 */

import { removeThinkBlocks } from "./think.js";

/** Removes Qwen3-style reasoning blocks before the answer is parsed. */
function withoutReasoning(text: string): string {
  return removeThinkBlocks(text, true, false).replace(/^[\s\S]*?<\/think>/i, "").trim();
}

/** The first JSON object in a model answer (handles ``` fences and surrounding prose). */
export function extractJson(text: string): unknown {
  const clean = withoutReasoning(text);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(clean);
  const candidates = [clean, fenced?.[1] ?? ""];
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
