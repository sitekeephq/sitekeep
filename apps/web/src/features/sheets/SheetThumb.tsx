/**
 * Sheet thumbnail: the page rendered in the browser with pdf.js from the version's PDF (the same
 * file the PDF viewer opens), when the card scrolls into view. Documents are shared between the
 * pages of one version and rendered two at a time; DWG/DXF sheets show their format instead.
 */
import { useEffect, useRef, useState } from "react";
import type { DrawingSheetDto } from "@sitekeep/shared";
import { openPdf, renderPage } from "../../pdf/pdfjs";
import { viewersApi } from "../../shared/api/api-viewers";

type OpenDoc = Awaited<ReturnType<typeof openPdf>>;

const docs = new Map<string, Promise<OpenDoc>>();
const images = new Map<string, string>();
let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Releases the PDFs opened for thumbnails (called when the sheets page closes). */
export function releaseThumbnails(): void {
  for (const p of docs.values()) void p.then((d) => d.destroy()).catch(() => undefined);
  docs.clear();
}

async function thumbnail(pid: string, sheet: DrawingSheetDto, width: number): Promise<string> {
  const key = `${sheet.versionId}:${sheet.page}:${width}`;
  const hit = images.get(key);
  if (hit) return hit;
  return slot(async () => {
    let doc = docs.get(sheet.versionId);
    if (!doc) {
      doc = openPdf(viewersApi.pdfUrl(pid, sheet.versionId));
      docs.set(sheet.versionId, doc);
      doc.catch(() => docs.delete(sheet.versionId));
    }
    const { doc: pdf } = await doc;
    const page = await pdf.getPage(Math.min(sheet.page, pdf.numPages));
    const base = page.getViewport({ scale: 1 });
    const canvas = await renderPage(page, (width * Math.min(window.devicePixelRatio || 1, 2)) / base.width);
    page.cleanup();
    const url = canvas.toDataURL("image/jpeg", 0.8);
    images.set(key, url);
    return url;
  });
}

export function SheetThumb({ pid, sheet, width = 220 }: { pid: string; sheet: DrawingSheetDto; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(images.get(`${sheet.versionId}:${sheet.page}:${width}`) ?? null);
  const [failed, setFailed] = useState(false);
  const pdf = sheet.format === "pdf";

  useEffect(() => {
    if (!pdf || src) return;
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        thumbnail(pid, sheet, width).then(
          (url) => alive && setSrc(url),
          () => alive && setFailed(true),
        );
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [pid, sheet, width, pdf, src]);

  return (
    <div ref={ref} className="sheet-thumb" data-testid="sheet-thumb">
      {src ? <img src={src} alt="" /> : <span className="sheet-thumb-format">{failed || !pdf ? sheet.format.toUpperCase() : ""}</span>}
    </div>
  );
}
