/**
 * Document revision comparison ("Revizyon karşılaştır"): DTOs plus the pure helpers the server
 * (text diff) and the web app (pixel diff, change regions) share.
 *
 * Coordinates of regions and text boxes are normalised to the page (0–1, origin top-left, y down),
 * so they do not depend on the render scale.
 */
import type { AntetFieldKey } from "./docintel.js";

export type DocCompareKind = "pdf" | "xlsx" | "csv" | "docx" | "text";
export type DocCompareStatus = "running" | "done" | "failed";
export type DocAiStatus = "none" | "running" | "done" | "failed";

/** Box on a page, normalised (0–1, origin top-left). */
export interface NBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Word-level diff of a changed line: [op, text]; op −1 removed, 0 same, 1 added. */
export type WordOp = [-1 | 0 | 1, string];

export interface TextChange {
  kind: "added" | "removed" | "changed";
  old?: string;
  new?: string;
  words?: WordOp[];
  /** Page in the old (A) and new (B) document. */
  pageA?: number;
  pageB?: number;
  boxA?: NBox;
  boxB?: NBox;
  /** Inside the title block (antet) of the first page. */
  antet?: boolean;
}

export interface PageTextDiff {
  /** Page in B (or in A when the text exists only there). */
  page: number;
  added: number;
  removed: number;
  changed: number;
  changes: TextChange[];
  /** Changes left out of `changes` (cap). */
  more?: number;
}

/** One cell change in a changed spreadsheet row. */
export interface CellChange {
  col: string;
  old: string;
  new: string;
}

export interface RowChange {
  kind: "added" | "removed" | "changed";
  /** 1-based row numbers. */
  rowA?: number;
  rowB?: number;
  cells?: CellChange[];
  /** Whole row (added / removed), cells joined with " | ". */
  text?: string;
}

export interface SheetDiff {
  name: string;
  status: "added" | "removed" | "changed" | "same";
  added: number;
  removed: number;
  changed: number;
  rows: RowChange[];
  more?: number;
}

export interface AntetChange {
  key: AntetFieldKey | null;
  label: string;
  old: string | null;
  new: string | null;
}

export interface DocCompareResult {
  kind: DocCompareKind;
  /** Both sides have a text layer (PDF) or text content. */
  hasText: boolean;
  /** Short note, e.g. "Metin katmanı yok, yalnızca görsel karşılaştırma." */
  note?: string;
  identical: boolean;
  pageCountA: number;
  pageCountB: number;
  /** Pages with text changes (PDF pages; DOCX / text use page 1). */
  pages: PageTextDiff[];
  /** Spreadsheets (XLSX / CSV). */
  sheets?: SheetDiff[];
  totals: { added: number; removed: number; changed: number; pages: number };
  /** Title-block (antet) field changes, first page. */
  antet: AntetChange[];
  revisionA: string | null;
  revisionB: string | null;
  /** Latest revision-table rows ("C · 15.03.2026 · …"). */
  revisionTableA: string | null;
  revisionTableB: string | null;
  /** Title-block area of B's first page (to tell title-block changes from content changes). */
  antetRegion: NBox | null;
  /** Text changes outside the title block. */
  contentChanged: boolean;
}

export type DiffRegionKind = "added" | "removed" | "changed";

export interface DiffRegion {
  box: NBox;
  kind: DiffRegionKind;
  /** Changed ink pixels at analysis scale (a size indicator). */
  pixels: number;
}

export interface PageRegions {
  page: number;
  regions: DiffRegion[];
  /** Page exists only in A ("removed") or only in B ("added"). */
  only?: "A" | "B";
}

export interface DocCompareFlag {
  code:
    | "identical"
    | "revision_not_updated"
    | "revision_without_change"
    | "revision_table_not_updated"
    | "revision_backwards"
    | "revision_unknown"
    | "page_count_changed"
    | "no_text";
  severity: "info" | "warn";
  message: string;
}

