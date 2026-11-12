import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { PDFPageProxy } from "pdfjs-dist";
import { useTranslation } from "react-i18next";
import { type DiffRegion, type DocCompareDto, type NBox } from "@sitekeep/shared";
import { diffPair, renderPair, toCanvas, type Offset, type PageDiffer } from "../../../pdf/compare-engine";
import { useLabel } from "../../../i18n";
import { ANALYZE_PX, type CompareDocs } from "./hooks/useDocCompareData";

type Mode = "overlay" | "side" | "slider";
const MODES: Mode[] = ["overlay", "side", "slider"];
const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6];

function useWidth(ref: RefObject<HTMLElement | null>, deps: unknown[]): number {
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ...deps]);
  return width;
}

function CanvasHost({ canvas, style }: { canvas: HTMLCanvasElement | null; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.replaceChildren(...(canvas ? [canvas] : []));
  }, [canvas]);
  return <div ref={ref} className="layer" style={style} />;
}

export function DocCompareVisualStage({
  docs,
  error,
  dto,
  page,
  pageCount,
  onPage,
  regions,
  only,
  selected,
  onSelect,
  focus,
  offset,
  onNudge,
  differ,
}: {
  docs: CompareDocs | null;
  error: string | null;
  dto: DocCompareDto;
  page: number;
  pageCount: number;
  onPage(n: number): void;
  regions: DiffRegion[];
  only?: "A" | "B";
  selected: number | null;
  onSelect(i: number): void;
  focus: { box: NBox; seq: number } | null;
  offset: Offset;
  onNudge(dx: number, dy: number): void;
  differ(): PageDiffer;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const label = useLabel();
  const [mode, setMode] = useState<Mode>("overlay");
  const [fit, setFit] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [slider, setSlider] = useState(50);
  const [showRegions, setShowRegions] = useState(true);
  const [pages, setPages] = useState<{ a: PDFPageProxy | null; b: PDFPageProxy | null } | null>(null);
  const [view, setView] = useState<{ a: HTMLCanvasElement | null; b: HTMLCanvasElement | null; overlay: HTMLCanvasElement | null; key: string } | null>(null);
  const [rendering, setRendering] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const sideA = useRef<HTMLDivElement>(null);
  const sideB = useRef<HTMLDivElement>(null);
  const stageWidth = useWidth(mode === "side" ? sideB : stage, [mode, !!docs]);

  useEffect(() => {
    if (!docs) return;
    let alive = true;
    void (async () => {
      const a = page <= docs.a.numPages ? await docs.a.getPage(page) : null;
      const b = page <= docs.b.numPages ? await docs.b.getPage(page) : null;
      if (alive) setPages({ a, b });
    })();
    return () => {
      alive = false;
    };
  }, [docs, page]);

  const base = pages ? (pages.b ?? pages.a)!.getViewport({ scale: 1 }) : null;
  const cssScale = base ? (fit ? Math.max(0.05, (stageWidth - 32) / base.width) : zoom) : 1;
  const dpr = window.devicePixelRatio || 1;
  const pixels = base
    ? Math.min(Math.max(cssScale * dpr, ANALYZE_PX / Math.max(base.width, base.height)), 6000 / Math.max(base.width, base.height))
    : 1;
  const sheetWidth = base ? Math.round(base.width * cssScale) : 0;
  const sheetHeight = base ? Math.round(base.height * cssScale) : 0;

  useEffect(() => {
    if (!pages) return;
    let alive = true;
    const key = `${page}:${pixels.toFixed(3)}:${offset.dx}:${offset.dy}:${mode === "overlay"}`;
    const timer = setTimeout(() => {
      setRendering(true);
      void (async () => {
        try {
          const pair = await renderPair(pages.a, pages.b, pixels, offset);
          let overlay: HTMLCanvasElement | null = null;
          if (mode === "overlay") {
            const result = await diffPair(differ(), pair, true);
            if (result.composite) overlay = toCanvas(result.composite, result.w, result.h);
          }
          if (alive) setView({ a: pair.a, b: pair.b, overlay, key });
        } finally {
          if (alive) setRendering(false);
        }
      })();
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, pixels, offset.dx, offset.dy, mode]);

  const focusDone = useRef(0);
  useEffect(() => {
    if (!focus || !base || focusDone.current === focus.seq) return;
    const boxWidth = (focus.box.x1 - focus.box.x0) * base.width;
    if (fit) {
      setFit(false);
      setZoom(Math.min(6, Math.max(0.5, ((stageWidth - 32) * 0.5) / Math.max(boxWidth, 20))));
      return;
    }
    const element = mode === "side" ? sideB.current : stage.current;
    if (!element) return;
    const centerX = ((focus.box.x0 + focus.box.x1) / 2) * sheetWidth + 16;
    const centerY = ((focus.box.y0 + focus.box.y1) / 2) * sheetHeight + 16;
    element.scrollTo({ left: centerX - element.clientWidth / 2, top: centerY - element.clientHeight / 2, behavior: "smooth" });
    focusDone.current = focus.seq;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq, fit, sheetWidth]);

  const syncing = useRef(false);
  const sync = (source: HTMLDivElement | null, destination: HTMLDivElement | null) => {
    if (!source || !destination || syncing.current) return;
    syncing.current = true;
    destination.scrollLeft = source.scrollLeft;
    destination.scrollTop = source.scrollTop;
    requestAnimationFrame(() => (syncing.current = false));
  };

  const regionSvg = showRegions && regions.length > 0 && (
    <svg viewBox="0 0 1 1" preserveAspectRatio="none" width="100%" height="100%">
      {regions.map((region, index) => (
        <rect
          key={index}
          x={region.box.x0 - 0.004}
          y={region.box.y0 - 0.004}
          width={region.box.x1 - region.box.x0 + 0.008}
          height={region.box.y1 - region.box.y0 + 0.008}
          stroke={region.kind === "added" ? "var(--diff-ink-new)" : region.kind === "removed" ? "var(--diff-ink-old)" : "var(--diff-region)"}
          strokeWidth={index === selected ? 3 : 1.5}
          strokeDasharray={index === selected ? undefined : "6 3"}
          vectorEffect="non-scaling-stroke"
          style={{ cursor: "pointer", pointerEvents: "all", fill: index === selected ? "color-mix(in srgb, var(--diff-region) 18%, transparent)" : "transparent" }}
          onClick={() => onSelect(index)}
        >
          <title>{t("compare.stage.regionTitle", { kind: label("diffRegion", region.kind), n: index + 1 })}</title>
        </rect>
      ))}
    </svg>
  );

  const sheet = (content: ReactNode, caption?: ReactNode) => (
    <>
      {caption}
      <div className="doccmp-sheet" style={{ width: sheetWidth, height: sheetHeight }}>{content}</div>
    </>
  );
  const pageMissing = only ? (only === "B" ? t("compare.stage.pageOnlyNew", { page }) : t("compare.stage.pageRemoved", { page })) : null;

  return (
    <>
      <div className="pdf-toolbar">
        <button className="small" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t("compare.stage.previousPage")}>◀</button>
        <span className="small">{page} / {pageCount}</span>
        <button className="small" disabled={page >= pageCount} onClick={() => onPage(page + 1)} aria-label={t("compare.stage.nextPage")}>▶</button>
        <span className="pdf-sep" />
        {MODES.map((id) => (
          <button key={id} className={`small${mode === id ? " active" : ""}`} onClick={() => setMode(id)}>{t(`compare.stage.modes.${id}`)}</button>
        ))}
        {mode === "slider" && <input className="doccmp-slider" type="range" min={0} max={100} value={slider} onChange={(event) => setSlider(Number(event.target.value))} aria-label={t("compare.stage.modes.slider")} />}
        <span className="pdf-sep" />
        <button className="small" onClick={() => { setFit(false); setZoom(ZOOMS.slice().reverse().find((value) => value < cssScale - 0.01) ?? ZOOMS[0]!); }} aria-label={t("compare.stage.zoomOut")}>−</button>
        <span className="small" style={{ minWidth: 40, textAlign: "center" }}>{Math.round(cssScale * 100)}%</span>
        <button className="small" onClick={() => { setFit(false); setZoom(ZOOMS.find((value) => value > cssScale + 0.01) ?? ZOOMS[ZOOMS.length - 1]!); }} aria-label={t("compare.stage.zoomIn")}>+</button>
        <button className={`small${fit ? " active" : ""}`} onClick={() => setFit(true)}>{t("compare.stage.actions.fit")}</button>
        <button className={`small${showRegions ? " active" : ""}`} onClick={() => setShowRegions(!showRegions)} title={t("compare.stage.regionsHint")}>{t("compare.stage.actions.regions")}</button>
        <span className="pdf-sep" />
        <span className="small muted" title={t("compare.stage.alignHint")}>{t("compare.stage.align")}</span>
        <button className="small" onClick={() => onNudge(-1, 0)} aria-label={t("compare.stage.nudge.left")}>←</button>
        <button className="small" onClick={() => onNudge(0, -1)} aria-label={t("compare.stage.nudge.up")}>↑</button>
        <button className="small" onClick={() => onNudge(0, 1)} aria-label={t("compare.stage.nudge.down")}>↓</button>
        <button className="small" onClick={() => onNudge(1, 0)} aria-label={t("compare.stage.nudge.right")}>→</button>
        {(offset.dx !== 0 || offset.dy !== 0) && <button className="small ghost" onClick={() => onNudge(0, 0)} title={t("compare.stage.resetAlign")}>{offset.dx},{offset.dy} ✕</button>}
        <span className="pdf-sep" />
        <span className="doccmp-legend">
          <span><i style={{ background: "var(--diff-ink-old)" }} />V{dto.from.version}</span>
          <span><i style={{ background: "var(--diff-ink-new)" }} />V{dto.to.version}</span>
          <span><i style={{ background: "var(--diff-ink-same)" }} />{t("compare.stage.same")}</span>
        </span>
        {rendering && <span className="spin" />}
      </div>
      {error && <p className="error" style={{ margin: 16 }}>{error}</p>}
      {!docs && !error && <p className="muted" style={{ margin: 16 }}>{t("compare.stage.loadingPdfs")}</p>}
      {pageMissing && <p className="notice small" style={{ margin: "8px 16px 0" }}>{pageMissing}</p>}
      {docs && mode === "overlay" && <div ref={stage} className="doccmp-stage">{sheet(<><CanvasHost canvas={view?.overlay ?? null} />{regionSvg}</>)}</div>}
      {docs && mode === "slider" && (
        <div ref={stage} className="doccmp-stage">
          {sheet(<><CanvasHost canvas={view?.a ?? null} /><CanvasHost canvas={view?.b ?? null} style={{ clipPath: `inset(0 0 0 ${slider}%)` }} /><div style={{ position: "absolute", top: 0, bottom: 0, left: `${slider}%`, width: 2, background: "var(--primary)" }} />{regionSvg}</>)}
        </div>
      )}
      {docs && mode === "side" && (
        <div className="doccmp-sbs">
          <div ref={sideA} onScroll={() => sync(sideA.current, sideB.current)}>{sheet(<CanvasHost canvas={view?.a ?? null} />, <span className="badge diff-removed side-label">{t("compare.stage.oldVersion", { version: dto.from.version })}</span>)}</div>
          <div ref={sideB} onScroll={() => sync(sideB.current, sideA.current)}>{sheet(<><CanvasHost canvas={view?.b ?? null} />{regionSvg}</>, <span className="badge diff-added side-label">{t("compare.stage.newVersion", { version: dto.to.version })}</span>)}</div>
        </div>
      )}
    </>
  );
}
