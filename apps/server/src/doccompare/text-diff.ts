/**
 * Text side of a document comparison (pure functions):
 *   - PDF text layer → units (text cells with their page and box), via the docintel line builder;
 *   - one diff over the whole document (so reflowed text is not reported page by page), then the
 *     changes are grouped by page; removed/added lines that look alike become "changed" lines
 *     with a word diff;
 *   - title-block (antet) field changes and revision checks (flags);
 *   - the deterministic summary shown when the language model is off.
 */
import {
  ANTET_FIELD_LABELS_TR,
  boxInside,
  compareRevisions,
  diffSequence,
  lineSimilarity,
  wordDiff,
  type AntetChange,
  type AntetResult,
  type DocCompareFlag,
  type DocCompareResult,
  type NBox,
  type PageRegions,
  type PageTextDiff,
  type RowChange,
  type SheetDiff,
  type SummaryBullet,
  type TextChange,
} from "@sitekeep/shared";
import { DEFAULT_LANGUAGE, SERVER_LANGUAGES, labelFor, tFor } from "../i18n/index.js";
import type { WorkerOutput } from "../docintel/pdf-worker.js";
import { buildLines } from "../docintel/text.js";

/** One comparable piece of text: a title-block cell, a line of running text, a paragraph. */
export interface TextUnit {
  text: string;
  page: number;
  box?: NBox;
}

/** Pages with fewer text items than this count as having no text layer. */
const MIN_TEXT_ITEMS = 3;
/** Changes kept per page / overall (the rest are counted). */
const PAGE_CAP = 300;
const TOTAL_CAP = 3000;
/** Removed × added lines of one hunk above this are not paired into "changed" lines. */
const PAIR_LIMIT = 40_000;
const PAIR_MIN_SIMILARITY = 0.5;

const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** Text units of a PDF (cells per line, top to bottom, left to right). */
export function pdfUnits(out: WorkerOutput): { units: TextUnit[]; hasText: boolean } {
  const units: TextUnit[] = [];
  let withText = 0;
  for (const page of out.pages) {
    if (page.items.length >= MIN_TEXT_ITEMS) withText++;
    const w = page.width || 1;
    const h = page.height || 1;
    for (const line of buildLines(page)) {
      for (const s of line.segments) {
        const text = s.text.replace(/\s+/g, " ").trim();
        if (!text) continue;
        units.push({
          text,
          page: page.n,
          box: {
            x0: r4(Math.max(0, s.x0 / w)),
            y0: r4(Math.max(0, (s.y - s.h * 0.9) / h)),
            x1: r4(Math.min(1, s.x1 / w)),
            y1: r4(Math.min(1, (s.y + s.h * 0.25) / h)),
          },
        });
      }
    }
  }
  return { units, hasText: withText > 0 };
}

