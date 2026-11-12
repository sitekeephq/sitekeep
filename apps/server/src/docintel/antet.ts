/**
 * Title-block (antet) detection on the text layer of a drawing PDF.
 *
 * 1. Text items are grouped into lines and cell-like segments (text.ts).
 * 2. Segments that are known labels ("Çizim No", "REV.", "Ölçek", "Drawing No") are found; a value
 *    sits in the same segment ("Çizim No: S-204"), to the right, or below the label (CAD cells
 *    print a small label above a large value).
 * 3. Labels clustered in the bottom-right area of the page form the title block; values there
 *    score higher. Type checks (revision, date, scale patterns) raise or lower confidence.
 * 4. A revision table is a header line with Rev + Tarih/Açıklama columns; rows above or below
 *    it whose Rev cell parses as a revision are collected.
 */
import {
  normalizeRevision,
  parseRevision,
  type AntetField,
  type AntetFieldKey,
  type AntetPair,
  type AntetResult,
  type Box,
  type RevisionRow,
} from "@sitekeep/shared";
import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";
import type { WorkerOutput, WorkerPage } from "./pdf-worker.js";
import { buildLines, foldKey, parseDate, type Line, type Segment } from "./text.js";

/** Folded labels (see foldKey) per field. Longer labels win over their prefixes. */
const LABELS: Record<AntetFieldKey, string[]> = {
  projectNo: ["proje no", "proje numarasi", "proje kodu", "project no", "project number", "project code", "is no", "job no"],
  projectName: ["proje adi", "proje", "project", "project name", "is adi", "isin adi", "projenin adi"],
  drawingNo: ["cizim no", "cizim numarasi", "cizim kodu", "drawing no", "drawing number", "dwg no", "resim no"],
  docNo: ["dokuman no", "dokuman kodu", "dokuman numarasi", "belge no", "document no", "document number", "doc no", "dosya no", "dokuman kod no"],
  sheetNo: ["pafta no", "pafta numarasi", "pafta kodu", "sheet no", "sheet number", "sayfa no"],
  title: [
    "pafta adi",
    "cizim adi",
    "dokuman adi",
    "pafta dokuman adi",
    "pafta basligi",
    "title",
    "drawing title",
    "sheet title",
    "baslik",
    "resim adi",
  ],
  revision: ["rev", "rev no", "revizyon", "revizyon no", "revision", "rev nr"],
  date: ["tarih", "date", "cizim tarihi", "pafta tarihi"],
  scale: ["olcek", "scale"],
  drawnBy: ["cizen", "drawn", "drawn by", "hazirlayan", "tasarlayan", "designed by", "dizayn"],
  checkedBy: ["kontrol", "kontrol eden", "checked", "checked by"],
  approvedBy: ["onay", "onaylayan", "onaylayan", "approved", "approved by"],
  discipline: ["disiplin", "discipline", "bolum"],
  status: ["durum", "statu", "status", "asama", "suitability"],
  company: ["firma", "yuklenici", "contractor"],
};

const LABEL_LOOKUP = new Map<string, AntetFieldKey>();
for (const [key, list] of Object.entries(LABELS) as [AntetFieldKey, string[]][])
  for (const l of list) if (!LABEL_LOOKUP.has(l)) LABEL_LOOKUP.set(l, key);

/** Revision-table column headers besides Rev. */
const TABLE_DATE = new Set(["tarih", "date"]);
const TABLE_DESC = new Set(["aciklama", "aciklamalar", "description", "tanim", "degisiklik", "revizyon aciklamasi", "konu", "amac", "purpose"]);

const SCALE_RE = /^(1\s*[:/]\s*\d+(?:[.,]\d+)?(?:\s*[,;/]\s*1\s*[:/]\s*\d+)*|\d+\s*:\s*1|olceksiz|nts|n\.t\.s\.?|yok|-|cesitli|various|gosterildigi gibi|as shown)$/i;
const CODE_RE = /^[A-Za-z0-9]{1,10}(?:[-_.][A-Za-z0-9]{1,10}){3,}$/;