export interface SummaryBullet {
  text: string;
  page?: number;
  /** Index into the page's regions. */
  region?: number;
  severity?: "info" | "warn";
}

export interface DocCompareSideDto {
  versionId: string;
  fileId: string;
  fileName: string;
  version: number;
  revision: string | null;
}

export interface DocCompareAiDto {
  /** A language model can be used in this project. */
  available: boolean;
  /** Why not (AI off, no provider …) or other notes. */
  note: string | null;
  status: DocAiStatus;
  bullets: SummaryBullet[];
  model: string | null;
  error: string | null;
  /** "Model düşünüyor…", "Model yazıyor (340 karakter)". */
  progress: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DocCompareDto {
  id: string;
  projectId: string;
  from: DocCompareSideDto;
  to: DocCompareSideDto;
  status: DocCompareStatus;
  error: string | null;
  result: DocCompareResult | null;
  /** Change regions computed in the browser (pixel diff), null until sent. */
  regions: PageRegions[] | null;
  flags: DocCompareFlag[];
  /** Deterministic summary (always available). */
  summary: SummaryBullet[];
  ai: DocCompareAiDto;
  /** Running reviews that contain the new version. */
  activeReviews: { reviewId: string; number: number; name: string; code: string | null }[];
  canMarkup: boolean;
  createdAt: string;
  updatedAt: string;
}

/** File extensions per comparison kind. */
export const DOC_COMPARE_EXTENSIONS: Record<DocCompareKind, string[]> = {
  pdf: ["pdf"],
  xlsx: ["xlsx", "xlsm"],
  csv: ["csv", "tsv"],
  docx: ["docx"],
  text: ["txt", "md"],
};

export function docCompareKind(extension: string): DocCompareKind | null {
  const e = extension.toLowerCase();
  for (const [k, list] of Object.entries(DOC_COMPARE_EXTENSIONS)) if (list.includes(e)) return k as DocCompareKind;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Sequence diff (LCS with patience anchors; bounded memory)
// ---------------------------------------------------------------------------------------------

/** −1: only in a, 0: in both, 1: only in b. Indices point into a / b. */
export interface DiffOp {
  op: -1 | 0 | 1;
  a?: number;
  b?: number;
}

/** Largest gap solved with a full LCS table (cells). Larger gaps are split at unique lines. */
const LCS_LIMIT = 4_000_000;

/**
 * Diff of two sequences of keys. Common prefix and suffix are cut, gaps are split at lines that
 * occur once on both sides (patience diff), small gaps are solved exactly (LCS).
 */
export function diffSequence(a: readonly string[], b: readonly string[]): DiffOp[] {
  const out: DiffOp[] = [];
  const rec = (a0: number, a1: number, b0: number, b1: number) => {
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) out.push({ op: 0, a: a0++, b: b0++ });
    const tail: DiffOp[] = [];
    while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) tail.push({ op: 0, a: --a1, b: --b1 });
    if (a0 === a1) for (let j = b0; j < b1; j++) out.push({ op: 1, b: j });
    else if (b0 === b1) for (let i = a0; i < a1; i++) out.push({ op: -1, a: i });
    else if ((a1 - a0) * (b1 - b0) <= LCS_LIMIT) lcs(a0, a1, b0, b1);
    else {
      const anchors = uniqueAnchors(a0, a1, b0, b1);
      if (!anchors.length) {
        for (let i = a0; i < a1; i++) out.push({ op: -1, a: i });
        for (let j = b0; j < b1; j++) out.push({ op: 1, b: j });
      } else {
        let pa = a0;
        let pb = b0;
        for (const [ia, ib] of anchors) {
          rec(pa, ia, pb, ib);
          out.push({ op: 0, a: ia, b: ib });
          pa = ia + 1;
          pb = ib + 1;
        }
        rec(pa, a1, pb, b1);
      }
    }
    for (let k = tail.length - 1; k >= 0; k--) out.push(tail[k]!);
  };