/** Key used to match units: whitespace collapsed (case and punctuation kept, they matter in drawings). */
export function unitKey(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Diff of two unit lists. Consecutive removed/added units (a hunk) are paired by similarity into
 * "changed" units with a word diff; pairs keep their order.
 */
export function diffUnits(a: readonly TextUnit[], b: readonly TextUnit[]): TextChange[] {
  const ops = diffSequence(
    a.map((u) => unitKey(u.text)),
    b.map((u) => unitKey(u.text)),
  );
  const out: TextChange[] = [];
  let rem: TextUnit[] = [];
  let add: TextUnit[] = [];
  const flush = () => {
    if (rem.length || add.length) out.push(...pairHunk(rem, add));
    rem = [];
    add = [];
  };
  for (const op of ops) {
    if (op.op === 0) flush();
    else if (op.op === -1) rem.push(a[op.a!]!);
    else add.push(b[op.b!]!);
  }
  flush();
  return out;
}

function removed(u: TextUnit): TextChange {
  return { kind: "removed", old: u.text, pageA: u.page, ...(u.box && { boxA: u.box }) };
}
function added(u: TextUnit): TextChange {
  return { kind: "added", new: u.text, pageB: u.page, ...(u.box && { boxB: u.box }) };
}

function pairHunk(rem: TextUnit[], add: TextUnit[]): TextChange[] {
  if (!rem.length) return add.map(added);
  if (!add.length) return rem.map(removed);
  if (rem.length * add.length > PAIR_LIMIT) return [...rem.map(removed), ...add.map(added)];
  const out: TextChange[] = [];
  let next = 0; // first added unit not used yet
  for (const r of rem) {
    let best = -1;
    let bestSim = PAIR_MIN_SIMILARITY;
    for (let j = next; j < add.length; j++) {
      const s = lineSimilarity(r.text, add[j]!.text);
      if (s > bestSim || (best < 0 && s >= PAIR_MIN_SIMILARITY)) {
        best = j;
        bestSim = s;
      }
    }
    if (best < 0) {
      out.push(removed(r));
      continue;
    }
    for (let j = next; j < best; j++) out.push(added(add[j]!));
    const x = add[best]!;
    out.push({
      kind: "changed",
      old: r.text,
      new: x.text,
      words: wordDiff(r.text, x.text),
      pageA: r.page,
      pageB: x.page,
      ...(r.box && { boxA: r.box }),
      ...(x.box && { boxB: x.box }),
    });
    next = best + 1;
  }
  for (let j = next; j < add.length; j++) out.push(added(add[j]!));
  return out;
}

/** Changes grouped by page (B's page, else A's), with per-page counts and caps. */
export function groupByPage(changes: readonly TextChange[]): PageTextDiff[] {
  const pages = new Map<number, PageTextDiff>();
  let kept = 0;
  for (const c of changes) {
    const n = c.pageB ?? c.pageA ?? 1;
    let p = pages.get(n);
    if (!p) pages.set(n, (p = { page: n, added: 0, removed: 0, changed: 0, changes: [] }));
    p[c.kind]++;
    if (p.changes.length < PAGE_CAP && kept < TOTAL_CAP) {
      p.changes.push(c);
      kept++;
    } else p.more = (p.more ?? 0) + 1;
  }
  return [...pages.values()].sort((x, y) => x.page - y.page);
}

/** Marks changes on the first page inside the title block. */
export function markAntet(pages: PageTextDiff[], regionA: NBox | null, regionB: NBox | null): void {
  for (const p of pages)
    for (const c of p.changes) {
      const inA = !c.boxA || (c.pageA === 1 && !!regionA && boxInside(c.boxA, regionA, 0.02));
      const inB = !c.boxB || (c.pageB === 1 && !!regionB && boxInside(c.boxB, regionB, 0.02));
      if ((c.boxA || c.boxB) && inA && inB) c.antet = true;
    }
}

export function totals(pages: readonly PageTextDiff[]): DocCompareResult["totals"] {
  return {
    added: pages.reduce((s, p) => s + p.added, 0),
    removed: pages.reduce((s, p) => s + p.removed, 0),
    changed: pages.reduce((s, p) => s + p.changed, 0),
    pages: pages.length,
  };
}

// ---- Title block ----------------------------------------------------------------------------

/** Title-block field changes (known fields by key, other label/value pairs by label). */
export function antetChanges(a: AntetResult | null, b: AntetResult | null, lang: string = DEFAULT_LANGUAGE): AntetChange[] {
  const out: AntetChange[] = [];
  const norm = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();
  const fa = new Map((a?.fields ?? []).map((f) => [f.key, f]));
  const fb = new Map((b?.fields ?? []).map((f) => [f.key, f]));
  for (const key of new Set([...fa.keys(), ...fb.keys()])) {
    const x = fa.get(key);
    const y = fb.get(key);
    if (norm(x?.value) === norm(y?.value)) continue;
    out.push({ key, label: (key in ANTET_FIELD_LABELS_TR ? labelFor(lang, "antetField", key) : null) ?? y?.label ?? x?.label ?? key, old: x?.value ?? null, new: y?.value ?? null });
  }
  // Pairs without a known key ("Alan", "Pafta Sayısı").
  const pairs = (r: AntetResult | null) => new Map((r?.pairs ?? []).filter((p) => !p.key).map((p) => [norm(p.label).toLowerCase(), p]));
  const pa = pairs(a);
  const pb = pairs(b);
  for (const label of new Set([...pa.keys(), ...pb.keys()])) {
    const x = pa.get(label);
    const y = pb.get(label);
    if (norm(x?.value) === norm(y?.value)) continue;
    out.push({ key: null, label: y?.label ?? x?.label ?? label, old: x?.value ?? null, new: y?.value ?? null });
  }
  const table = (r: AntetResult | null) => latestRevisionRow(r);
  const ta = table(a);
  const tb = table(b);
  if (ta !== tb && (ta || tb)) out.push({ key: null, label: tFor(lang)("doccompare:antet.revisionTableRow"), old: ta, new: tb });
  return out;
}

/**
 * A stored result for a reader: the revision-table row label (written in the language of the
 * comparison run) in the reader's language.
 */
export function localizeAntetChanges(changes: AntetChange[], lang: string): AntetChange[] {
  const known = new Set(SERVER_LANGUAGES.map((l) => tFor(l.code)("doccompare:antet.revisionTableRow")));
  const label = tFor(lang)("doccompare:antet.revisionTableRow");
  return changes.map((c) => (c.key === null && known.has(c.label) ? { ...c, label } : c));
}

export function latestRevisionRow(r: AntetResult | null): string | null {
  const row = r?.revisionTable[r.revisionTable.length - 1];
  return row ? [row.rev, row.date, row.description].filter(Boolean).join(" · ") : null;
}

/** Title-block region of the first page, normalised. */
export function antetRegion(r: AntetResult | null): NBox | null {
  if (!r?.region || !r.pageSize.width || !r.pageSize.height) return null;
  const { width: w, height: h } = r.pageSize;
  return { x0: r4(r.region.x0 / w), y0: r4(r.region.y0 / h), x1: r4(r.region.x1 / w), y1: r4(r.region.y1 / h) };
}

// ---- Flags and deterministic summary ---------------------------------------------------------

/** Visual change regions outside the title block (null when the regions are not known yet). */
export function regionsOutsideAntet(result: DocCompareResult, regions: PageRegions[] | null): number | null {
  if (!regions) return null;
  let n = 0;
  for (const p of regions)
    for (const r of p.regions) if (!(p.page === 1 && result.antetRegion && boxInside(r.box, result.antetRegion, 0.02))) n++;
  return n;
}

export function compareFlags(result: DocCompareResult, regions: PageRegions[] | null, lang: string = DEFAULT_LANGUAGE): DocCompareFlag[] {
  const t = tFor(lang);
  const flags: DocCompareFlag[] = [];
  if (result.identical) {
    flags.push({ code: "identical", severity: "info", message: t("doccompare:flags.identical") });
    return flags;
  }
  if (result.kind === "pdf" && !result.hasText)
    flags.push({ code: "no_text", severity: "info", message: t("doccompare:flags.noText") });
  if (result.pageCountA !== result.pageCountB)
    flags.push({
      code: "page_count_changed",
      severity: "info",
      message: t("doccompare:flags.pageCountChanged", { from: result.pageCountA, to: result.pageCountB }),
    });
  if (result.kind !== "pdf") return flags;
  const outside = regionsOutsideAntet(result, regions);
  const visualChange = outside !== null && outside > 0;
  const contentChanged = result.contentChanged || visualChange;
  const ra = result.revisionA;
  const rb = result.revisionB;
  if (!ra && !rb) {
    if (result.hasText)
      flags.push({ code: "revision_unknown", severity: "info", message: t("doccompare:flags.revisionUnknown") });
    return flags;
  }
  const same = !!ra && !!rb && (ra === rb || compareRevisions(ra, rb) === 0);
  if (same && contentChanged)
    flags.push({
      code: "revision_not_updated",
      severity: "warn",
      message: t("doccompare:flags.revisionNotUpdated", { revision: rb }),
    });
  if (ra && rb && !same) {
    const cmp = compareRevisions(rb, ra);
    if (cmp !== null && cmp < 0)
      flags.push({ code: "revision_backwards", severity: "warn", message: t("doccompare:flags.revisionBackwards", { from: ra, to: rb }) });
    const contentKnown = !result.hasText ? outside !== null : true;
    if (contentKnown && !contentChanged && (outside === null || outside === 0))
      flags.push({
        code: "revision_without_change",
        severity: "warn",
        message: t("doccompare:flags.revisionWithoutChange", { from: ra, to: rb }),
      });
    const tb = result.revisionTableB;
    if (result.revisionTableA !== null || tb !== null) {
      const hasRow = tb !== null && tb.split(" · ")[0] === rb;
      if (!hasRow || tb === result.revisionTableA)
        flags.push({
          code: "revision_table_not_updated",
          severity: "warn",
          message: tb
            ? t("doccompare:flags.revisionTableNotUpdated", { revision: rb, row: tb })
            : t("doccompare:flags.revisionTableEmpty", { revision: rb }),
        });
    }
  }
  return flags;
}

const quote = (s: string | undefined, n = 70) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return `"${t.length > n ? `${t.slice(0, n - 1)}…` : t}"`;
};

