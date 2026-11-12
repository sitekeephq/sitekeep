/**
 * AI side of "Modele sor": the language model turns a question into a ModelQuery (validated JSON)
 * and words a comparison summary. Prompts stay small for slow local models: only the model's
 * vocabulary (classes, storeys, property names with a few sample values) and counts are sent,
 * never element lists. Results are cached per (versions, question).
 */
import { z } from "zod";
import {
  MODEL_QUERY_OPS,
  foldPlain,
  ifcClassLabel,
  type CompareGroupDto,
  type ModelQuery,
  type ModelVocabDto,
} from "@sitekeep/shared";
import type { AiProvider } from "../ai/provider.js";
import { extractJson } from "../reports/llm.js";
import { modelQuerySchema, normalizeQuery } from "./query.js";
import { DEFAULT_LANGUAGE, msg, render, type Msg } from "../i18n/index.js";

/** A model answer that cannot be used; `msg` is shown to the reader, `message` is the installation's language. */
export class ModelAiError extends Error {
  constructor(readonly msg: Msg) {
    super(render(DEFAULT_LANGUAGE, msg));
  }
}

/** Small LRU cache. */
export class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly size: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, v: V): void {
    this.map.delete(key);
    this.map.set(key, v);
    while (this.map.size > this.size) this.map.delete(this.map.keys().next().value!);
  }
  clear(): void {
    this.map.clear();
  }
}

/** AI-translated queries: key = versions + folded question. */
export const queryCache = new Lru<{ query: ModelQuery; model: string }>(500);
/** AI comparison summaries: key = from|to. */
export const summaryCache = new Lru<{ bullets: { text: string; groupIds: string[] }[]; model: string }>(100);

export function questionKey(versionId: string, compareFrom: string | undefined, question: string): string {
  return `${versionId}|${compareFrom ?? ""}|${foldPlain(question).replace(/[?!.]+$/, "")}`;
}

const IMPORTANT_PROP = /fire|yangin|loadbearing|isexternal|reference|status|acoustic|thermal|area|volume|length|width|height|thickness|uzunluk|alan|hacim/i;

/** Compact model vocabulary for the prompt (a few thousand characters at most). */
export function vocabText(v: Pick<ModelVocabDto, "classes" | "storeys" | "properties" | "types">, maxChars = 3500): string {
  const lines: string[] = [];
  lines.push(`Sınıflar: ${v.classes.slice(0, 30).map((c) => `${c.name} (${ifcClassLabel(c.name)}) ${c.count}`).join(", ")}`); // i18n-ok: prompt
  lines.push(`Katlar (alttan üste): ${v.storeys.map((s) => s.name).join(", ") || "—"}`); // i18n-ok: prompt
  if (v.types.length) lines.push(`Tipler: ${v.types.slice(0, 10).map((t) => t.name).join(", ")}`);
  const props = [...v.properties]
    .filter((p) => !p.key.startsWith("Attr.Description"))
    .sort((a, b) => Number(IMPORTANT_PROP.test(b.name)) - Number(IMPORTANT_PROP.test(a.name)) || b.count - a.count)
    .slice(0, 60);
  lines.push("Özellikler:"); // i18n-ok: prompt
  for (const p of props) {
    const line = p.numeric ? `- ${p.key} (sayı)` : `- ${p.key}: ${p.samples.slice(0, 5).join(" | ")}`; // i18n-ok: prompt
    if (lines.join("\n").length + line.length > maxChars) break;
    lines.push(line);
  }
  return lines.join("\n");
}