  const lcs = (a0: number, a1: number, b0: number, b1: number) => {
    const n = a1 - a0;
    const m = b1 - b0;
    const w = m + 1;
    const t = n < 65535 && m < 65535 ? new Uint16Array((n + 1) * w) : new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        t[i * w + j] = a[a0 + i] === b[b0 + j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[a0 + i] === b[b0 + j]) out.push({ op: 0, a: a0 + i++, b: b0 + j++ });
      else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) out.push({ op: -1, a: a0 + i++ });
      else out.push({ op: 1, b: b0 + j++ });
    }
    while (i < n) out.push({ op: -1, a: a0 + i++ });
    while (j < m) out.push({ op: 1, b: b0 + j++ });
  };

  /** Lines unique on both sides, as the longest increasing run of b positions. */
  const uniqueAnchors = (a0: number, a1: number, b0: number, b1: number): [number, number][] => {
    const ca = new Map<string, number>();
    const cb = new Map<string, number>();
    for (let i = a0; i < a1; i++) ca.set(a[i]!, ca.has(a[i]!) ? -1 : i);
    for (let j = b0; j < b1; j++) cb.set(b[j]!, cb.has(b[j]!) ? -1 : j);
    const pairs: [number, number][] = [];
    for (const [k, ia] of ca) {
      const jb = cb.get(k);
      if (ia >= 0 && jb !== undefined && jb >= 0) pairs.push([ia, jb]);
    }
    pairs.sort((x, y) => x[0] - y[0]);
    // Longest increasing subsequence on b (patience sorting).
    const tails: number[] = [];
    const prev = new Array<number>(pairs.length).fill(-1);
    for (let k = 0; k < pairs.length; k++) {
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pairs[tails[mid]!]![1] < pairs[k]![1]) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) prev[k] = tails[lo - 1]!;
      tails[lo] = k;
    }
    const res: [number, number][] = [];
    for (let k = tails.length ? tails[tails.length - 1]! : -1; k >= 0; k = prev[k]!) res.push(pairs[k]!);
    return res.reverse();
  };

  rec(0, a.length, 0, b.length);
  return out;
}

/** Splits text into words and the spaces between them (spaces kept, so joining restores the text). */
export function wordTokens(s: string): string[] {
  return s.split(/(\s+)/).filter((t) => t !== "");
}

/** Word-level diff of two lines, consecutive tokens with the same op merged. */
export function wordDiff(oldText: string, newText: string): WordOp[] {
  const a = wordTokens(oldText);
  const b = wordTokens(newText);
  const ops: WordOp[] = [];
  for (const d of diffSequence(a, b)) {
    const text = d.op === 1 ? b[d.b!]! : a[d.a!]!;
    const last = ops[ops.length - 1];
    if (last && last[0] === d.op) last[1] += text;
    else ops.push([d.op, text]);
  }
  return ops;
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.toLowerCase().replace(/\s+/g, " ");
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function dice(a: Map<string, number>, b: Map<string, number>): number {
  let na = 0;
  let nb = 0;
  let common = 0;
  for (const v of a.values()) na += v;
  for (const [k, v] of b) {
    nb += v;
    common += Math.min(v, a.get(k) ?? 0);
  }
  return na + nb ? (2 * common) / (na + nb) : 0;
}

/** 0–1 similarity of two lines: word overlap, or character pairs for short lines. */
export function lineSimilarity(x: string, y: string): number {
  const words = (s: string) => {
    const m = new Map<string, number>();
    for (const w of s.toLowerCase().split(/[\s,;:()]+/).filter(Boolean)) m.set(w, (m.get(w) ?? 0) + 1);
    return m;
  };
  const w = dice(words(x), words(y));
  if (x.length > 60 && y.length > 60) return w;
  return Math.max(w, dice(bigrams(x), bigrams(y)));
}

// ---------------------------------------------------------------------------------------------
// Pixel diff (browser worker) and change regions
// ---------------------------------------------------------------------------------------------

/** Mask bits: removed ink (only in A) and added ink (only in B). */
export const MASK_REMOVED = 1;
export const MASK_ADDED = 2;

/** Ink (dark pixel) mask of RGBA data: 1 where the luminance is below `threshold`. */
export function inkMask(rgba: Uint8ClampedArray | Uint8Array, threshold = 200): Uint8Array {
  const n = rgba.length >> 2;
  const out = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = rgba[p + 3]! / 255;
    // Transparent pixels are paper (white).
    const lum = 255 - a * (255 - (0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!));
    out[i] = lum < threshold ? 1 : 0;
  }
  return out;
}

