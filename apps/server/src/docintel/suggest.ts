/**
 * Naming and attribute suggestions from a title block, the file name and the folder path.
 *
 * Deterministic first: a document code in the title block that validates is taken as a whole;
 * otherwise every field of the standard is mapped from evidence (exact codes, descriptions,
 * numbers, single allowed values). Only allowed values are ever proposed, and a name is
 * suggested only when the validator accepts it. The language model (optional) is asked only
 * about ambiguous fields and its answer is dropped unless the resulting name validates.
 */
import {
  checkAttributeValue,
  type AntetFieldKey,
  type AntetResult,
  type AttributeDefinition,
  type NamingSuggestionDto,
  type RevisionInfo,
  type SuggestedAttribute,
  type SuggestedField,
} from "@sitekeep/shared";
import type { AiProvider } from "../ai/provider.js";
import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";
import { pdfErrorText } from "./extract.js";
import { extractJson } from "../reports/llm.js";
import {
  composeName,
  extensionOf,
  fitNumber,
  nameFields,
  parseFields,
  validate,
  type NamingField,
  type NamingStandard,
} from "./naming-adapter.js";
import { isRevisionAttribute } from "./revision.js";
import { fold, foldKey, parseDate } from "./text.js";

export interface SuggestInput {
  standard: NamingStandard | null;
  fileName: string;
  antet: AntetResult | null;
  revision: RevisionInfo | null;
  /** Folder names from the project root down to the target folder. */
  folderNames: string[];
  attributeDefs: readonly AttributeDefinition[];
  /** Current attribute values (for "already set" checks). */
  currentAttributes?: Record<string, string>;
  /** Language of the explanations (the reader's); default: the installation's. */
  lang?: string;
}

type T = ReturnType<typeof tFor>;
const translator = (input: Pick<SuggestInput, "lang">): T => tFor(input.lang ?? DEFAULT_LANGUAGE);

interface Evidence {
  text: string;
  origin: "antet" | "code" | "filename" | "folder";
  /** Printed label ("Pafta No") or folder name, for explanations. */
  label: string | null;
  key: AntetFieldKey | null;
}

const ORIGIN_WEIGHT: Record<Evidence["origin"], number> = { antet: 1, code: 0.95, filename: 0.85, folder: 0.7 };
const NUMBERISH: AntetFieldKey[] = ["sheetNo", "drawingNo", "docNo", "projectNo"];

/** Builds the deterministic suggestion. */
export function suggestNaming(input: SuggestInput): NamingSuggestionDto {
  const t = translator(input);
  const attributes = suggestAttributes(input);
  const { standard, fileName } = input;
  if (!standard) {
    return { standard: null, name: null, ok: true, errors: [], fields: [], attributes, unchanged: true, ai: null };
  }
  const ext = extensionOf(fileName);
  const fields = nameFields(standard);

  // 1. A full document code printed in the title block.
  const codeTexts = [
    ...(input.antet?.fields.filter((f) => ["docNo", "drawingNo", "sheetNo"].includes(f.key)).map((f) => ({ text: f.value, label: f.label })) ?? []),
    ...(input.antet?.codes.map((c) => ({ text: c, label: null as string | null })) ?? []),
  ];
  for (const c of codeTexts) {
    for (const candidate of codeVariants(c.text)) {
      const r = validate(standard, ext ? `${candidate}.${ext}` : candidate);
      if (!r.ok) continue;
      const values = parseFields(standard, r.baseName);
      const named = fileValues(standard, fileName);
      const result: SuggestedField[] = fields.map((f) => ({
        field: f.name,
        value: values[f.name] ?? null,
        confidence: 0.95,
        explanation: c.label
          ? t("docintel:suggest.fromAntetLabel", { label: c.label, text: c.text, field: f.name, value: values[f.name] })
          : t("docintel:suggest.fromAntetDocCode", { code: candidate, field: f.name, value: values[f.name] }),
        alternatives: named[f.name] && named[f.name] !== values[f.name] ? [named[f.name]!] : [],
        ambiguous: false,
        source: "code",
      }));
      return finish(standard, fileName, ext, result, attributes, t, input.lang ?? DEFAULT_LANGUAGE);
    }
  }

  // 2. Field by field.
  const evidence = collectEvidence(input, standard);
  const named = fileValues(standard, fileName);
  const result = fields.map((f) => mapField(f, evidence, named, input, fields, t));
  return finish(standard, fileName, ext, result, attributes, t, input.lang ?? DEFAULT_LANGUAGE);
}

