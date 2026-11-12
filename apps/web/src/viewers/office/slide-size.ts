/** Slide and page geometry helpers (pure, unit-tested). */

/** Scale that fits a box into an area (never above `max`). */
export function fitScale(box: { width: number; height: number }, area: { width: number; height: number }, max = Infinity): number {
  if (box.width <= 0 || box.height <= 0 || area.width <= 0 || area.height <= 0) return 1;
  return Math.max(0.05, Math.min(max, area.width / box.width, area.height / box.height));
}

/** CSS px → @page length (inches, 96 px per inch). */
export function pxToIn(px: number): string {
  return `${Math.round((px / 96) * 1000) / 1000}in`;
}

/** A4 printable width in CSS px for a 10 mm margin (portrait 190 mm, landscape 277 mm). */
export const A4_PRINTABLE = { portrait: (190 / 25.4) * 96, landscape: (277 / 25.4) * 96 };

/**
 * Print layout of a spreadsheet range: portrait when it fits, else landscape, and a zoom that
 * shrinks wider tables to the page width.
 */
export function sheetPrintLayout(tableWidthPx: number): { orientation: "portrait" | "landscape"; zoom: number } {
  if (tableWidthPx <= A4_PRINTABLE.portrait) return { orientation: "portrait", zoom: 1 };
  const zoom = Math.min(1, A4_PRINTABLE.landscape / tableWidthPx);
  return { orientation: "landscape", zoom: Math.max(0.3, Math.round(zoom * 1000) / 1000) };
}
