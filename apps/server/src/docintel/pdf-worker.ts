/**
 * Worker thread: reads the text layer of a PDF with pdf.js (legacy build, runs in Node) and
 * returns the text items of each page with their positions in display coordinates (points,
 * origin top-left, y down, page rotation applied).
 * Kept free of relative imports so Node can run it directly (also as .ts in dev/tests).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

interface Input {
  /** File on disk, or the bytes themselves. */
  filePath?: string;
  data?: Uint8Array;
  /** Pages to read from the start (the rest are only counted). */
  maxPages: number;
}

export interface WorkerItem {
  /** Text. */
  s: string;
  /** Left, baseline (display coordinates). */
  x: number;
  y: number;
  /** Advance width and font height. */
  w: number;
  h: number;
  /** Text runs left to right (not rotated). */
  hz: boolean;
}

export interface WorkerPage {
  n: number;
  width: number;
  height: number;
  items: WorkerItem[];
}

export interface WorkerOutput {
  pageCount: number;
  pages: WorkerPage[];
  info: Record<string, string>;
}

const require = createRequire(import.meta.url);

async function run(): Promise<WorkerOutput> {
  const { filePath, data, maxPages } = workerData as Input;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const dir = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const bytes = data ? new Uint8Array(data) : new Uint8Array(readFileSync(filePath!));
  const task = pdfjs.getDocument({
    data: bytes,
    standardFontDataUrl: `${dir}/standard_fonts/`,
    cMapUrl: `${dir}/cmaps/`,
    cMapPacked: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  const pages: WorkerPage[] = [];
  const n = Math.min(doc.numPages, maxPages);
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items: WorkerItem[] = [];
    for (const raw of content.items) {
      if (!("str" in raw)) continue;
      const s = raw.str.replace(/\s+/g, " ");
      if (!s.trim()) continue;
      const t = pdfjs.Util.transform(vp.transform, raw.transform) as number[];
      const h = Math.hypot(t[2]!, t[3]!) || raw.height || 1;
      const hz = Math.abs(t[1]!) < 1e-3 && t[0]! > 0;
      items.push({ s, x: round(t[4]!), y: round(t[5]!), w: round(raw.width), h: round(h), hz });
    }
    pages.push({ n: i, width: round(vp.width), height: round(vp.height), items });
    page.cleanup();
  }
  const info: Record<string, string> = {};
  try {
    const meta = await doc.getMetadata();
    for (const [k, v] of Object.entries((meta.info ?? {}) as Record<string, unknown>)) {
      if (typeof v === "string" && ["Title", "Subject", "Author", "Keywords", "Creator"].includes(k) && v.trim())
        info[k] = v.trim().slice(0, 300);
    }
  } catch {
    /* metadata is optional */
  }
  const pageCount = doc.numPages;
  await task.destroy();
  return { pageCount, pages, info };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

run().then(
  (out) => parentPort!.postMessage({ type: "done", out }),
  (err: unknown) => {
    const e = err as { name?: string; message?: string };
    // Known failures are sent as a code; extract.ts turns them into a translated message.
    const code = e?.name === "PasswordException" ? "password" : e?.name === "InvalidPDFException" ? "invalid" : undefined;
    parentPort!.postMessage({ type: "error", code, message: e?.message ?? String(err) });
  },
);
