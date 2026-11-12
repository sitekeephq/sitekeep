/** Text helpers for document intelligence: Turkish-aware folding, lines, dates. */
import { foldTr } from "@sitekeep/shared";
import type { WorkerItem, WorkerPage } from "./pdf-worker.js";

/**
 * Lower-case, Turkish dotted/dotless i folded, diacritics removed ("ÇİZİM No." → "cizim no.").
 * Used for comparisons only, never for display.
 */
export function fold(s: string): string {
  return foldTr(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** fold() without punctuation: "Pafta / Doküman Adı:" → "pafta dokuman adi". */
export function foldKey(s: string): string {
  return fold(s)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A run of text on one line that belongs to one cell (items with small gaps merged). */
export interface Segment {
  text: string;
  x0: number;
  x1: number;
  /** Baseline. */
  y: number;
  /** Font height. */
  h: number;
  line: number;
}

export interface Line {
  index: number;
  y: number;
  h: number;
  segments: Segment[];
  text: string;
}

/**
 * Groups horizontal text items into lines (same baseline) and splits each line into segments
 * where the horizontal gap is larger than the font size (separate title-block cells).
 */
export function buildLines(page: WorkerPage): Line[] {
  const items = page.items.filter((i) => i.hz && i.s.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: WorkerItem[][] = [];
  for (const it of items) {
    // Items are sorted by baseline, so the matching row is one of the last ones.
    let row: WorkerItem[] | undefined;
    for (let i = rows.length - 1; i >= 0 && it.y - rows[i]![0]!.y <= 6; i--) {
      const r = rows[i]!;
      if (Math.abs(r[0]!.y - it.y) <= Math.max(1.5, 0.35 * Math.min(r[0]!.h, it.h))) {
        row = r;
        break;
      }
    }
    if (row) row.push(it);
    else rows.push([it]);
  }
  rows.sort((a, b) => a[0]!.y - b[0]!.y);
  return rows.map((row, index) => {
    row.sort((a, b) => a.x - b.x);
    const segments: Segment[] = [];
    for (const it of row) {
      const last = segments[segments.length - 1];
      const gap = last ? it.x - last.x1 : Infinity;
      const h = Math.max(it.h, 1);
      if (last && gap < Math.max(2, 0.9 * Math.max(h, last.h))) {
        const space = gap > 0.15 * h && !last.text.endsWith(" ") && !it.s.startsWith(" ") ? " " : "";
        last.text += space + it.s;
        last.x1 = Math.max(last.x1, it.x + it.w);
        last.h = Math.max(last.h, h);
      } else {
        segments.push({ text: it.s, x0: it.x, x1: it.x + it.w, y: it.y, h, line: index });
      }
    }
    for (const s of segments) s.text = s.text.replace(/\s+/g, " ").trim();
    const kept = segments.filter((s) => s.text);
    return {
      index,
      y: row[0]!.y,
      h: Math.max(...row.map((r) => r.h)),
      segments: kept,
      text: kept.map((s) => s.text).join("  "),
    };
  });
}

const MONTHS: Record<string, number> = {
  ocak: 1, subat: 2, mart: 3, nisan: 4, mayis: 5, haziran: 6, temmuz: 7, agustos: 8, eylul: 9, ekim: 10, kasim: 11, aralik: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "12.03.2026", "12/03/26", "2026-03-12", "12 Mart 2026", "12-Mar-2026" → "2026-03-12". */
export function parseDate(raw: string): string | null {
  const t = fold(raw);
  let y: number, m: number, d: number;
  let r = /(?:^|\D)(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:\D|$)/.exec(t);
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /(?:^|\D)(\d{1,2})[-./](\d{1,2})[-./](\d{2}|\d{4})(?:\D|$)/.exec(t))) {
    [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
    if (y < 100) y += 2000;
  } else if ((r = /(?:^|\D)(\d{1,2})[\s-]+([a-z]{3,8})\.?[\s-]+(\d{4})(?:\D|$)/.exec(t))) {
    const month = MONTHS[r[2]!] ?? MONTHS[r[2]!.slice(0, 3)];
    if (!month) return null;
    [d, m, y] = [Number(r[1]), month, Number(r[3])];
  } else return null;
  if (y < 1950 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Cuts a string to `max` characters at a word boundary, with an ellipsis. */
export function shorten(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, "")}…`;
}
