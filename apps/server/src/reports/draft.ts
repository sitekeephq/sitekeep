/**
 * Validation of a report draft written by a model ({name, description, queries, html}): JSON shape,
 * query specs against the datasets the caller may use, and every query read by the HTML. Used by
 * the AI builder (/reports/generate), the developer AI check and the cde_report_save tool.
 */
import { z } from "zod";
import { REPORT_HTML_MAX_BYTES, byteLength, type ReportDraft } from "@sitekeep/shared";
import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";
import type { ReportContext } from "./datasets.js";
import { extractJson } from "./llm.js";
import { PROMPT_LANGUAGE } from "./prompt-language.js";
import { queryProblems } from "./run.js";
import { normalizeQueryRefs, queryRefsSchema, zodMessages } from "./spec.js";

const queriesInput = z.preprocess(normalizeQueryRefs, queryRefsSchema);

/** The JSON object a model (or an external MCP client) must produce for a dashboard. */
export const reportDraftSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  queries: queriesInput,
  html: z.string().min(1, "html boş olamaz"), // i18n-ok: fed back to the model
});

/**
 * Validates the model's answer (text with one JSON object, or the parsed object). The errors go
 * back to the model (PROMPT_LANGUAGE); `lang` is the reader's, for the default dashboard name.
 */
export function parseDraft(
  input: string | unknown,
  ctx: Pick<ReportContext, "access">,
  lang: string = DEFAULT_LANGUAGE,
): { draft: ReportDraft } | { errors: string[] } {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = extractJson(input);
    } catch (e) {
      return { errors: [(e as Error).message + " Yalnızca tek bir JSON nesnesi döndür."] }; // i18n-ok: fed back to the model
    }
  }
  const obj = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {};
  if (typeof obj.name !== "string" || !obj.name.trim()) obj.name = tFor(lang)("reports:defaults.dashboardName");
  // Small models write ids like "open-by-company" but use d.openByCompany in the HTML.
  if (Array.isArray(obj.queries))
    obj.queries = obj.queries.map((q: unknown) =>
      q && typeof q === "object" && typeof (q as { id?: unknown }).id === "string"
        ? { ...(q as object), id: camelId((q as { id: string }).id) }
        : q,
    );
  const r = reportDraftSchema.safeParse(obj);
  if (!r.success) return { errors: zodMessages(r.error) };
  const errors: string[] = [];
  if (byteLength(r.data.html) > REPORT_HTML_MAX_BYTES) errors.push(`html en fazla ${REPORT_HTML_MAX_BYTES / 1024} KB olmalı.`); // i18n-ok: fed back to the model
  if (!r.data.queries.length) errors.push("queries boş; en az bir sorgu gerekli."); // i18n-ok: fed back to the model
  for (const p of queryProblems(r.data.queries, ctx, undefined, PROMPT_LANGUAGE)) errors.push(...p.messages.map((m) => `query '${p.id}': ${m}`));
  for (const q of r.data.queries)
    if (!new RegExp(`[.\\[]\\s*["']?${q.id}\\b`).test(r.data.html))
      errors.push(`html does not use query '${q.id}': read its rows as d.${q.id} inside CDE.onData.`);
  if (errors.length) return { errors };
  return { draft: { name: r.data.name, description: r.data.description ?? null, queries: r.data.queries, html: r.data.html } };
}

/** "open-by-company" / "open by company" → "openByCompany" (valid ids are kept). */
export function camelId(id: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(id)) return id;
  const camel = id
    .trim()
    .replace(/[^A-Za-z0-9_]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))
    .replace(/^[^A-Za-z_]+/, "");
  return camel || id;
}