/** Binary dilation with a square of radius r (separable running max). */
export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    for (let x = 0; x < Math.min(r, w); x++) count += mask[row + x]!;
    for (let x = 0; x < w; x++) {
      if (x + r < w) count += mask[row + x + r]!;
      if (x - r - 1 >= 0) count -= mask[row + x - r - 1]!;
      tmp[row + x] = count > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(r, h); y++) count += tmp[y * w + x]!;
    for (let y = 0; y < h; y++) {
      if (y + r < h) count += tmp[(y + r) * w + x]!;
      if (y - r - 1 >= 0) count -= tmp[(y - r - 1) * w + x]!;
      out[y * w + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

/**
 * Change mask of two ink masks of the same size. A pixel is "removed" when A has ink there and
 * B has none within `tolerance` pixels (and the other way round for "added"), so anti-aliasing
 * and sub-pixel shifts are not reported.
 */
export function diffMask(inkA: Uint8Array, inkB: Uint8Array, w: number, h: number, tolerance = 1): Uint8Array {
  const nearA = dilate(inkA, w, h, tolerance);
  const nearB = dilate(inkB, w, h, tolerance);
  const out = new Uint8Array(inkA.length);
  for (let i = 0; i < out.length; i++) out[i] = (inkA[i] && !nearB[i] ? MASK_REMOVED : 0) | (inkB[i] && !nearA[i] ? MASK_ADDED : 0);
  return out;
}

export interface PixelRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  removed: number;
  added: number;
  kind: DiffRegionKind;
}

export interface ClusterOptions {
  /** Grid cell size in pixels. */
  cell?: number;
  /** Cells with fewer changed pixels are ignored (noise). */
  minCellPixels?: number;
  /** Changed cells this many cells apart belong to the same region. */
  gap?: number;
  /** Regions with fewer changed pixels are dropped. */
  minPixels?: number;
  /** At most this many regions (largest first). */
  maxRegions?: number;
}

/**
 * Groups the pixels of a change mask into regions: the mask is counted on a coarse grid, cells
 * closer than `gap` are joined (flood fill), overlapping boxes are merged. Pure, so it runs in a
 * Web Worker and in tests.
 */
export function clusterRegions(mask: Uint8Array, w: number, h: number, opts: ClusterOptions = {}): PixelRegion[] {
  const cell = opts.cell ?? 8;
  const minCell = opts.minCellPixels ?? 2;
  const gap = opts.gap ?? 2;
  const minPixels = opts.minPixels ?? 6;
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  const rem = new Uint32Array(gw * gh);
  const add = new Uint32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const gy = ((y / cell) | 0) * gw;
    for (let x = 0; x < w; x++) {
      const v = mask[y * w + x]!;
      if (!v) continue;
      const g = gy + ((x / cell) | 0);
      if (v & MASK_REMOVED) rem[g]!++;
      if (v & MASK_ADDED) add[g]!++;
    }
  }
  const active = new Uint8Array(gw * gh);
  for (let g = 0; g < active.length; g++) active[g] = rem[g]! + add[g]! >= minCell ? 1 : 0;
  const label = new Int32Array(gw * gh).fill(-1);
  let regions: PixelRegion[] = [];
  const stack: number[] = [];
  for (let g0 = 0; g0 < active.length; g0++) {
    if (!active[g0] || label[g0]! >= 0) continue;
    const id = regions.length;
    const r = { gx0: Infinity, gy0: Infinity, gx1: -1, gy1: -1, removed: 0, added: 0 };
    label[g0] = id;
    stack.push(g0);
    while (stack.length) {
      const g = stack.pop()!;
      const gx = g % gw;
      const gy = (g / gw) | 0;
      r.gx0 = Math.min(r.gx0, gx);
      r.gy0 = Math.min(r.gy0, gy);
      r.gx1 = Math.max(r.gx1, gx);
      r.gy1 = Math.max(r.gy1, gy);
      r.removed += rem[g]!;
      r.added += add[g]!;
      for (let ny = Math.max(0, gy - gap); ny <= Math.min(gh - 1, gy + gap); ny++)
        for (let nx = Math.max(0, gx - gap); nx <= Math.min(gw - 1, gx + gap); nx++) {
          const n = ny * gw + nx;
          if (active[n] && label[n]! < 0) {
            label[n] = id;
            stack.push(n);
          }
        }
    }
    regions.push({
      x0: r.gx0 * cell,
      y0: r.gy0 * cell,
      x1: Math.min(w, (r.gx1 + 1) * cell),
      y1: Math.min(h, (r.gy1 + 1) * cell),
      removed: r.removed,
      added: r.added,
      kind: "changed",
    });
  }
  regions = mergeOverlapping(regions);
  return regions
    .filter((r) => r.removed + r.added >= minPixels)
    .map((r) => ({ ...r, kind: regionKind(r.removed, r.added) }))
    .sort((x, y) => y.removed + y.added - (x.removed + x.added))
    .slice(0, opts.maxRegions ?? 150);
}