export function querySystemPrompt(comparing: boolean): string {
  return (
    "Sen bir IFC model sorgu çevirmenisin. Kullanıcının sorusunu YALNIZCA şu JSON biçimine çevir, başka bir şey yazma:\n" + // i18n-ok: prompt
    '{"classes":["IfcDoor"],"storeys":["Kat 2"],"filters":[{"field":"FireRating","op":"!=","value":"EI60"}],"groupBy":["storey"],"aggregate":{"op":"sum","field":"NetArea"}' +
    (comparing ? ',"change":["changed"]' : "") +
    "}\nKurallar:\n" +
    "- Tüm anahtarlar isteğe bağlı; gerekmeyeni yazma.\n" + // i18n-ok: prompt
    "- classes: listedeki IFC sınıf adları (IfcWall, alt türü IfcWallStandardCase'i de kapsar).\n" + // i18n-ok: prompt
    "- storeys: listedeki kat adlarından, aynen. '2. kat' = alttan sayınca zemin kattan sonraki ikinci kat.\n" + // i18n-ok: prompt
    `- filters.op: ${MODEL_QUERY_OPS.join(" ")}. 'X olmayan' → '!='. 'yangın kapıları' → {"field":"FireRating","op":"exists"}.\n` + // i18n-ok: prompt
    "- field: class, storey, type, name, material ya da listedeki bir özellik (kısa ad yeterli: FireRating).\n" + // i18n-ok: prompt
    "- aggregate: 'kaç m²/m³, toplam alan/hacim' → sum ve listedeki sayısal miktar (NetArea, NetVolume …). Yalnız 'kaç tane' için aggregate yazma.\n" + // i18n-ok: prompt
    "- groupBy: 'katlara göre' → [\"storey\"], 'tipe göre' → [\"type\"].\n" + // i18n-ok: prompt
    (comparing ? "- change: added (eklenen), changed (değişen), removed (silinen).\n" : "") // i18n-ok: prompt
  );
}

const OP_ALIASES: Record<string, string> = {
  "==": "=",
  eq: "=",
  equals: "=",
  "<>": "!=",
  neq: "!=",
  ne: "!=",
  not_equals: "!=",
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
  like: "contains",
  includes: "contains",
  isnull: "missing",
  notnull: "exists",
  not_exists: "missing",
  has: "exists",
};

/** Tolerant clean-up of a model's JSON before strict validation (nulls, op spellings, wrappers). */
export function cleanAiQuery(raw: unknown): unknown {
  let o = raw as Record<string, unknown>;
  if (o && typeof o === "object" && o.query && typeof o.query === "object") o = o.query as Record<string, unknown>;
  if (!o || typeof o !== "object" || Array.isArray(o)) return o;
  const out: Record<string, unknown> = {};
  const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : undefined);
  for (const k of ["classes", "storeys", "groupBy", "change"]) {
    const l = list(o[k])?.filter((x) => typeof x === "string" && x.trim());
    if (l?.length) out[k] = l;
  }
  if (Array.isArray(o.filters)) {
    out.filters = (o.filters as Record<string, unknown>[])
      .filter((f) => f && typeof f === "object" && typeof f.field === "string")
      .map((f) => {
        const op = String(f.op ?? "=").trim().toLowerCase();
        const clean: Record<string, unknown> = { field: f.field, op: OP_ALIASES[op] ?? op };
        if (f.value !== null && f.value !== undefined && f.value !== "") clean.value = f.value;
        return clean;
      });
    if (!(out.filters as unknown[]).length) delete out.filters;
  }
  if (o.aggregate && typeof o.aggregate === "object") {
    const a = o.aggregate as Record<string, unknown>;
    if (typeof a.op === "string") out.aggregate = { op: a.op.toLowerCase(), ...(typeof a.field === "string" && a.field ? { field: a.field } : {}) };
  }
  if (typeof o.limit === "number") out.limit = o.limit;
  return out;
}

/** Asks the model for a query; throws when its answer is not a valid query. */
export async function aiQuery(
  provider: AiProvider,
  question: string,
  vocab: Pick<ModelVocabDto, "classes" | "storeys" | "properties" | "types">,
  opts: { comparing: boolean; signal?: AbortSignal },
): Promise<{ query: ModelQuery; model: string }> {
  const res = await provider.chat(
    [
      { role: "system", content: querySystemPrompt(opts.comparing) },
      { role: "user", content: `Model sözlüğü:\n${vocabText(vocab)}\n\nSoru: ${question.slice(0, 500)}` }, // i18n-ok: prompt
    ],
    { maxTokens: 600, timeoutMs: 240_000, signal: opts.signal, json: true },
  );
  let parsed: unknown;
  try {
    parsed = extractJson(res.text);
  } catch {
    throw new ModelAiError(msg("model:errors.aiQueryInvalid"));
  }
  const q = modelQuerySchema.safeParse(cleanAiQuery(parsed));
  if (!q.success) throw new ModelAiError(msg("model:errors.aiQueryRejected", { detail: q.error.issues.map((i) => i.message).slice(0, 3).join("; ") }));
  return { query: normalizeQuery(q.data), model: res.model };
}