/** "ZAVM-…-0001", also without a trailing revision or text ("ZAVM-…-0001-P02", "ZAVM-…-0001 Rev.B"). */
function codeVariants(text: string): string[] {
  const t = text.trim();
  const out = [t];
  const first = t.split(/\s+/)[0]!;
  if (first !== t) out.push(first);
  return [...new Set(out)];
}

function fileValues(standard: NamingStandard, fileName: string): Record<string, string> {
  return parseFields(standard, fileName);
}

function collectEvidence(input: SuggestInput, standard: NamingStandard): Evidence[] {
  const ev: Evidence[] = [];
  const a = input.antet;
  if (a) {
    for (const f of a.fields) ev.push({ text: f.value, origin: "antet", label: f.label, key: f.key });
    for (const p of a.pairs) if (!p.key) ev.push({ text: p.value, origin: "antet", label: p.label, key: null });
    for (const c of a.codes) ev.push({ text: c, origin: "code", label: "Doküman Kodu", key: null }); // i18n-ok: matched against field names (affinity), not shown
  }
  const base = input.fileName.replace(/\.[^.]+$/, "");
  ev.push({ text: base, origin: "filename", label: null, key: null });
  for (const name of input.folderNames.slice(1)) ev.push({ text: name, origin: "folder", label: name, key: null });
  void standard;
  return ev;
}

function tokens(text: string): string[] {
  return text.split(/[\s\-_./,;:()]+/).filter(Boolean);
}

function affinity(field: NamingField, ev: Evidence): boolean {
  if (!ev.label) return false;
  const a = foldKey(field.name);
  const b = foldKey(ev.label);
  return !!a && !!b && (a === b || b.includes(a) || a.includes(b));
}

interface Scored {
  value: string;
  score: number;
  explanation: string;
  source: SuggestedField["source"];
}

function describe(ev: Evidence, field: string, value: string, t: T): string {
  switch (ev.origin) {
    case "antet":
      return ev.label
        ? t("docintel:suggest.fromAntetLabel", { label: ev.label, text: ev.text, field, value })
        : t("docintel:suggest.fromAntet", { text: ev.text, field, value });
    case "code":
      return t("docintel:suggest.fromAntetCode", { code: ev.text, field, value });
    case "filename":
      return t("docintel:suggest.fromFileName", { text: ev.text, field, value });
    case "folder":
      return t("docintel:suggest.fromFolder", { folder: ev.label, field, value });
  }
}

function sourceOf(ev: Evidence): SuggestedField["source"] {
  return ev.origin === "code" ? "antet" : ev.origin;
}

/** Turkish or English, judged from the title-block labels. */
function documentLanguage(antet: AntetResult | null): "tr" | "en" | null {
  if (!antet) return null;
  const tr = ["cizim no", "olcek", "tarih", "pafta adi", "pafta no", "cizen", "kontrol", "onay", "revizyon", "proje adi", "dokuman no"];
  const en = ["drawing no", "scale", "date", "title", "drawn by", "checked by", "approved by", "revision", "project name", "document no"];
  let t = 0;
  let e = 0;
  for (const f of antet.fields) {
    const k = foldKey(f.label);
    if (tr.includes(k)) t++;
    if (en.includes(k)) e++;
  }
  if (t > e) return "tr";
  if (e > t) return "en";
  return null;
}

