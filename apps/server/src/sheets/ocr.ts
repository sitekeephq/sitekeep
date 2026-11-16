/**
 * OCR of scanned drawing sheets (docs/features/SHEETS.md, "OCR"): pages without a text layer get
 * their title block read by Tesseract (tesseract.js, WebAssembly, Apache-2.0), fully offline.
 *
 * - Only the title block is read: the project's title-block rectangle for the paper orientation,
 *   else the bottom-right quarter of the page, rendered at SITEKEEP_SHEETS_OCR_DPI (300) and capped
 *   at OCR_MAX_PIXELS (lower resolution for very large rectangles).
 * - The language data (English and Turkish, tessdata "best_int") ships in npm packages installed
 *   with the server (@tesseract.js-data/eng, @tesseract.js-data/tur); the engine never downloads
 *   anything: langPath is a local folder and the cache is off. No outbound connection is made
 *   (privacy/outbound.ts lists none for OCR).
 * - Runs inside the sheets job (job queue): rendering in a worker thread with a heap limit, OCR in
 *   the engine's own worker thread, each page with a time limit; at most SITEKEEP_SHEETS_OCR_MAX_PAGES
 *   pages of a drawing are read.
 * - Switches: SITEKEEP_SHEETS_OCR=off (server), the installation switch (system setting
 *   "sheets.ocr", Administration → Privacy) and the project's switch (sheet settings, default on).
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { eq } from "drizzle-orm";
import type Tesseract from "tesseract.js";
import type { RelBox } from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { systemSettings } from "../db/schema.js";
import type { WorkerItem } from "../docintel/pdf-worker.js";
import type { RenderInput, RenderedRegion, RenderRequest } from "./ocr-render-worker.js";

const require = createRequire(import.meta.url);

/** Languages read (Tesseract codes), bundled as npm packages. */
export const OCR_LANGUAGES = ["eng", "tur"] as const;
const envNumber = (name: string, def: number, min: number, max: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.min(max, Math.max(min, Math.round(v))) : def;
};
/** Resolution of the rendered title block. */
export const OCR_DPI = envNumber("SITEKEEP_SHEETS_OCR_DPI", 300, 100, 600);
/** Scanned pages of one drawing that are read; the others keep their automatic numbers. */
export const OCR_MAX_PAGES = envNumber("SITEKEEP_SHEETS_OCR_MAX_PAGES", 100, 1, 500);
/** Largest rendered rectangle (pixels): 16 MP, e.g. the bottom-right quarter of A1 at about 280 dpi. */
const OCR_MAX_PIXELS = 16_000_000;
/** Embedded scan images larger than this are not decoded (an A0 scan at 400 dpi is about 250 MP). */
const OCR_MAX_IMAGE_PIXELS = 300_000_000;
/** Time limits: rendering one batch of pages, reading one page. */
const RENDER_TIMEOUT_MS = 180_000;
const PAGE_TIMEOUT_MS = 60_000;
/** Pages rendered per worker run. */
const RENDER_BATCH = 4;

export const OCR_SETTING_KEY = "sheets.ocr";

/** SITEKEEP_SHEETS_OCR=off|0|false switches OCR off for the server, whatever the settings say. */
export function ocrDisabledByEnv(env: string | undefined = process.env.SITEKEEP_SHEETS_OCR): boolean {
  return /^(0|off|false|no)$/i.test(env?.trim() ?? "");
}

/** Installation switch (system administrators); default on. */
export async function ocrInstanceSwitch(db: Db): Promise<boolean> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, OCR_SETTING_KEY));
  const v = row?.value as { enabled?: boolean } | undefined;
  return v?.enabled !== false;
}

export async function setOcrInstanceSwitch(db: Db, enabled: boolean, userId: string | null): Promise<void> {
  const now = new Date();
  await db
    .insert(systemSettings)
    .values({ key: OCR_SETTING_KEY, value: { enabled }, updatedBy: userId, updatedAt: now })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: { enabled }, updatedBy: userId, updatedAt: now } });
}

/** OCR runs for the installation: not switched off on the server or by the administrators. */
export async function ocrEnabledForInstance(db: Db): Promise<boolean> {
  return !ocrDisabledByEnv() && (await ocrInstanceSwitch(db));
}

let langDir: string | null = null;

/**
 * A folder with <lang>.traineddata.gz of every language: links to the files of the installed
 * language packages (tesseract.js reads one langPath). Made once per process.
 */
function languageDir(): string {
  if (langDir && existsSync(langDir)) return langDir;
  const dir = mkdtempSync(path.join(os.tmpdir(), "sitekeep-ocr-"));
  for (const lang of OCR_LANGUAGES) {
    const pkg = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
    const src = path.join(pkg, "4.0.0_best_int", `${lang}.traineddata.gz`);
    const dest = path.join(dir, `${lang}.traineddata.gz`);
    try {
      symlinkSync(src, dest);
    } catch {
      copyFileSync(src, dest);
    }
  }
  langDir = dir;
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function renderWorkerPath(): string {
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), `ocr-render-worker${path.extname(here)}`);
}