const summarySchema = z.object({
  bullets: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(400),
        refs: z.array(z.string()).max(20).optional(),
        groupIds: z.array(z.string()).max(20).optional(),
      }),
    )
    .min(1)
    .max(10),
});

/** AI narrative over the deterministic change groups; refs point to group ids (clickable in the viewer). */
export async function aiCompareSummary(
  provider: AiProvider,
  head: string,
  groups: CompareGroupDto[],
  signal?: AbortSignal,
): Promise<{ bullets: { text: string; groupIds: string[] }[]; model: string }> {
  const shown = groups.slice(0, 20);
  const lines = shown.map((g) => `${g.id}: ${g.text}`);
  const res = await provider.chat(
    [
      {
        role: "system",
        content:
          "Sen bir BIM koordinatörüsün. İki IFC model versiyonu arasındaki değişiklik grupları verilecek (id: metin). " + // i18n-ok: prompt
          "Bunları Türkçe, en fazla 5 kısa maddede özetle; önemli olanlar (yangın, taşıyıcı, silinen ve eklenen elemanlar) önce. " + // i18n-ok: prompt
          "Benzer grupları bir maddede birleştirebilirsin. Yalnızca gruplardaki kat, sınıf, sayı ve değerleri kullan; hiçbir şey uydurma. " + // i18n-ok: prompt
          "Her maddenin refs alanına dayandığı grup id'lerini yaz. " + // i18n-ok: prompt
          'Yalnızca JSON döndür: {"bullets":[{"text":"…","refs":["g…"]}]}', // i18n-ok: prompt
      },
      { role: "user", content: `${head}\nGruplar:\n${lines.join("\n")}` },
    ],
    { maxTokens: 600, timeoutMs: 240_000, signal },
  );
  let parsed: unknown;
  try {
    parsed = extractJson(res.text);
  } catch {
    throw new ModelAiError(msg("model:errors.aiSummaryInvalid"));
  }
  const s = summarySchema.safeParse(parsed);
  if (!s.success) throw new ModelAiError(msg("model:errors.aiSummaryInvalid"));
  const known = new Set(groups.map((g) => g.id));
  // Numbers the model may use: only those in the input (a bullet with an invented count is dropped).
  const allowed = new Set(`${head} ${shown.map((g) => g.text).join(" ")}`.match(/\d+(?:[.,]\d+)?/g) ?? []);
  const bullets = s.data.bullets
    .filter((b) => (b.text.match(/\d+(?:[.,]\d+)?/g) ?? []).every((n) => allowed.has(n)))
    .slice(0, 8)
    .map((b) => {
      const refs = [...new Set([...(b.refs ?? []), ...(b.groupIds ?? [])])].filter((id) => known.has(id));
      return { text: b.text, groupIds: refs.length ? refs : inferRefs(b.text, shown) };
    });
  if (!bullets.length) throw new ModelAiError(msg("model:errors.aiInventedNumbers"));
  return { bullets, model: res.model };
}

/** Groups a bullet talks about when the model gave no refs: most of a group's words occur in it. */
export function inferRefs(text: string, groups: CompareGroupDto[]): string[] {
  const words = (t: string) => foldPlain(t).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 || /\d/.test(w));
  const have = new Set(words(text));
  return groups
    .filter((g) => {
      const w = [...new Set(words(`${g.storey ?? ""} ${ifcClassLabel(g.class)} ${g.prop ? g.prop.slice(g.prop.lastIndexOf(".") + 1) : ""} ${g.to ?? ""}`))];
      return w.length > 0 && w.filter((x) => have.has(x)).length / w.length >= 0.75;
    })
    .map((g) => g.id);
}
