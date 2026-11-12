/**
 * Presentation viewer: slide strip, next/previous, arrow keys, full-screen "Sunum modu" and
 * speaker notes (read from .pptx on the server, no converter needed). Slides come from the
 * converter's PDF when it exists (exact layout) and are otherwise rendered in the browser from
 * the .pptx itself (office/pptx.ts). Both can be switched when both are there.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { browserOffice, officePdfAction } from "@sitekeep/shared";
import { i18n } from "../i18n";
import { api } from "../shared/api/api";
import { documentsApi } from "../features/documents/api";
import { viewersApi } from "../shared/api/api-viewers";
import type { ViewerProps } from "./types";
import { LargeFileCard, PdfLayoutButton, PrintMenu } from "./office/OfficeTools";
import type { HtmlDeck, SlideMount } from "./office/pptx";
import { printContent } from "./office/print";
import { fitScale, pxToIn } from "./office/slide-size";
import { openPdf } from "../pdf/pdfjs";

type PdfDeck = { kind: "pdf"; doc: PDFDocumentProxy };
type Deck = PdfDeck | HtmlDeck;
type Source = "pdf" | "html";

/** Above this size a presentation is rendered in the browser only on request. */
const LARGE = 80 * 1024 * 1024;

const countOf = (d: Deck | null) => (!d ? 0 : d.kind === "pdf" ? d.doc.numPages : d.count);