function renderRegions(input: RenderInput): Promise<RenderedRegion[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(renderWorkerPath(), { workerData: input, resourceLimits: { maxOldGenerationSizeMb: 1024 } });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("OCR rendering timed out"))), RENDER_TIMEOUT_MS);
    worker.on("message", (m: { type: string; out?: RenderedRegion[]; message?: string }) => {
      if (m.type === "done") finish(() => resolve(m.out!));
      else finish(() => reject(new Error(m.message ?? "OCR rendering failed")));
    });
    worker.on("error", (err) => finish(() => reject(err)));
    worker.on("exit", (code) => finish(() => reject(new Error(`OCR rendering stopped (${code})`))));
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    }),
  ]);
}

export interface OcrPage {
  /** Words as text items in PDF points (display coordinates), like the text layer. */
  items: WorkerItem[];
  /** Mean word confidence 0..1 (by characters). */
  confidence: number;
}

/**
 * OCR confuses O with 0 and I/l with 1 in codes ("PO3", "A-1O1"): in a short word with a digit, the
 * letters next to a digit are digits. Words without a digit ("ROOM") are left alone.
 */
export function fixOcrCode(word: string): string {
  if (word.length > 16 || !/\d/.test(word)) return word;
  let out = word;
  // Each pass makes the next letter adjacent to a digit ("1OO" → "10O" → "100").
  for (let i = 0; i < 4; i++) {
    const next = out.replace(/(?<=\d)[Oo]|[Oo](?=\d)/g, "0").replace(/(?<=\d)[Il|]|[Il|](?=\d)/g, "1");
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Words of one recognised rectangle as text items of the page. */
export function wordsToItems(
  region: Pick<RenderedRegion, "scale" | "x0" | "y0">,
  lines: { baseline: { x0: number; y0: number; x1: number; y1: number }; words: { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[] }[],
): OcrPage {
  const items: WorkerItem[] = [];
  let weighted = 0;
  let chars = 0;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  for (const line of lines) {
    const bl = line.baseline;
    const slope = bl.x1 !== bl.x0 ? (bl.y1 - bl.y0) / (bl.x1 - bl.x0) : 0;
    for (const w of line.words) {
      const text = fixOcrCode(w.text.trim());
      if (!text) continue;
      const cx = (w.bbox.x0 + w.bbox.x1) / 2;
      // Baseline of the line under the word (scanned lines can be slightly skewed).
      const base = Math.max(w.bbox.y0 + 1, Math.min(w.bbox.y1, bl.y0 + slope * (cx - bl.x0)));
      // Cap height is about 0.7 of the font size the text layer reports.
      const h = Math.max(1, (base - w.bbox.y0) / 0.7);
      items.push({
        s: text,
        x: r2(region.x0 + w.bbox.x0 / region.scale),
        y: r2(region.y0 + base / region.scale),
        w: r2((w.bbox.x1 - w.bbox.x0) / region.scale),
        h: r2(h / region.scale),
        hz: true,
      });
      weighted += Math.max(0, Math.min(100, w.confidence)) * text.length;
      chars += text.length;
    }
  }
  return { items, confidence: chars ? Math.round((weighted / chars / 100) * 100) / 100 : 0 };
}

export interface OcrRequest {
  n: number;
  box: RelBox;
}

/**
 * Reads the rectangles of scanned pages with OCR. Pages that fail or time out are left out; the
 * caller keeps their automatic numbers.
 */
export async function ocrPdfPages(filePath: string, requests: OcrRequest[], log?: (msg: string) => void): Promise<Map<number, OcrPage>> {
  const result = new Map<number, OcrPage>();
  const pages: RenderRequest[] = requests.slice(0, OCR_MAX_PAGES).map((r) => ({ n: r.n, box: r.box }));
  if (!pages.length) return result;
  const text = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let worker: Tesseract.Worker;
  try {
    const { default: Tesseract } = await import("tesseract.js");
    worker = await Tesseract.createWorker([...OCR_LANGUAGES].join("+"), Tesseract.OEM.LSTM_ONLY, {
      langPath: languageDir(),
      cacheMethod: "none",
      gzip: true,
      logger: () => undefined,
      errorHandler: (e: unknown) => log?.(`OCR: ${text(e)}`),
    });
  } catch (err) {
    // The engine or its language data cannot be loaded: the pages are numbered without OCR.
    log?.(`OCR unavailable: ${text(err)}`);
    return result;
  }
  try {
    // A few pages at a time: rendered images are not all held in memory at once.
    for (let i = 0; i < pages.length; i += RENDER_BATCH) {
      const regions = await renderRegions({
        filePath,
        pages: pages.slice(i, i + RENDER_BATCH),
        dpi: OCR_DPI,
        maxPixels: OCR_MAX_PIXELS,
        maxImagePixels: OCR_MAX_IMAGE_PIXELS,
      });
      for (const region of regions) {
        await worker.setParameters({ user_defined_dpi: String(Math.round(region.scale * 72)) });
        const r = await withTimeout(worker.recognize(Buffer.from(region.png), {}, { blocks: true }), PAGE_TIMEOUT_MS, `OCR of page ${region.n}`);
        const lines = (r.data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
        result.set(region.n, wordsToItems(region, lines));
      }
    }
  } catch (err) {
    // A page that cannot be rendered or read in time stops the OCR of this drawing; pages read so far count.
    log?.(`OCR stopped: ${text(err)}`);
  } finally {
    await worker.terminate().catch(() => undefined);
  }
  return result;
}