type T = ReturnType<typeof tFor>;

/** One-line description of a text change. */
export function changeText(c: TextChange, t: T = tFor(DEFAULT_LANGUAGE)): string {
  if (c.kind === "changed") return `${quote(c.old)} → ${quote(c.new)}`;
  if (c.kind === "added") return t("doccompare:changes.added", { text: quote(c.new) });
  return t("doccompare:changes.removed", { text: quote(c.old) });
}

function rowText(r: RowChange, t: T): string {
  if (r.kind === "changed")
    return t("doccompare:changes.rowChanged", {
      row: r.rowB,
      cells: (r.cells ?? [])
        .slice(0, 3)
        .map((c) => `${c.col} ${quote(c.old, 30)} → ${quote(c.new, 30)}`)
        .join(", "),
    });
  return r.kind === "added"
    ? t("doccompare:changes.rowAdded", { row: r.rowB, text: quote(r.text, 50) })
    : t("doccompare:changes.rowRemoved", { row: r.rowA, text: quote(r.text, 50) });
}

/** Summary without a language model: title block, flags, busiest pages / sheets. */
export function deterministicSummary(
  result: DocCompareResult,
  regions: PageRegions[] | null,
  flags: DocCompareFlag[],
  lang: string = DEFAULT_LANGUAGE,
): SummaryBullet[] {
  const t = tFor(lang);
  const out: SummaryBullet[] = [];
  for (const f of flags) if (f.severity === "warn" || f.code === "identical" || f.code === "page_count_changed") out.push({ text: f.message, severity: f.severity });
  if (result.identical) return out;
  const ant = result.antet.filter((c) => c.key === "revision" || c.key === "date" || c.key === "drawingNo" || c.key === "sheetNo" || c.key === "title" || c.key === "scale");
  if (ant.length)
    out.push({
      text: t("doccompare:summary.antet", { changes: ant.map((c) => `${c.label} ${c.old ?? "—"} → ${c.new ?? "—"}`).join("; ") }),
      page: 1,
    });
  if (result.sheets) {
    for (const s of result.sheets.filter((x) => x.status !== "same").slice(0, 6)) {
      if (s.status === "added" || s.status === "removed") {
        out.push({ text: t(s.status === "added" ? "doccompare:summary.sheetAdded" : "doccompare:summary.sheetRemoved", { name: s.name }) });
        continue;
      }
      const ex = s.rows.slice(0, 2).map((r) => rowText(r, t)).join("; ");
      const c = counts(t, s.added, s.removed, s.changed, "row");
      out.push({ text: ex ? t("doccompare:summary.sheetChangedExamples", { name: s.name, counts: c, examples: ex }) : t("doccompare:summary.sheetChanged", { name: s.name, counts: c }) });
    }
  }
  const regionCount = new Map((regions ?? []).map((p) => [p.page, p.regions.length]));
  const pages = new Set<number>([...result.pages.map((p) => p.page), ...regionCount.keys()]);
  const ranked = [...pages]
    .map((n) => {
      const p = result.pages.find((x) => x.page === n);
      const content = p ? p.changes.filter((c) => !c.antet) : [];
      return { n, p, content, regions: regionCount.get(n) ?? 0, weight: (p ? p.added + p.removed + p.changed : 0) + (regionCount.get(n) ?? 0) };
    })
    .filter((x) => x.weight > 0)
    .sort((x, y) => y.weight - x.weight)
    .slice(0, 6)
    .sort((x, y) => x.n - y.n);
  if (result.kind === "pdf" || result.kind === "docx" || result.kind === "text") {
    for (const x of ranked) {
      const parts: string[] = [];
      if (x.p) parts.push(counts(t, x.p.added, x.p.removed, x.p.changed, result.kind === "pdf" ? "text" : "paragraph"));
      if (x.regions) parts.push(t("doccompare:summary.visualRegions", { count: x.regions }));
      const ex = x.content.slice(0, 2).map((c) => changeText(c, t)).join("; ");
      const p = { page: x.n, parts: parts.join(", "), examples: ex };
      const text =
        result.kind === "pdf"
          ? t(ex ? "doccompare:summary.pageExamples" : "doccompare:summary.page", p)
          : t(ex ? "doccompare:summary.textExamples" : "doccompare:summary.text", p);
      out.push({ text, page: result.kind === "pdf" ? x.n : undefined, region: x.regions ? 0 : undefined });
    }
  }
  if (out.length === 0) {
    const pending = result.kind === "pdf" && !regions;
    out.push({ text: t(pending ? "doccompare:summary.noTextDiffVisualPending" : "doccompare:summary.noDiff") });
  }
  return out;
}