function mapField(
  field: NamingField,
  evidence: Evidence[],
  named: Record<string, string>,
  input: SuggestInput,
  all: NamingField[],
  t: T,
): SuggestedField {
  const scored: Scored[] = [];
  const push = (s: Scored) => scored.push(s);

  const fromName = named[field.name];
  if (fromName) push({ value: fromName, score: 0.8, explanation: t("docintel:suggest.fromCurrentName", { field: field.name, value: fromName }), source: "filename" });

  if (field.type === "list") {
    for (const ev of evidence) {
      if (ev.origin === "filename" && fromName) continue;
      const w = ORIGIN_WEIGHT[ev.origin];
      const bonus = affinity(field, ev) ? 0.12 : 0;
      const whole = fold(ev.text);
      const toks = tokens(ev.text);
      for (const v of field.values) {
        const code = fold(v.code);
        const desc = v.description ? fold(v.description) : "";
        let s = 0;
        if (whole === code) s = 1;
        else if (desc && whole === desc) s = 0.9;
        else if (toks.some((t) => fold(t) === code)) s = code.length >= 2 ? 0.75 : affinity(field, ev) ? 0.7 : 0.4;
        else if (desc && desc.length >= 4 && containsWords(whole, desc)) s = 0.65;
        else if (desc && whole.length >= 4 && containsWords(desc, whole)) s = 0.55;
        else if (/\d/.test(v.code) && numericEqual(v.code, toks)) s = 0.5;
        if (!s) continue;
        push({ value: v.code, score: Math.min(1, s * w + bonus), explanation: describe(ev, field.name, v.code, t), source: sourceOf(ev) });
      }
    }
    // Document language.
    const lang = documentLanguage(input.antet);
    if (lang && /^(dil|language|lang)$/.test(foldKey(field.name))) {
      const want = lang === "tr" ? ["t", "tr", "turkce"] : ["e", "en", "ingilizce", "english"];
      const v = field.values.find((x) => want.includes(fold(x.code)) || (x.description && want.includes(fold(x.description))));
      if (v) push({ value: v.code, score: 0.55, explanation: t(lang === "tr" ? "docintel:suggest.labelsTurkish" : "docintel:suggest.labelsEnglish", { field: field.name, value: v.code }), source: "language" });
    }
    if (field.values.length === 1 && !scored.length) {
      const v = field.values[0]!;
      push({ value: v.code, score: 0.85, explanation: t("docintel:suggest.singleValue", { field: field.name, value: v.code }), source: "single" });
    }
  } else if (field.type === "number") {
    const numberFields = all.filter((f) => f.type === "number");
    for (const ev of evidence) {
      if (ev.origin !== "antet" || !ev.key || !NUMBERISH.includes(ev.key)) continue;
      // Ignore full document codes here; they are handled as a whole.
      if (tokens(ev.text).length > 4) continue;
      const groups = ev.text.match(/\d+/g) ?? [];
      if (!groups.length) continue;
      let raw: string | undefined;
      let score = 0.5;
      if (groups.length === numberFields.length && groups.length > 1) {
        raw = groups[numberFields.indexOf(field)];
        score = 0.6;
      } else {
        raw = groups[groups.length - 1];
        if (numberFields.length > 1) score = 0.42;
      }
      if (affinity(field, ev)) score += 0.2;
      const v = raw ? fitNumber(field, raw) : null;
      if (v) push({ value: v, score, explanation: describe(ev, field.name, v, t), source: "antet" });
    }
  } else {
    const titleLike = /(ad|adi|baslik|konu|aciklama|title|name|tanim)$/.test(foldKey(field.name));
    const title = input.antet?.fields.find((f) => f.key === "title");
    if (titleLike && title) {
      const v = cleanText(field, title.value);
      if (v) push({ value: v, score: 0.6, explanation: t("docintel:suggest.fromAntetText", { label: title.label, text: title.value, field: field.name }), source: "antet" });
    }
    for (const ev of evidence) {
      if (ev.origin === "antet" && !ev.key && affinity(field, ev)) {
        const v = cleanText(field, ev.text);
        if (v) push({ value: v, score: 0.65, explanation: describe(ev, field.name, v, t), source: "antet" });
      }
    }
  }

  // Best score per value.
  const best = new Map<string, Scored>();
  for (const s of scored) {
    const cur = best.get(s.value);
    if (!cur || s.score > cur.score) best.set(s.value, s);
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score);
  const top = ranked[0];
  const second = ranked[1];
  if (!top) {
    return { field: field.name, value: null, confidence: 0, explanation: t("docintel:suggest.noEvidence", { field: field.name }), alternatives: [], ambiguous: false, source: null };
  }
  const close = !!second && top.score - second.score < 0.15 && second.score >= 0.4;
  const weak = top.score < 0.45;
  return {
    field: field.name,
    value: weak ? null : top.value,
    confidence: round2(close ? top.score * 0.75 : top.score),
    explanation: close ? t("docintel:suggest.otherCandidate", { text: top.explanation, value: second!.value }) : top.explanation,
    alternatives: ranked.slice(weak ? 0 : 1, 6).map((r) => r.value),
    ambiguous: close || weak,
    source: weak ? null : top.source,
  };
}