/** Type checks: true = plausible value, false = wrong type, null = no check for this key. */
function plausible(key: AntetFieldKey, value: string): boolean | null {
  const v = value.trim();
  if (!v || v.length > 160) return false;
  switch (key) {
    case "revision":
      return parseRevision(v) !== null;
    case "date":
      return parseDate(v) !== null;
    case "scale":
      return SCALE_RE.test(foldKeyKeepRatio(v));
    case "drawingNo":
    case "docNo":
    case "sheetNo":
    case "projectNo":
      return /\d/.test(v) && v.length <= 80 && !parseDate(v);
    case "drawnBy":
    case "checkedBy":
    case "approvedBy":
      return /\p{L}/u.test(v) && v.length <= 60 && !/\d{3,}/.test(v);
    case "title":
    case "projectName":
      return v.length >= 3 && /\p{L}/u.test(v);
    default:
      return null;
  }
}

function foldKeyKeepRatio(v: string): string {
  return v
    .normalize("NFC")
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface LabelHit {
  seg: Segment;
  key: AntetFieldKey | null;
  label: string;
  /** Value in the same segment ("Çizim No: S-204"). */
  inline: string | null;
}

/** Recognises a label (with or without an inline value) in one segment. */
export function readLabel(text: string): { key: AntetFieldKey | null; label: string; inline: string | null } | null {
  const raw = text.trim();
  if (!raw) return null;
  const k = foldKey(raw);
  if (raw.length <= 32 && LABEL_LOOKUP.has(k)) return { key: LABEL_LOOKUP.get(k)!, label: cleanLabel(raw), inline: null };
  // "Label: value"
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const labelPart = raw.slice(0, colon);
    const rest = raw.slice(colon + 1).trim();
    const lk = foldKey(labelPart);
    if (LABEL_LOOKUP.has(lk)) return { key: LABEL_LOOKUP.get(lk)!, label: cleanLabel(labelPart), inline: rest || null };
    if (labelPart.length <= 28 && lk.split(" ").length <= 4 && /^[\p{L}][\p{L}\s./()-]*$/u.test(labelPart.trim())) {
      return { key: null, label: cleanLabel(labelPart), inline: rest || null };
    }
    return null;
  }
  // "ÖLÇEK 1/50", "REV P02", "PAFTA NO S-204": the remainder must pass the key's type check.
  const words = raw.split(/\s+/);
  for (let n = Math.min(3, words.length - 1); n >= 1; n--) {
    const lk = foldKey(words.slice(0, n).join(" "));
    const key = LABEL_LOOKUP.get(lk);
    if (!key) continue;
    const rest = words.slice(n).join(" ").replace(/^[.:#-]+\s*/, "");
    if (rest && plausible(key, rest) === true && !["title", "projectName", "drawnBy", "checkedBy", "approvedBy"].includes(key))
      return { key, label: cleanLabel(words.slice(0, n).join(" ")), inline: rest };
  }
  return null;
}

function cleanLabel(s: string): string {
  return s.replace(/[\s:.#]+$/, "").trim();
}

function isLabelSegment(text: string): boolean {
  const r = readLabel(text);
  return !!r && r.inline === null;
}

function center(s: Segment): { x: number; y: number } {
  return { x: (s.x0 + s.x1) / 2, y: s.y - s.h / 2 };
}

/** Value to the right of a label on the same line. */
function valueRight(lines: Line[], hit: LabelHit): Segment | null {
  const line = lines[hit.seg.line]!;
  const next = line.segments
    .filter((s) => s.x0 >= hit.seg.x1 - 1 && s !== hit.seg)
    .sort((a, b) => a.x0 - b.x0)[0];
  if (!next) return null;
  if (next.x0 - hit.seg.x1 > Math.max(10 * hit.seg.h, 140)) return null;
  if (isLabelSegment(next.text)) return null;
  return next;
}

/** Value below a label (same column, next lines). Multi-line titles are joined. */
function valueBelow(lines: Line[], hit: LabelHit, maxLines: number): Segment[] {
  const L = hit.seg;
  const reach = Math.max(5 * L.h, 45);
  for (let j = L.line + 1; j < lines.length && lines[j]!.y - L.y <= reach; j++) {
    const inColumn = lines[j]!.segments.filter(
      (s) => s.x0 >= L.x0 - Math.max(15, 2 * L.h) && s.x0 <= L.x1 + Math.max(110, 8 * L.h),
    );
    if (!inColumn.length) continue;
    const first = inColumn.sort((a, b) => Math.abs(a.x0 - L.x0) - Math.abs(b.x0 - L.x0))[0]!;
    if (isLabelSegment(first.text)) return [];
    const out = [first];
    // Following lines of the same block (titles over two or three lines).
    for (let k = j + 1; k < lines.length && out.length < maxLines; k++) {
      const prev = out[out.length - 1]!;
      if (lines[k]!.y - prev.y > 1.9 * Math.max(prev.h, 4)) break;
      const cont = lines[k]!.segments.find((s) => Math.abs(s.x0 - first.x0) <= Math.max(6, first.h) || Math.abs(center(s).x - center(first).x) <= 4);
      if (!cont || isLabelSegment(cont.text) || Math.abs(cont.h - first.h) > 0.35 * first.h) break;
      out.push(cont);
    }
    return out;
  }
  return [];
}

function inBox(s: Segment, b: Box): boolean {
  const c = center(s);
  return c.x >= b.x0 && c.x <= b.x1 && c.y >= b.y0 && c.y <= b.y1;
}

function bbox(segs: Segment[], pad = 0): Box | null {
  if (!segs.length) return null;
  return {
    x0: Math.min(...segs.map((s) => s.x0)) - pad,
    y0: Math.min(...segs.map((s) => s.y - s.h)) - pad,
    x1: Math.max(...segs.map((s) => s.x1)) + pad,
    y1: Math.max(...segs.map((s) => s.y)) + pad,
  };
}

function segBox(segs: Segment[]): Box {
  return bbox(segs)!;
}

interface Candidate extends AntetField {
  inRegion: boolean;
  y: number;
}

/** Detects the revision table: header with Rev + Tarih/Açıklama, rows above or below it. */
function revisionTable(lines: Line[]): { rows: RevisionRow[]; headerLines: Set<number>; segs: Segment[] } {
  for (const line of lines) {
    const revSeg = line.segments.find((s) => LABEL_LOOKUP.get(foldKey(s.text)) === "revision");
    if (!revSeg) continue;
    const dateSeg = line.segments.find((s) => TABLE_DATE.has(foldKey(s.text)));
    const descSeg = line.segments.find((s) => TABLE_DESC.has(foldKey(s.text)));
    if (!dateSeg && !descSeg) continue;
    const cols = [revSeg, dateSeg, descSeg].filter(Boolean) as Segment[];
    const left = Math.min(...cols.map((c) => c.x0)) - 25;
    const right = Math.max(...cols.map((c) => c.x1)) + 260;
    const revX = center(revSeg).x;
    const rows: { y: number; row: RevisionRow; segs: Segment[] }[] = [];
    const scan = (dir: 1 | -1) => {
      let misses = 0;
      for (let j = line.index + dir; j >= 0 && j < lines.length && misses < 2 && rows.length < 30; j += dir) {
        const l = lines[j]!;
        if (Math.abs(l.y - line.y) > 400) break;
        const segs = l.segments.filter((s) => s.x1 >= left && s.x0 <= right);
        const revCell = segs
          .filter((s) => Math.abs(center(s).x - revX) <= Math.max(25, revSeg.x1 - revSeg.x0) || (s.x0 <= revX && s.x1 >= revX))
          .sort((a, b) => Math.abs(center(a).x - revX) - Math.abs(center(b).x - revX))[0];
        const rev = revCell ? normalizeRevision(revCell.text.split(/\s+/)[0]!) : null;
        if (!revCell || !rev) {
          misses++;
          continue;
        }
        misses = 0;
        const rest = segs.filter((s) => s !== revCell);
        // The rev cell may hold more text ("P02 12.03.2026 Onaya sunuldu") when columns are tight.
        const tail = revCell.text.split(/\s+/).slice(1).join(" ");
        const dateCell = dateSeg
          ? rest.filter((s) => Math.abs(center(s).x - center(dateSeg).x) <= 45).sort((a, b) => Math.abs(center(a).x - center(dateSeg).x) - Math.abs(center(b).x - center(dateSeg).x))[0]
          : rest.find((s) => parseDate(s.text));
        const date = dateCell ? parseDate(dateCell.text) : tail ? parseDate(tail) : null;
        const descParts = rest.filter((s) => s !== dateCell && (!descSeg || s.x0 >= descSeg.x0 - 30)).map((s) => s.text);
        const description = descParts.join(" ").trim() || null;
        rows.push({ y: l.y, row: { rev, date: date ?? (dateCell?.text.trim() || null), description }, segs: [revCell, ...rest] });
      }
    };
    scan(1);
    scan(-1);
    if (rows.length) {
      const sorted = rows.sort((a, b) => compareRows(a.row, b.row));
      return { rows: sorted.map((r) => r.row), headerLines: new Set([line.index]), segs: [...cols, ...rows.flatMap((r) => r.segs)] };
    }
  }
  return { rows: [], headerLines: new Set(), segs: [] };
}

/** Oldest first; rows with comparable revisions are ordered by revision, others by date. */
function compareRows(a: RevisionRow, b: RevisionRow): number {
  const pa = parseRevision(a.rev);
  const pb = parseRevision(b.rev);
  if (pa && pb) {
    if (pa.letter !== null && pb.letter !== null) return pa.letter.localeCompare(pb.letter);
    if (pa.number !== null && pb.number !== null) {
      const fam = (p: string) => (p === "C" ? 2 : 1);
      return fam(pa.prefix) - fam(pb.prefix) || pa.number - pb.number;
    }
  }
  return (a.date ?? "").localeCompare(b.date ?? "");
}

/** Title block of one page. */
export function analyzePage(page: WorkerPage, pageCount: number, lang: string = DEFAULT_LANGUAGE): AntetResult {
  const lines = buildLines(page);
  const W = page.width;
  const H = page.height;
  const base: AntetResult = {
    page: page.n,
    pageCount,
    pageSize: { width: W, height: H },
    region: null,
    fields: [],
    pairs: [],
    revisionTable: [],
    codes: [],
    hasText: page.items.length > 0,
    kind: page.items.length ? "text" : "empty",
  };
  if (!page.items.length) return { ...base, note: antetNote(base, lang) };

  const table = revisionTable(lines);
  const hits: LabelHit[] = [];
  for (const line of lines) {
    for (const seg of line.segments) {
      const r = readLabel(seg.text);
      if (!r) continue;
      // Column headers of the revision table are not title-block labels.
      if (table.headerLines.has(line.index) && r.inline === null) continue;
      hits.push({ seg, ...r });
    }
  }

  // Title-block region: known labels in the bottom-right part of the page, else all known labels.
  const known = hits.filter((h) => h.key);
  const inZone = known.filter((h) => center(h.seg).x > 0.5 * W && center(h.seg).y > 0.5 * H);
  const cluster = inZone.length >= 2 ? inZone : known.length >= 3 ? known : [];
  let region = bbox(
    [...cluster.map((h) => h.seg), ...table.segs.filter((s) => center(s).x > 0.45 * W)],
    Math.max(12, ...cluster.map((h) => 2 * h.seg.h)),
  );
  if (region && cluster.length) {
    // Values below the lowest labels belong to the block as well.
    region = { ...region, x1: Math.min(W, region.x1 + 60), y1: Math.min(H, region.y1 + 40) };
  }

  const candidates: Candidate[] = [];
  const pairs: AntetPair[] = [];
  for (const hit of hits) {
    let value: string | null = null;
    let source: AntetField["source"] = "inline";
    let valueSegs: Segment[] = [];
    if (hit.inline) {
      value = hit.inline;
      valueSegs = [hit.seg];
    } else {
      const right = valueRight(lines, hit);
      const below = valueBelow(lines, hit, hit.key === "title" || hit.key === "projectName" ? 3 : 1);
      const belowText = below.map((s) => s.text).join(" ");
      const okRight = right && hit.key ? plausible(hit.key, right.text) : null;
      const okBelow = below.length && hit.key ? plausible(hit.key, belowText) : null;
      if (right && (okRight === true || (okRight === null && (!below.length || right.x0 - hit.seg.x1 < 4 * hit.seg.h)))) {
        value = right.text;
        source = "right";
        valueSegs = [right];
      } else if (below.length && okBelow !== false) {
        value = belowText;
        source = "below";
        valueSegs = below;
      } else if (right && okRight !== false) {
        value = right.text;
        source = "right";
        valueSegs = [right];
      }
    }
    if (!value) continue;
    value = value.replace(/^[\s:.#-]+/, "").trim();
    if (!value) continue;
    const inRegion = !!region && inBox(hit.seg, region);
    if (!region || inRegion) pairs.push({ label: hit.label, value, key: hit.key });
    if (!hit.key) continue;
    const check = plausible(hit.key, value);
    if (check === false) continue;
    let confidence = 0.5;
    if (inRegion) confidence += 0.2;
    else if (region) confidence -= 0.15;
    if (check === true) confidence += 0.2;
    if (source !== "below") confidence += 0.05;
    candidates.push({
      key: hit.key,
      label: hit.label,
      value: normalizeValue(hit.key, value),
      confidence: Math.min(0.97, Math.max(0.1, round2(confidence))),
      source,
      page: page.n,
      box: segBox([hit.seg, ...valueSegs]),
      inRegion,
      y: hit.seg.y,
    });
  }

  const fields: AntetField[] = [];
  for (const key of Object.keys(LABELS) as AntetFieldKey[]) {
    const list = candidates
      .filter((c) => c.key === key)
      .sort((a, b) => b.confidence - a.confidence || Number(b.inRegion) - Number(a.inRegion) || b.y - a.y);
    const best = list[0];
    if (best) {
      const { inRegion: _r, y: _y, ...field } = best;
      fields.push(field);
    }
  }
  // The latest revision-table row stands in for a missing Rev field.
  const latest = table.rows[table.rows.length - 1];
  if (latest && !fields.some((f) => f.key === "revision")) {
    fields.push({ key: "revision", label: "Revizyon Tablosu", value: latest.rev, confidence: 0.75, source: "table", page: page.n });
  }

  const codes = findCodes(lines, region);
  const kind: AntetResult["kind"] = region || fields.length >= 3 ? "drawing" : "text";
  const result: AntetResult = {
    ...base,
    region: region ? roundBox(region) : null,
    fields,
    pairs: dedupePairs(pairs).slice(0, 40),
    revisionTable: table.rows,
    codes,
    kind,
  };
  return { ...result, note: antetNote(result, lang) };
}

/**
 * The note shown with a title block (no pages, no text layer, no title block found), in a
 * language. Derived from the result, so a stored result can be shown in the reader's language.
 */
export function antetNote(a: Pick<AntetResult, "hasText" | "kind" | "fields" | "pageSize">, lang: string = DEFAULT_LANGUAGE): string | undefined {
  const t = tFor(lang);
  if (!a.hasText && a.kind === "empty" && a.pageSize.width === 0 && a.pageSize.height === 0) return t("docintel:antet.noPages");
  if (!a.hasText) return t("docintel:antet.noText");
  if (a.kind === "text" && !a.fields.length) return t("docintel:antet.notFound");
  return undefined;
}

function normalizeValue(key: AntetFieldKey, value: string): string {
  if (key === "revision") return normalizeRevision(value) ?? value;
  if (key === "date") return parseDate(value) ?? value;
  return value.replace(/\s+/g, " ").trim();
}

/** Strings that look like document codes (four or more delimited parts), title block first. */
function findCodes(lines: Line[], region: Box | null): string[] {
  const inside: string[] = [];
  const outside: string[] = [];
  for (const line of lines)
    for (const seg of line.segments) {
      const target = region && inBox(seg, region) ? inside : outside;
      for (const tok of seg.text.split(/[\s:;,()]+/)) {
        const t = tok.replace(/^[.\-_]+|[.\-_]+$/g, "");
        if (CODE_RE.test(t) && /\d/.test(t) && /[A-Za-z]/.test(t) && !parseDate(t)) target.push(t);
      }
    }
  return [...new Set([...inside, ...outside])].slice(0, 20);
}

function dedupePairs(pairs: AntetPair[]): AntetPair[] {
  const seen = new Set<string>();
  return pairs.filter((p) => {
    const k = `${foldKey(p.label)}=${p.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function roundBox(b: Box): Box {
  return { x0: Math.round(b.x0), y0: Math.round(b.y0), x1: Math.round(b.x1), y1: Math.round(b.y1) };
}

/** Title block of a PDF (first page). */
export function analyzeAntet(out: WorkerOutput, lang: string = DEFAULT_LANGUAGE): AntetResult {
  const first = out.pages[0];
  if (!first) {
    return {
      page: 1,
      pageCount: out.pageCount,
      pageSize: { width: 0, height: 0 },
      region: null,
      fields: [],
      pairs: [],
      revisionTable: [],
      codes: [],
      hasText: false,
      kind: "empty",
      note: tFor(lang)("docintel:antet.noPages"),
    };
  }
  return analyzePage(first, out.pageCount, lang);
}

/** Field value by key. */
export function antetValue(antet: AntetResult | null, key: AntetFieldKey): string | null {
  return antet?.fields.find((f) => f.key === key)?.value ?? null;
}
