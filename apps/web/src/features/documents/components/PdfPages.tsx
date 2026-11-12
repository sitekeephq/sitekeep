import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useTranslation } from "react-i18next";
import { i18n } from "../../../i18n";
import { loadPdfjs, renderPage } from "../../../pdf/pdfjs";

const CACHE = "cde-form-pdf";

/**
 * PDF bytes from the browser cache (Cache Storage) or the server; a fetched copy is cached so the
 * form's PDF view also opens offline later.
 */
export async function loadPdfBytes(url: string): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = "caches" in window ? await caches.open(CACHE) : null;
    const hit = await cache?.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    cache = null;
  }
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(res.status === 404 ? i18n.t("documents:pdfPages.errors.notFound") : i18n.t("documents:pdfPages.errors.http", { status: res.status }));
  try {
    await cache?.put(url, res.clone());
  } catch {
    /* storage full or blocked: still show the PDF */
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Starts caching a PDF in the background (e.g. when a PDF form is opened online). */
export function prefetchPdf(url: string) {
  void loadPdfBytes(url).catch(() => undefined);
}

export interface PageSize {
  width: number;
  height: number;
}

/**
 * The pages of a PDF, as wide as the container (at most `maxWidth`), each with an overlay layer:
 * `overlay(page, scale)` draws boxes in CSS pixels (PDF points × scale), page is 1-based.
 */
export function PdfPages({
  url,
  maxWidth = 900,
  overlay,
  onPageRef,
  maxPages = 20,
}: {
  url: string;
  maxWidth?: number;
  overlay(page: number, scale: number, size: PageSize): ReactNode;
  onPageRef?(page: number, el: HTMLDivElement | null): void;
  maxPages?: number;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const wrap = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let destroy: (() => Promise<void>) | null = null;
    setError(null);
    (async () => {
      try {
        const [pdfjs, data] = await Promise.all([loadPdfjs(), loadPdfBytes(url)]);
        const task = pdfjs.getDocument({
          data,
          cMapUrl: "/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/pdfjs/standard_fonts/",
          wasmUrl: "/pdfjs/wasm/",
          iccUrl: "/pdfjs/iccs/",
        });
        destroy = () => task.destroy();
        const d = await task.promise;
        const list: PageSize[] = [];
        for (let i = 1; i <= Math.min(d.numPages, maxPages); i++) {
          const vp = (await d.getPage(i)).getViewport({ scale: 1 });
          list.push({ width: vp.width, height: vp.height });
        }
        if (!alive) return;
        setDoc(d);
        setSizes(list);
      } catch (e) {
        if (alive) setError(navigator.onLine === false ? i18n.t("documents:pdfPages.errors.offline") : (e as Error).message);
      }
    })();
    return () => {
      alive = false;
      void destroy?.();
    };
  }, [url, maxPages]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.observe(el);
    setWidth(Math.floor(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={wrap} className="pdf-pages">
      {error && <p className="error">{error}</p>}
      {!error && !doc && <p className="muted">{t("pdfPages.loading")}</p>}
      {doc &&
        width > 0 &&
        sizes.map((s, i) => {
          const scale = Math.min(width, maxWidth) / s.width;
          return (
            <div key={i} className="pdf-page" style={{ width: s.width * scale, height: s.height * scale }} ref={(el) => onPageRef?.(i + 1, el)}>
              <PageCanvas doc={doc} n={i + 1} scale={scale} />
              <div className="pdf-overlay">{overlay(i + 1, scale, s)}</div>
            </div>
          );
        })}
    </div>
  );
}

function PageCanvas({ doc, n, scale }: { doc: PDFDocumentProxy; n: number; scale: number }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const page = await doc.getPage(n);
        const canvas = await renderPage(page, scale * Math.min(2, window.devicePixelRatio || 1));
        if (!alive || !host.current) return;
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        host.current.replaceChildren(canvas);
      } catch {
        /* a page that fails to render stays blank */
      }
    }, 60);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [doc, n, scale]);
  return <div ref={host} className="pdf-canvas" />;
}