/** "2 değişen, 1 eklenen satır" / "satır farkı yok". */
function counts(t: T, added: number, removed: number, changed: number, unit: "row" | "text" | "paragraph"): string {
  const parts: string[] = [];
  if (changed) parts.push(t("doccompare:counts.changed", { count: changed }));
  if (added) parts.push(t("doccompare:counts.added", { count: added }));
  if (removed) parts.push(t("doccompare:counts.removed", { count: removed }));
  if (!parts.length) return t(unit === "row" ? "doccompare:counts.noDiff.row" : unit === "text" ? "doccompare:counts.noDiff.text" : "doccompare:counts.noDiff.paragraph");
  const list = parts.join(", ");
  return t(unit === "row" ? "doccompare:counts.of.row" : unit === "text" ? "doccompare:counts.of.text" : "doccompare:counts.of.paragraph", { parts: list });
}

// ---- Spreadsheets ---------------------------------------------------------------------------

function colName(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const trimRow = (r: string[]) => {
  const out = r.map((c) => (c ?? "").trim());
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
};

/** Row diff of one sheet; similar rows become cell changes. */
export function diffSheet(name: string, a: string[][] | null, b: string[][] | null): SheetDiff {
  if (!a || !b) {
    const rows = (a ?? b ?? []).map(trimRow);
    const kind = a ? "removed" : "added";
    const nonEmpty = rows.map((r, i) => ({ r, i })).filter((x) => x.r.length);
    return {
      name,
      status: kind,
      added: kind === "added" ? nonEmpty.length : 0,
      removed: kind === "removed" ? nonEmpty.length : 0,
      changed: 0,
      rows: nonEmpty.slice(0, 20).map((x) => ({ kind, ...(kind === "added" ? { rowB: x.i + 1 } : { rowA: x.i + 1 }), text: x.r.join(" | ") })),
      ...(nonEmpty.length > 20 && { more: nonEmpty.length - 20 }),
    };
  }
  const ra = a.map(trimRow);
  const rb = b.map(trimRow);
  const ops = diffSequence(
    ra.map((r) => r.join("\t")),
    rb.map((r) => r.join("\t")),
  );
  const rows: RowChange[] = [];
  let rem: number[] = [];
  let add: number[] = [];
  const flush = () => {
    let next = 0;
    for (const i of rem) {
      let best = -1;
      let bestScore = 0.5;
      for (let j = next; j < add.length && rem.length * add.length <= PAIR_LIMIT; j++) {
        const x = ra[i]!;
        const y = rb[add[j]!]!;
        const len = Math.max(x.length, y.length) || 1;
        let same = 0;
        for (let k = 0; k < len; k++) if ((x[k] ?? "") === (y[k] ?? "")) same++;
        const score = same / len;
        if (score >= bestScore && (best < 0 || score > bestScore)) {
          best = j;
          bestScore = score;
        }
      }
      if (best < 0) {
        if (ra[i]!.length) rows.push({ kind: "removed", rowA: i + 1, text: ra[i]!.join(" | ") });
        continue;
      }
      for (let j = next; j < best; j++) if (rb[add[j]!]!.length) rows.push({ kind: "added", rowB: add[j]! + 1, text: rb[add[j]!]!.join(" | ") });
      const x = ra[i]!;
      const y = rb[add[best]!]!;
      const cells = [];
      for (let k = 0; k < Math.max(x.length, y.length); k++)
        if ((x[k] ?? "") !== (y[k] ?? "")) cells.push({ col: colName(k), old: x[k] ?? "", new: y[k] ?? "" });
      rows.push({ kind: "changed", rowA: i + 1, rowB: add[best]! + 1, cells });
      next = best + 1;
    }
    for (let j = next; j < add.length; j++) if (rb[add[j]!]!.length) rows.push({ kind: "added", rowB: add[j]! + 1, text: rb[add[j]!]!.join(" | ") });
    rem = [];
    add = [];
  };
  for (const op of ops) {
    if (op.op === 0) flush();
    else if (op.op === -1) rem.push(op.a!);
    else add.push(op.b!);
  }
  flush();
  const count = (k: RowChange["kind"]) => rows.filter((r) => r.kind === k).length;
  const kept = rows.slice(0, PAGE_CAP);
  return {
    name,
    status: rows.length ? "changed" : "same",
    added: count("added"),
    removed: count("removed"),
    changed: count("changed"),
    rows: kept,
    ...(rows.length > kept.length && { more: rows.length - kept.length }),
  };
}

/** Sheet diffs matched by name (order of B, then sheets only in A). */
export function diffWorkbooks(a: { name: string; rows: string[][] }[], b: { name: string; rows: string[][] }[]): SheetDiff[] {
  const byName = new Map(a.map((s) => [s.name, s]));
  const out: SheetDiff[] = [];
  // A single sheet on both sides is compared even when it was renamed.
  if (a.length === 1 && b.length === 1) return [diffSheet(b[0]!.name, a[0]!.rows, b[0]!.rows)];
  for (const s of b) out.push(diffSheet(s.name, byName.get(s.name)?.rows ?? null, s.rows));
  for (const s of a) if (!b.some((x) => x.name === s.name)) out.push(diffSheet(s.name, s.rows, null));
  return out;
}