function regionKind(removed: number, added: number): DiffRegionKind {
  const total = removed + added;
  if (removed <= total * 0.1) return "added";
  if (added <= total * 0.1) return "removed";
  return "changed";
}

function mergeOverlapping(list: PixelRegion[]): PixelRegion[] {
  let merged = true;
  let out = list;
  while (merged) {
    merged = false;
    const next: PixelRegion[] = [];
    for (const r of out) {
      const hit = next.find((q) => q.x0 < r.x1 && r.x0 < q.x1 && q.y0 < r.y1 && r.y0 < q.y1);
      if (hit) {
        hit.x0 = Math.min(hit.x0, r.x0);
        hit.y0 = Math.min(hit.y0, r.y0);
        hit.x1 = Math.max(hit.x1, r.x1);
        hit.y1 = Math.max(hit.y1, r.y1);
        hit.removed += r.removed;
        hit.added += r.added;
        merged = true;
      } else next.push({ ...r });
    }
    out = next;
  }
  return out;
}

/** Pixel regions → normalised regions (page size w × h pixels). */
export function normaliseRegions(list: PixelRegion[], w: number, h: number): DiffRegion[] {
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  return list.map((r) => ({
    box: { x0: r4(r.x0 / w), y0: r4(r.y0 / h), x1: r4(r.x1 / w), y1: r4(r.y1 / h) },
    kind: r.kind,
    pixels: r.removed + r.added,
  }));
}

/** True when box b lies (mostly) inside box a. */
export function boxInside(inner: NBox, outer: NBox, pad = 0.01): boolean {
  return inner.x0 >= outer.x0 - pad && inner.y0 >= outer.y0 - pad && inner.x1 <= outer.x1 + pad && inner.y1 <= outer.y1 + pad;
}

export const DIFF_REGION_LABELS_TR: Record<DiffRegionKind, string> = {
  added: "Eklenen",
  removed: "Silinen",
  changed: "Değişen",
};
