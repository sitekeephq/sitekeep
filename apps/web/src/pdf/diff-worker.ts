/**
 * Web Worker: pixel diff of two rendered pages of the same size (old A, new B).
 * Returns change regions (clustered, see clusterRegions) and, on request, an overlay image:
 * ink only in A in the "old" colour, only in B in the "new" colour, in both in grey.
 * The heavy per-pixel work runs here so the page and the server stay responsive.
 */
import { clusterRegions, diffMask, dilate, inkMask, MASK_ADDED, MASK_REMOVED, type PixelRegion } from "@sitekeep/shared";

export interface DiffRequest {
  id: number;
  w: number;
  h: number;
  /** RGBA of A and B (null when the page exists on one side only). */
  a: ArrayBuffer | null;
  b: ArrayBuffer | null;
  /** Pixels of tolerance for anti-aliasing and small shifts. */
  tolerance: number;
  /** Grid cell for clustering (pixels). */
  cell: number;
  composite: boolean;
  colors: { old: [number, number, number]; new: [number, number, number]; same: [number, number, number] };
}

export interface DiffResponse {
  id: number;
  w: number;
  h: number;
  regions: PixelRegion[];
  composite: ArrayBuffer | null;
  error?: string;
}

function run(req: DiffRequest): DiffResponse {
  const { w, h } = req;
  const n = w * h;
  const rgbaA = req.a ? new Uint8ClampedArray(req.a) : null;
  const rgbaB = req.b ? new Uint8ClampedArray(req.b) : null;
  const inkA = rgbaA ? inkMask(rgbaA) : new Uint8Array(n);
  const inkB = rgbaB ? inkMask(rgbaB) : new Uint8Array(n);
  const mask = diffMask(inkA, inkB, w, h, req.tolerance);
  const regions = clusterRegions(mask, w, h, { cell: req.cell, gap: 2, minPixels: Math.max(6, req.cell) });
  let composite: ArrayBuffer | null = null;
  if (req.composite) {
    const out = new Uint8ClampedArray(n * 4);
    const dark = (rgba: Uint8ClampedArray | null, p: number) => {
      if (!rgba) return 0;
      const a = rgba[p + 3]! / 255;
      return a * (255 - (0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!));
    };
    const { old: co, new: cn, same: cs } = req.colors;
    // A halo around changed ink keeps thin changes visible when the image is shown smaller.
    const halo = Math.max(1, Math.round(req.tolerance));
    const remNear = dilate(mask.map((v) => v & MASK_REMOVED), w, h, halo);
    const addNear = dilate(mask.map((v) => (v & MASK_ADDED ? 1 : 0)), w, h, halo);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const da = dark(rgbaA, p);
      const db = dark(rgbaB, p);
      const m = mask[i]!;
      let c = cs;
      let alpha: number;
      if (m & MASK_REMOVED) {
        c = co;
        alpha = Math.max(0.45, da / 255);
      } else if (m & MASK_ADDED) {
        c = cn;
        alpha = Math.max(0.45, db / 255);
      } else if (Math.max(da, db) > 40) alpha = (Math.max(da, db) / 255) * 0.85;
      else if (addNear[i]) {
        c = cn;
        alpha = 0.3;
      } else if (remNear[i]) {
        c = co;
        alpha = 0.3;
      } else alpha = (Math.max(da, db) / 255) * 0.85;
      out[p] = 255 - alpha * (255 - c[0]);
      out[p + 1] = 255 - alpha * (255 - c[1]);
      out[p + 2] = 255 - alpha * (255 - c[2]);
      out[p + 3] = 255;
    }
    composite = out.buffer;
  }
  return { id: req.id, w, h, regions, composite };
}

const ctx = self as unknown as { onmessage: ((e: MessageEvent<DiffRequest>) => void) | null; postMessage(m: unknown, t?: Transferable[]): void };
ctx.onmessage = (e) => {
  try {
    const res = run(e.data);
    ctx.postMessage(res, res.composite ? [res.composite] : []);
  } catch (err) {
    ctx.postMessage({ id: e.data.id, w: e.data.w, h: e.data.h, regions: [], composite: null, error: (err as Error).message } satisfies DiffResponse);
  }
};
