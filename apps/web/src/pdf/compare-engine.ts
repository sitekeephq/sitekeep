/**
 * Browser side of the visual comparison: renders page pairs with pdf.js into one frame (the new
 * page's size; the old page is scaled to it when only the paper size changed and moved by the
 * manual offset) and hands the pixels to the diff worker.
 */
import type { PDFPageProxy } from "pdfjs-dist";
import type { DiffRequest, DiffResponse } from "./diff-worker";
import { renderPage } from "./pdfjs";

export type Rgb = [number, number, number];

/** Diff colours from the CSS tokens (--diff-ink-*), so the theme decides them. */
export function inkColors(): { old: Rgb; new: Rgb; same: Rgb } {
  const css = getComputedStyle(document.documentElement);
  const rgb = (name: string, fallback: Rgb): Rgb => {
    const v = css.getPropertyValue(name).trim();
    const m = /^#([0-9a-f]{6})$/i.exec(v);
    if (!m) return fallback;
    const n = parseInt(m[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  return { old: rgb("--diff-ink-old", [200, 30, 30]), new: rgb("--diff-ink-new", [30, 90, 200]), same: rgb("--diff-ink-same", [150, 155, 160]) };
}

export class PageDiffer {
  private readonly worker: Worker;
  private seq = 0;
  private readonly pending = new Map<number, (r: DiffResponse) => void>();

  constructor() {
    this.worker = new Worker(new URL("./diff-worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<DiffResponse>) => {
      const done = this.pending.get(e.data.id);
      this.pending.delete(e.data.id);
      done?.(e.data);
    };
  }

  diff(req: Omit<DiffRequest, "id">): Promise<DiffResponse> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      const transfer = [req.a, req.b].filter((x): x is ArrayBuffer => !!x);
      this.worker.postMessage({ ...req, id }, transfer);
    });
  }

  terminate() {
    this.worker.terminate();
    this.pending.clear();
  }
}

// pdf.js renders are serialised: two documents rendering the same page at once fight over memory.
let chain: Promise<unknown> = Promise.resolve();
export function queued<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

export interface Offset {
  /** Points, applied to the old page. */
  dx: number;
  dy: number;
}

export interface FramePair {
  w: number;
  h: number;
  /** Canvases already in the common frame. */
  a: HTMLCanvasElement | null;
  b: HTMLCanvasElement | null;
  /** Points → frame pixels. */
  scale: number;
}

/** The old page's scale factor in the new page's frame (paper size changed, same proportions). */
export function fitFactor(a: PDFPageProxy | null, b: PDFPageProxy | null): number {
  if (!a || !b) return 1;
  const va = a.getViewport({ scale: 1 });
  const vb = b.getViewport({ scale: 1 });
  const ra = va.width / va.height;
  const rb = vb.width / vb.height;
  const sizeDiff = Math.abs(va.width - vb.width) / vb.width;
  return Math.abs(ra - rb) / rb < 0.02 && sizeDiff > 0.01 ? vb.width / va.width : 1;
}

/** Renders both pages into a frame of the new page's size (or the old one's when B has no such page). */
export function renderPair(pageA: PDFPageProxy | null, pageB: PDFPageProxy | null, scale: number, offset: Offset): Promise<FramePair> {
  return queued(async () => {
    const ref = (pageB ?? pageA)!.getViewport({ scale });
    const w = Math.max(1, Math.floor(ref.width));
    const h = Math.max(1, Math.floor(ref.height));
    let b: HTMLCanvasElement | null = null;
    if (pageB) b = await renderPage(pageB, scale);
    let a: HTMLCanvasElement | null = null;
    if (pageA) {
      const f = pageB ? fitFactor(pageA, pageB) : 1;
      const raw = await renderPage(pageA, scale * f);
      if (!pageB && !offset.dx && !offset.dy) a = raw;
      else {
        a = document.createElement("canvas");
        a.width = w;
        a.height = h;
        const ctx = a.getContext("2d", { willReadFrequently: true })!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(raw, Math.round(offset.dx * scale), Math.round(offset.dy * scale));
      }
    }
    if (b && (b.width !== w || b.height !== h)) {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d")!.drawImage(b, 0, 0);
      b = c;
    }
    return { w, h, a, b, scale };
  });
}

export function pixels(c: HTMLCanvasElement | null, w: number, h: number): ArrayBuffer | null {
  if (!c) return null;
  return c.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, w, h).data.buffer as ArrayBuffer;
}

/** Diff of a rendered pair. */
export function diffPair(differ: PageDiffer, pair: FramePair, composite: boolean): Promise<DiffResponse> {
  const { w, h } = pair;
  return differ.diff({
    w,
    h,
    a: pixels(pair.a, w, h),
    b: pixels(pair.b, w, h),
    tolerance: Math.max(1, Math.round(pair.scale * 0.6)),
    cell: Math.max(4, Math.round(pair.scale * 4)),
    composite,
    colors: inkColors(),
  });
}

/** RGBA buffer → canvas. */
export function toCanvas(buf: ArrayBuffer, w: number, h: number, into?: HTMLCanvasElement): HTMLCanvasElement {
  const c = into ?? document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
  return c;
}
