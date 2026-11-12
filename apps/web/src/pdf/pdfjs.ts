/** pdf.js is loaded on first use; its worker and data files are served by the app (offline). */
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

export function loadPdfjs() {
  pdfjsPromise ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  });
  return pdfjsPromise;
}

/** Opens a PDF by URL (cookies sent). `destroy` releases it. */
export async function openPdf(url: string): Promise<{ doc: PDFDocumentProxy; destroy(): Promise<void> }> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    url,
    withCredentials: true,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
    iccUrl: "/pdfjs/iccs/",
  });
  const doc = await task.promise;
  return { doc, destroy: () => task.destroy() };
}

/** Renders a page at `scale` (CSS px per PDF point × device pixels) into a new canvas. */
export async function renderPage(page: PDFPageProxy, scale: number): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // "print" intent: no requestAnimationFrame chunking, so pages also render in a background tab.
  await page.render({ canvas, canvasContext: ctx, viewport, intent: "print" }).promise;
  return canvas;
}
