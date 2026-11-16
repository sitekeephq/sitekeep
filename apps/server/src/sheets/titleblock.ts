/**
 * Title-block template of a project (docs/features/SHEETS.md, "Title-block template"): a rectangle
 * drawn by a project administrator on a sample sheet, per paper orientation, with field rules: a
 * sub-region (the text inside it) or a label keyword (the value next to or below that label).
 *
 * Works on the positioned text of a page (the text layer, or the words OCR read on a scanned page),
 * so the same rules apply to both. Coordinates of the template are page-relative (0..1, top-left).
 */
import { normalizeRevision, type RelBox, type TitleBlockFieldKey, type TitleBlockRegion } from "@sitekeep/shared";
import type { WorkerPage } from "../docintel/pdf-worker.js";
import { readLabel } from "../docintel/antet.js";
import { buildLines, foldKey, parseDate, type Line, type Segment } from "../docintel/text.js";

export type TitleBlockValues = Partial<Record<TitleBlockFieldKey, string>>;

/** The items of a page whose centre lies inside a page-relative box. */
export function pageWithin(page: WorkerPage, box: RelBox): WorkerPage {
  const W = page.width || 1;
  const H = page.height || 1;
  return {
    ...page,
    items: page.items.filter((it) => {
      const cx = (it.x + it.w / 2) / W;
      const cy = (it.y - it.h / 2) / H;
      return cx >= box.x0 && cx <= box.x1 && cy >= box.y0 && cy <= box.y1;
    }),
  };
}

/** Text of a sub-region: its lines top to bottom; a label in it ("REV", "Pafta No:") is dropped. */
function textInBox(page: WorkerPage, box: RelBox): string | null {
  const lines = buildLines(pageWithin(page, box));
  const parts: string[] = [];
  for (const line of lines)
    for (const seg of line.segments) {
      const label = readLabel(seg.text);
      if (label?.inline) parts.push(label.inline);
      else if (!label) parts.push(seg.text);
    }
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text || null;
}

/** "Sheet No." matches "SHEET NO: A-101" and "Sheet No"; returns the text after the label, or "". */
function afterLabel(text: string, label: string): string | null {
  const want = foldKey(label);
  if (!want) return null;
  const words = text.trim().split(/\s+/);
  for (let n = 1; n <= words.length; n++) {
    const head = foldKey(words.slice(0, n).join(" "));
    if (head === want) return words.slice(n).join(" ").replace(/^[\s:.#-]+/, "").trim();
    if (head.length > want.length) break;
  }
  return null;
}

/** Value of a label keyword inside the title block: same cell, the cell to the right, or below. */
function valueOfLabel(lines: Line[], label: string, multiline: boolean): string | null {
  for (const line of lines) {
    for (const seg of line.segments) {
      const rest = afterLabel(seg.text, label);
      if (rest === null) continue;
      if (rest) return rest;
      const right = line.segments.filter((s) => s.x0 >= seg.x1 - 1 && s !== seg).sort((a, b) => a.x0 - b.x0)[0];
      if (right && right.x0 - seg.x1 <= Math.max(10 * seg.h, 140) && !readLabel(right.text)) return right.text;
      const below = valueBelow(lines, seg, multiline ? 3 : 1);
      if (below) return below;
    }
  }
  return null;
}

function valueBelow(lines: Line[], L: Segment, maxLines: number): string | null {
  const reach = Math.max(5 * L.h, 45);
  const out: Segment[] = [];
  for (let j = L.line + 1; j < lines.length && lines[j]!.y - L.y <= reach + out.length * 2 * L.h; j++) {
    const seg = lines[j]!.segments
      .filter((s) => s.x1 >= L.x0 - Math.max(15, 2 * L.h) && s.x0 <= L.x1 + Math.max(110, 8 * L.h))
      .sort((a, b) => Math.abs(a.x0 - L.x0) - Math.abs(b.x0 - L.x0))[0];
    if (!seg) {
      if (out.length) break;
      continue;
    }
    if (readLabel(seg.text) && !readLabel(seg.text)?.inline) break;
    out.push(seg);
    if (out.length >= maxLines) break;
  }
  return out.length ? out.map((s) => s.text).join(" ") : null;
}

/** Normalises a value read for a field (revision code, ISO date); null when it is not usable. */
export function cleanFieldValue(key: TitleBlockFieldKey, raw: string | null | undefined): string | null {
  const v = raw?.replace(/\s+/g, " ").trim();
  if (!v) return null;
  if (key === "revision") {
    const token = v.split(" ")[0]!;
    return normalizeRevision(token) ?? normalizeRevision(v) ?? (v.length <= 12 ? v : null);
  }
  if (key === "date") return parseDate(v);
  if (key === "number") return v.length <= 120 ? v : null;
  return v.slice(0, 300);
}

/**
 * Values of the template's field rules on one page. A rule with a sub-region reads the text in it;
 * a rule with a label keyword looks for the label inside the title-block rectangle. Fields without
 * a rule (or whose rule finds nothing) are left out: the caller falls back to automatic reading.
 */
export function applyTitleBlock(page: WorkerPage, region: TitleBlockRegion): TitleBlockValues {
  const out: TitleBlockValues = {};
  const inRegion = pageWithin(page, region.box);
  const lines = buildLines(inRegion);
  for (const rule of region.fields) {
    let value: string | null = null;
    if (rule.box) value = cleanFieldValue(rule.key, textInBox(page, rule.box));
    if (!value && rule.label) value = cleanFieldValue(rule.key, valueOfLabel(lines, rule.label, rule.key === "title"));
    if (value) out[rule.key] = value;
  }
  return out;
}