function cleanText(field: NamingField, raw: string): string | null {
  if (field.type !== "text") return null;
  let v = raw.replace(/\s+/g, " ").trim();
  if (field.maxLength !== undefined) v = v.slice(0, field.maxLength).trim();
  if (field.minLength !== undefined && v.length < field.minLength) return null;
  return v || null;
}

function containsWords(hay: string, needle: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(hay);
}

function numericEqual(code: string, toks: string[]): boolean {
  const n = code.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  if (!n || code.replace(/\d/g, "").length > 0) return false;
  return toks.some((t) => /^[A-Za-z]{0,2}\d+$/.test(t) && t.replace(/\D/g, "").replace(/^0+(?=\d)/, "") === n);
}

function finish(
  standard: NamingStandard,
  fileName: string,
  ext: string,
  fields: SuggestedField[],
  attributes: SuggestedAttribute[],
  t: T,
  lang: string,
): NamingSuggestionDto {
  const values = Object.fromEntries(fields.map((f) => [f.field, f.value]));
  const name = composeName(standard, values, ext);
  if (name) {
    const r = validate(standard, name, lang);
    if (r.ok) {
      return { standard: standard.name, name, ok: true, errors: [], fields, attributes, unchanged: name === fileName, ai: null };
    }
    return { standard: standard.name, name: null, ok: false, errors: r.errors, fields, attributes, unchanged: false, ai: null };
  }
  const missing = fields.filter((f) => !f.value).map((f) => f.field);
  return {
    standard: standard.name,
    name: null,
    ok: false,
    errors: missing.length ? [t("docintel:suggest.undetermined", { fields: missing.join(", ") })] : [],
    fields,
    attributes,
    unchanged: false,
    ai: null,
  };
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

const ATTR_MAP: { test: (k: string) => boolean; key: AntetFieldKey }[] = [
  { test: (k) => /(pafta|dokuman|cizim|resim) (dokuman )?adi$|^baslik$|^konu$|^title$|pafta dokuman adi/.test(k), key: "title" },
  { test: (k) => /^(olcek|scale)$/.test(k), key: "scale" },
  { test: (k) => /^(cizen|drawn by|hazirlayan)$/.test(k), key: "drawnBy" },
  { test: (k) => /^(kontrol|kontrol eden|checked by)$/.test(k), key: "checkedBy" },
  { test: (k) => /^(onaylayan|approved by)$/.test(k), key: "approvedBy" },
  { test: (k) => /^(tarih|date|cizim tarihi|pafta tarihi)$/.test(k), key: "date" },
  { test: (k) => /^(pafta no|sheet no)$/.test(k), key: "sheetNo" },
  { test: (k) => /^(cizim no|drawing no)$/.test(k), key: "drawingNo" },
  { test: (k) => /^(ölcek)$/.test(k), key: "scale" },
];

export function suggestAttributes(input: SuggestInput): SuggestedAttribute[] {
  const t = translator(input);
  const out: SuggestedAttribute[] = [];
  const antet = input.antet;
  const rev = input.revision;
  for (const def of input.attributeDefs) {
    const k = foldKey(def.name);
    let value: string | null = null;
    let explanation = "";
    let confidence = 0;
    if (isRevisionAttribute(def.name) && rev?.value) {
      value = rev.value;
      const c = rev.candidates.find((x) => x.source === rev.source);
      explanation = revisionExplanation(t, rev.source, c?.raw ?? rev.value, def.name, rev.value);
      confidence = rev.confidence;
    } else if (/^(revizyon tarihi|rev tarihi|revision date)$/.test(k) && antet?.revisionTable.length) {
      const last = antet.revisionTable[antet.revisionTable.length - 1]!;
      if (last.date) {
        value = parseDate(last.date) ?? last.date;
        explanation = t("docintel:suggest.fromRevisionTableRow", { rev: last.rev, name: def.name, value });
        confidence = 0.7;
      }
    } else {
      const m = ATTR_MAP.find((x) => x.test(k));
      const field = m ? antet?.fields.find((f) => f.key === m.key) : undefined;
      const pair = !field ? antet?.pairs.find((p) => foldKey(p.label) === k) : undefined;
      if (field) {
        value = field.value;
        explanation = t("docintel:suggest.fromAntetText", { label: field.label, text: field.value, field: def.name });
        confidence = field.confidence;
      } else if (pair) {
        value = pair.value;
        explanation = t("docintel:suggest.fromAntetText", { label: pair.label, text: pair.value, field: def.name });
        confidence = 0.6;
      }
    }
    if (!value) continue;
    if (def.type === "date") value = parseDate(value) ?? value;
    if (def.type === "list") {
      const opt = (def.options ?? []).find((o) => fold(o) === fold(value!));
      if (!opt) continue;
      value = opt;
    }
    if (checkAttributeValue(def, value)) continue;
    out.push({ name: def.name, value, confidence: round2(confidence), explanation, freeForm: false });
  }
  // The revision is worth keeping even without a definition (it is not part of the name).
  if (rev?.value && !input.attributeDefs.some((d) => isRevisionAttribute(d.name))) {
    const c = rev.candidates.find((x) => x.source === rev.source);
    out.push({
      name: "Revizyon",
      value: rev.value,
      confidence: rev.confidence,
      explanation: t("docintel:suggest.freeForm", { text: revisionExplanation(t, rev.source, c?.raw ?? rev.value, "Revizyon", rev.value) }),
      freeForm: true,
    });
  }
  return out;
}

function revisionExplanation(t: T, s: RevisionInfo["source"], raw: string, name: string, value: string): string {
  const p = { raw, name, value };
  if (s === "antet") return t("docintel:suggest.revisionFromAntet", p);
  if (s === "table") return t("docintel:suggest.revisionFromTable", p);
  if (s === "filename") return t("docintel:suggest.revisionFromFileName", p);
  return t("docintel:suggest.revisionFromAttribute", p);
}

// ---------------------------------------------------------------------------
// Language model: resolves ambiguous fields only
// ---------------------------------------------------------------------------

export type ChatProvider = Pick<AiProvider, "chat">;

const MAX_ALLOWED = 30;

/**
 * Asks the model about ambiguous or missing fields (compact JSON in, JSON out). Every value must be
 * an allowed one and the resulting name must validate; otherwise the answer is dropped.
 */
export async function refineWithAi(
  provider: ChatProvider,
  input: SuggestInput,
  base: NamingSuggestionDto,
  opts: { timeoutMs?: number } = {},
): Promise<NamingSuggestionDto> {
  const standard = input.standard;
  if (!standard) return base;
  const t = translator(input);
  const open = base.fields.filter((f) => f.ambiguous || !f.value);
  if (!open.length) return { ...base, ai: { used: false, accepted: false, note: t("docintel:ai.noAmbiguousFields") } };
  const defs = new Map(nameFields(standard).map((f) => [f.name, f]));
  const asked = open
    .map((f) => {
      const def = defs.get(f.field)!;
      if (def.type === "list") {
        const preferred = new Set(f.alternatives.concat(f.value ? [f.value] : []));
        const vals = [...def.values].sort((a, b) => Number(preferred.has(b.code)) - Number(preferred.has(a.code))).slice(0, MAX_ALLOWED);
        return { ad: def.name, tip: "liste", izinli: vals.map((v) => (v.description ? `${v.code}=${v.description}` : v.code)), adaylar: f.alternatives };
      }
      if (def.type === "number") return { ad: def.name, tip: `${def.digits} haneli sayı`, adaylar: f.alternatives }; // i18n-ok: sent to the language model
      return { ad: def.name, tip: "metin", adaylar: f.alternatives };
    })
    .slice(0, 8);
  const antet: Record<string, string> = {};
  for (const p of input.antet?.pairs ?? []) if (Object.keys(antet).length < 15) antet[p.label] = p.value.slice(0, 80);
  const payload = { dosya: input.fileName, klasor: input.folderNames.slice(-3).join(" / "), antet, alanlar: asked };
  const messages = [
    {
      role: "system" as const,
      content:
        "Bir doküman yönetim sisteminde dosya adı alanlarını eşleştiriyorsun. Her alan için yalnız 'izinli' listesindeki kodlardan birini (liste alanı) ya da istenen biçimde değeri seç; emin değilsen null yaz. Yalnız JSON nesnesi döndür: {\"<alan adı>\": \"<kod>\" | null}.", // i18n-ok: prompt for the language model
    },
    { role: "user" as const, content: JSON.stringify(payload) },
  ];
  let answer: Record<string, unknown>;
  try {
    const res = await provider.chat(messages, { maxTokens: 300, timeoutMs: opts.timeoutMs ?? 180_000 });
    answer = extractJson(res.text) as Record<string, unknown>;
  } catch (e) {
    return { ...base, ai: { used: true, accepted: false, note: t("docintel:ai.unreadable", { error: pdfErrorText(e, input.lang) }) } };
  }
  const updates = new Map<string, string>();
  for (const q of asked) {
    const raw = answer[q.ad];
    if (raw === null || raw === undefined || raw === "") continue;
    const def = defs.get(q.ad)!;
    const v = String(raw).trim().split("=")[0]!.trim();
    let ok: string | null = null;
    if (def.type === "list") ok = def.values.find((x) => x.code === v || fold(x.code) === fold(v))?.code ?? null;
    else if (def.type === "number") ok = fitNumber(def, v);
    else ok = cleanText(def, v);
    if (!ok) return { ...base, ai: { used: true, accepted: false, note: t("docintel:ai.notAllowed", { field: q.ad, value: v }) } };
    updates.set(q.ad, ok);
  }
  if (!updates.size) return { ...base, ai: { used: true, accepted: false, note: t("docintel:ai.noChoice") } };
  const fields = base.fields.map((f) =>
    updates.has(f.field)
      ? {
          ...f,
          value: updates.get(f.field)!,
          confidence: 0.7,
          ambiguous: false,
          source: "ai" as const,
          explanation: f.alternatives.length
            ? t("docintel:ai.chosenWithCandidates", { field: f.field, value: updates.get(f.field), candidates: f.alternatives.join(", ") })
            : t("docintel:ai.chosen", { field: f.field, value: updates.get(f.field) }),
        }
      : f,
  );
  const ext = extensionOf(input.fileName);
  const next = finish(standard, input.fileName, ext, fields, base.attributes, t, input.lang ?? DEFAULT_LANGUAGE);
  if (!next.ok) {
    // Never accept a name the validator rejects; keep the deterministic suggestion.
    return { ...base, ai: { used: true, accepted: false, note: t("docintel:ai.nameInvalid", { errors: next.errors.join("; ") }) } };
  }
  return { ...next, ai: { used: true, accepted: true } };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
