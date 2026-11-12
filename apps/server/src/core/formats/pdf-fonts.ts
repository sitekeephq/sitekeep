/**
 * Liberation Sans for generated PDFs (Turkish glyphs): apps/server/assets/fonts, or CDE_PDF_FONT_DIR.
 * Null when the files are missing; callers then fall back to the standard fonts with ASCII text.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/core/formats and dist/core/formats are both three levels below apps/server.
const FONT_DIR = process.env.CDE_PDF_FONT_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/fonts");

let fontCache: { regular: Uint8Array; bold: Uint8Array } | null | undefined;

export function pdfFontBytes(): { regular: Uint8Array; bold: Uint8Array } | null {
  if (fontCache !== undefined) return fontCache;
  const regular = path.join(FONT_DIR, "LiberationSans-Regular.ttf");
  const bold = path.join(FONT_DIR, "LiberationSans-Bold.ttf");
  fontCache = existsSync(regular) && existsSync(bold) ? { regular: readFileSync(regular), bold: readFileSync(bold) } : null;
  return fontCache;
}
