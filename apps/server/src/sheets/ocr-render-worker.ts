/**
 * Worker thread: renders one rectangle of PDF pages (the title block of a scanned sheet) to PNG with
 * pdf.js and @napi-rs/canvas, for OCR (ocr.ts). Only the rectangle is drawn, at the asked
 * resolution, capped in pixels so a large sheet cannot take the memory of the server.
 * Kept free of relative imports so Node can run it directly (also as .ts in dev/tests).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

export interface RenderRequest {
  n: number;
  /** Page-relative rectangle (0..1, origin top-left of the displayed page). */
  box: { x0: number; y0: number; x1: number; y1: number };
}

export interface RenderInput {
  filePath: string;
  pages: RenderRequest[];
  dpi: number;
  /** Largest image handed to OCR (pixels); the resolution is lowered to fit. */
  maxPixels: number;
  /** Larger images embedded in the PDF are not decoded (pdf.js maxImageSize). */
  maxImagePixels: number;
}

export interface RenderedRegion {
  n: number;
  png: Uint8Array;
  /** Pixels per PDF point. */
  scale: number;
  /** Rectangle in PDF points (display coordinates). */
  x0: number;
  y0: number;
  pageWidth: number;
  pageHeight: number;
}

const require = createRequire(import.meta.url);

async function run(): Promise<RenderedRegion[]> {
  const input = workerData as RenderInput;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = (await import("@napi-rs/canvas")) as typeof import("@napi-rs/canvas");
  const dir = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const task = pdfjs.getDocument({
    data: new Uint8Array(readFileSync(input.filePath)),
    standardFontDataUrl: `${dir}/standard_fonts/`,
    cMapUrl: `${dir}/cmaps/`,
    cMapPacked: true,
    maxImageSize: input.maxImagePixels,
    verbosity: 0,
  });
  const doc = await task.promise;
  const out: RenderedRegion[] = [];
  for (const req of input.pages) {
    if (req.n < 1 || req.n > doc.numPages) continue;
    const page = await doc.getPage(req.n);
    const base = page.getViewport({ scale: 1 });
    const x0 = req.box.x0 * base.width;
    const y0 = req.box.y0 * base.height;
    const w = (req.box.x1 - req.box.x0) * base.width;
    const h = (req.box.y1 - req.box.y0) * base.height;
    if (w < 1 || h < 1) continue;
    const scale = Math.min(input.dpi / 72, Math.sqrt(input.maxPixels / (w * h)));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const viewport = page.getViewport({ scale, offsetX: -x0 * scale, offsetY: -y0 * scale });
    const canvas = createCanvas(cw, ch);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cw, ch);
    await page.render({ canvas: canvas as never, canvasContext: ctx as never, viewport, background: "#ffffff" }).promise;
    const png = await canvas.encode("png");
    out.push({ n: req.n, png: new Uint8Array(png), scale, x0, y0, pageWidth: base.width, pageHeight: base.height });
    page.cleanup();
  }
  await task.destroy();
  return out;
}

run().then(
  (out) => parentPort!.postMessage({ type: "done", out }, out.map((r) => r.png.buffer as ArrayBuffer)),
  (err: unknown) => parentPort!.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) }),
);