export default function SlidesViewer({ projectId, info, onRequest }: ViewerProps) {
  const { t } = useTranslation(["viewers", "common"]);
  const pdfReady = info.previews.some((p) => p.kind === "pdf" && p.status === "ready");
  const canHtml = browserOffice(info.extension) === "pptx";
  // Chosen once per opening: a PDF that becomes ready later is offered, not forced.
  const [source, setSource] = useState<Source>(() => (pdfReady || !canHtml ? "pdf" : "html"));
  const [pdfDeck, setPdfDeck] = useState<PdfDeck | null>(null);
  const [htmlDeck, setHtmlDeck] = useState<HtmlDeck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forceLarge, setForceLarge] = useState(false);
  const [params, setParams] = useSearchParams();
  const [present, setPresent] = useState(false);
  const [showNotes, setShowNotes] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const pdfTask = useRef<{ destroy(): Promise<void> } | null>(null);
  const notes =
    info.previews.find((p) => p.kind === "text")?.meta.notes ?? info.previews.find((p) => p.kind === "pdf")?.meta.notes ?? [];
  const deck: Deck | null = source === "pdf" ? pdfDeck : htmlDeck;
  const count = countOf(deck);
  const slide = Math.min(Math.max(1, Number(params.get("slide")) || 1), Math.max(count, 1));
  const tooLarge = source === "html" && info.size > LARGE && !forceLarge;

  // Both decks stay open while the viewer is open, so switching back and forth is instant.
  useEffect(() => () => void pdfTask.current?.destroy(), []);
  const htmlRef = useRef<HtmlDeck | null>(null);
  htmlRef.current = htmlDeck;
  useEffect(() => () => htmlRef.current?.destroy(), []);
  useEffect(() => {
    if (source !== "pdf" || pdfDeck) return;
    let alive = true;
    setError(null);
    openPdf(viewersApi.pdfUrl(projectId, info.versionId)).then(
      (r) => {
        if (!alive) return void r.destroy();
        pdfTask.current = r;
        setPdfDeck({ kind: "pdf", doc: r.doc });
      },
      (e: Error) => {
        if (!alive) return;
        if (canHtml) setSource("html");
        else setError(i18n.t("viewers:slides.errors.openFailed", { message: e.message }));
      },
    );
    return () => {
      alive = false;
    };
  }, [source, pdfDeck, projectId, info.versionId, canHtml]);

  useEffect(() => {
    if (source !== "html" || htmlDeck || tooLarge) return;
    let alive = true;
    setError(null);
    (async () => {
      const data = await viewersApi.bytes(viewersApi.mediaUrl(projectId, info.versionId));
      const { renderPptx } = await import("./office/pptx");
      const d = await renderPptx(data);
      if (alive) setHtmlDeck(d);
      else d.destroy();
    })().catch((e: Error) => alive && setError(i18n.t("viewers:slides.errors.browserFailed", { message: e.message })));
    return () => {
      alive = false;
    };
  }, [source, projectId, info.versionId, htmlDeck, tooLarge]);

  const go = useCallback(
    (n: number) => {
      if (!count) return;
      const next = Math.min(Math.max(1, n), count);
      setParams(
        (p) => {
          p.set("slide", String(next));
          return p;
        },
        { replace: true },
      );
    },
    [count, setParams],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(e.key)) go(slide + 1);
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) go(slide - 1);
      else if (e.key === "Home") go(1);
      else if (e.key === "End") go(count);
      else if (e.key.toLowerCase() === "f" || e.key === "F5") void togglePresent();
      else if (e.key === "Escape" && present) void togglePresent();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Leaving full screen (Esc in the browser) ends the presentation too.
  useEffect(() => {
    const onFs = () => !document.fullscreenElement && setPresent(false);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  /** Presentation mode covers the window; real full screen is used when the browser allows it. */
  async function togglePresent() {
    if (present) {
      setPresent(false);
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      return;
    }
    setPresent(true);
    await root.current?.requestFullscreen?.().catch(() => undefined);
  }

  const print = async () => {
    if (source === "pdf") {
      // The converter's PDF prints exactly from the browser's own PDF viewer.
      window.open(viewersApi.pdfUrl(projectId, info.versionId), "_blank", "noopener");
      return;
    }
    if (!htmlDeck) return;
    const mounts: SlideMount[] = [];
    await printContent(
      async (r) => {
        for (let i = 0; i < htmlDeck.count; i++) {
          const page = document.createElement("div");
          page.className = "vw-print-slide";
          page.style.width = `${htmlDeck.width}px`;
          page.style.height = `${htmlDeck.height}px`;
          r.appendChild(page);
          const m = htmlDeck.mount(i, page, 1);
          if (m) mounts.push(m);
        }
        await Promise.all(mounts.map((m) => m.ready.catch(() => undefined)));
        // Let chart entry animations finish, or bars print empty.
        if (htmlDeck.hasCharts) await new Promise((r) => setTimeout(r, 1500));
      },
      { size: `${pxToIn(htmlDeck.width)} ${pxToIn(htmlDeck.height)}`, margin: "0" },
      () => mounts.forEach((m) => m.dispose()),
    );
  };

  if (tooLarge)
    return (
      <LargeFileCard
        size={info.size}
        onOpen={() => setForceLarge(true)}
        download={
          info.canDownload && (
            <a className="btn" href={documentsApi.downloadUrl(projectId, info.versionId)}>
              ⬇ {t("common:actions.download")}
            </a>
          )
        }
      />
    );
  if (error) return <p className="error" style={{ margin: 16 }}>{error}</p>;
  if (!deck)
    return (
      <div className="vw-center muted">
        <span className="vw-spin" />
        {source === "html" ? t("slides.messages.preparingBrowser") : t("slides.messages.loading")}
      </div>
    );
  const note = notes[slide - 1];
  const pdfAction = officePdfAction(info);
  return (
    <div ref={root} className={`vw${present ? " sl-present" : ""}`} style={{ flex: 1 }}>
      {!present && (
        <div className="vw-tool">
          <button className="small" onClick={() => go(slide - 1)} disabled={slide <= 1} aria-label={t("slides.previousSlide")}>
            ◀
          </button>
          <span className="small">
            {slide} / {count}
          </span>
          <button className="small" onClick={() => go(slide + 1)} disabled={slide >= count} aria-label={t("slides.nextSlide")}>
            ▶
          </button>
          <button className="small primary" onClick={() => void togglePresent()} title={t("slides.presentHint")}>
            ▶ {t("slides.actions.present")}
          </button>
          {notes.some(Boolean) && (
            <button className={`small${showNotes ? " on" : ""}`} onClick={() => setShowNotes((s) => !s)}>
              {t("slides.actions.notes")}
            </button>
          )}
          {source === "html" && (
            <span className="badge" title={t("slides.browserViewHint")}>
              {t("slides.badges.browserView")}
            </span>
          )}
          <div className="spacer" />
          <PrintMenu
            onPrint={print}
            exactPdf={
              source === "pdf" ? (
                <p className="small muted">{t("slides.exactPdfTab")}</p>
              ) : pdfAction === "open" ? (
                <p className="small">
                  <Trans
                    t={t}
                    i18nKey="office.print.exactPdf"
                    components={{ link: <a href={viewersApi.pdfUrl(projectId, info.versionId)} target="_blank" rel="noopener noreferrer" /> }}
                  />
                </p>
              ) : undefined
            }
          />
          {source === "html" ? (
            <PdfLayoutButton info={info} onRequest={onRequest} onOpen={() => setSource("pdf")} />
          ) : (
            canHtml && (
              <button className="small" onClick={() => setSource("html")} title={t("slides.browserViewButtonHint")}>
                {t("slides.actions.browserView")}
              </button>
            )
          )}
          {source === "pdf" && (
            <Link className="btn small" to={`/projects/${projectId}/view/${info.versionId}?page=${slide}`} title={t("slides.markupHint")}>
              {t("slides.actions.markup")}
            </Link>
          )}
        </div>
      )}
      <div className={present ? "sl-main" : "sl"} style={present ? { flex: 1 } : undefined}>
        {!present && <Thumbs deck={deck} current={slide} onPick={go} />}
        <div className="sl-main">
          <Slide deck={deck} n={slide} onClick={(e) => (present ? go(slide + (e.shiftKey ? -1 : 1)) : undefined)} />
          {!present && showNotes && note && <div className="sl-notes">{note}</div>}
        </div>
      </div>
      {present && (
        <span className="sl-present-hint">
          {t("slides.presentExit", { slide, total: count })}
        </span>
      )}
    </div>
  );
}

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function Slide({ deck, n, onClick }: { deck: Deck; n: number; onClick(e: React.MouseEvent): void }) {
  const stage = useRef<HTMLDivElement>(null);
  const size = useSize(stage);
  const w = size.w - 8;
  const h = size.h - 8;
  return (
    <div className="sl-stage" ref={stage} onClick={onClick}>
      {w > 0 &&
        h > 0 &&
        (deck.kind === "pdf" ? (
          <PdfSlide doc={deck.doc} n={n} w={w} h={h} />
        ) : (
          <HtmlSlide deck={deck} n={n} scale={fitScale(deck, { width: w, height: h })} shadow />
        ))}
    </div>
  );
}

function PdfSlide({ doc, n, w, h }: { doc: PDFDocumentProxy; n: number; w: number; h: number }) {
  const { t } = useTranslation("viewers");
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    void doc.getPage(n).then((page) => {
      if (cancelled || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(w / base.width, h / base.height);
      const viewport = page.getViewport({ scale: Math.max(scale, 0.1) });
      const dpr = window.devicePixelRatio || 1;
      const c = canvas.current;
      c.width = Math.floor(viewport.width * dpr);
      c.height = Math.floor(viewport.height * dpr);
      c.style.width = `${Math.floor(viewport.width)}px`;
      c.style.height = `${Math.floor(viewport.height)}px`;
      task = page.render({ canvas: c, canvasContext: c.getContext("2d")!, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      task.promise.catch(() => undefined);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, n, w, h]);
  return <canvas ref={canvas} aria-label={t("slides.slideLabel", { n })} />;
}

/** A browser-rendered slide, laid out at slide size and scaled into its box. */
function HtmlSlide({ deck, n, scale, shadow }: { deck: HtmlDeck; n: number; scale: number; shadow?: boolean }) {
  const { t } = useTranslation("viewers");
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let m: SlideMount | null = null;
    try {
      m = deck.mount(n - 1, el, scale);
    } catch {
      el.textContent = i18n.t("viewers:slides.errors.slideFailed");
    }
    return () => {
      m?.dispose();
      el.textContent = "";
    };
  }, [deck, n, scale]);
  return (
    <div
      ref={host}
      className={`sl-html${shadow ? " shadow" : ""}`}
      style={{ width: deck.width * scale, height: deck.height * scale }}
      aria-label={t("slides.slideLabel", { n })}
      role="img"
    />
  );
}

/** Slide strip; thumbnails render when they scroll into view. */
function Thumbs({ deck, current, onPick }: { deck: Deck; current: number; onPick(n: number): void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(".sl-thumb.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);
  return (
    <div className="sl-thumbs" ref={list}>
      {Array.from({ length: countOf(deck) }, (_, i) => (
        <Thumb key={`${deck.kind}${i}`} deck={deck} n={i + 1} active={current === i + 1} onPick={onPick} />
      ))}
    </div>
  );
}

function Thumb({ deck, n, active, onPick }: { deck: Deck; n: number; active: boolean; onPick(n: number): void }) {
  const { t } = useTranslation("viewers");
  const ref = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(140);

  useEffect(() => {
    const el = ref.current!;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setVisible(true), { rootMargin: "200px" });
    io.observe(el);
    setWidth(Math.max(60, el.clientWidth - 4));
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || deck.kind !== "pdf") return;
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    let cancelled = false;
    void deck.doc.getPage(n).then((page) => {
      if (cancelled || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 280 / base.width });
      canvas.current.width = Math.floor(viewport.width);
      canvas.current.height = Math.floor(viewport.height);
      task = page.render({ canvas: canvas.current, canvasContext: canvas.current.getContext("2d")!, viewport });
      task.promise.catch(() => undefined);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, deck, n]);

  return (
    <button ref={ref} className={`sl-thumb${active ? " active" : ""}`} onClick={() => onPick(n)} aria-label={t("slides.slideLabel", { n })}>
      {deck.kind === "pdf" ? (
        <canvas ref={canvas} width={280} height={158} />
      ) : visible ? (
        <HtmlSlide deck={deck} n={n} scale={width / deck.width} />
      ) : (
        <div style={{ width, height: (width * deck.height) / deck.width }} />
      )}
      <span>{n}</span>
    </button>
  );
}
