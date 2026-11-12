/** Toolbar pieces shared by the office views: page-layout PDF button, print menu, zoom, find. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { officePdfAction, type PreviewKind, type VersionPreviewDto } from "@sitekeep/shared";
import { formatPercent } from "../../shared/lib/format";
import type { DomFinder } from "./find";

/**
 * "Open in Page Layout (PDF)": shown only when the converter's PDF exists, is being made, or a
 * converter is configured (then it can be made). Without a converter nothing is shown.
 */
export function PdfLayoutButton({
  info,
  onRequest,
  to,
  onOpen,
}: {
  info: VersionPreviewDto;
  onRequest(kind: PreviewKind): void;
  /** Route of the PDF viewer (documents). */
  to?: string;
  /** Switch to the PDF in place (presentations). */
  onOpen?(): void;
}) {
  const { t } = useTranslation("viewers");
  const action = officePdfAction(info);
  const pdf = info.previews.find((p) => p.kind === "pdf");
  const title = t("office.pdfLayout.hint");
  if (action === "open")
    return to ? (
      <Link className="btn small" to={to} title={title}>
        {t("office.pdfLayout.actions.open")}
      </Link>
    ) : (
      <button className="small" onClick={onOpen} title={title}>
        {t("office.pdfLayout.actions.open")}
      </button>
    );
  if (action === "busy")
    return (
      <button className="small" disabled>
        {t("office.pdfLayout.status.preparing")}
      </button>
    );
  if (action === "request")
    return (
      <button className="small" onClick={() => onRequest("pdf")} title={pdf?.status === "failed" ? (pdf.error ?? title) : title}>
        {pdf?.status === "failed" ? t("office.pdfLayout.actions.retry") : t("office.pdfLayout.actions.open")}
      </button>
    );
  return null;
}

/** "Print / PDF" with the honest note: browser printing gives an approximate layout. */
export function PrintMenu({
  onPrint,
  exactPdf,
  children,
  disabled,
}: {
  onPrint(): void | Promise<void>;
  /** Link to the converter's exact PDF, when there is one. */
  exactPdf?: ReactNode;
  /** Options (e.g. which sheets). */
  children?: ReactNode;
  disabled?: boolean;
}) {
  const { t } = useTranslation("viewers");
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="vw-pop-wrap" ref={wrap}>
      <button className={`small${open ? " on" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={disabled} title={t("office.print.hint")}>
        {t("office.print.actions.menu")}
      </button>
      {open && (
        <div className="vw-pop" role="dialog" aria-label={t("office.print.actions.menu")}>
          <strong>{t("office.print.title")}</strong>
          {children}
          <p className="small muted">{t("office.print.help")}</p>
          {exactPdf ?? <p className="small muted">{t("office.print.noExactPdf")}</p>}
          <div className="row">
            <button
              className="small primary"
              onClick={() => {
                setOpen(false);
                void onPrint();
              }}
            >
              {t("office.print.actions.print")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export function ZoomControls({ zoom, onZoom, onFit }: { zoom: number; onZoom(z: number): void; onFit(): void }) {
  const { t } = useTranslation("viewers");
  const step = (d: number) => {
    const next = d > 0 ? ZOOMS.find((z) => z > zoom + 0.001) : [...ZOOMS].reverse().find((z) => z < zoom - 0.001);
    onZoom(next ?? zoom);
  };
  return (
    <span className="vw-zoom">
      <button className="small" onClick={() => step(-1)} aria-label={t("actions.zoomOut")} disabled={zoom <= ZOOMS[0]!}>
        −
      </button>
      <select className="small" value={String(zoom)} onChange={(e) => onZoom(Number(e.target.value))} aria-label={t("office.zoom.fields.zoom")}>
        {!ZOOMS.includes(zoom) && <option value={String(zoom)}>{formatPercent(zoom)}</option>}
        {ZOOMS.map((z) => (
          <option key={z} value={String(z)}>
            {formatPercent(z)}
          </option>
        ))}
      </select>
      <button className="small" onClick={() => step(1)} aria-label={t("actions.zoomIn")} disabled={zoom >= ZOOMS[ZOOMS.length - 1]!}>
        +
      </button>
      <button className="small" onClick={onFit} title={t("office.zoom.fitHint")}>
        {t("actions.fit")}
      </button>
    </span>
  );
}

/** Find box over a DomFinder; `version` changes when the content is re-rendered. */
export function FindBar({ finder, version }: { finder: DomFinder | null; version: unknown }) {
  const { t } = useTranslation("viewers");
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  const [hit, setHit] = useState(0);

  useEffect(() => {
    if (!finder) return;
    const timer = setTimeout(() => {
      const n = query.trim() ? finder.search(query) : (finder.clear(), 0);
      setCount(n);
      setHit(0);
      if (n) finder.focus(0);
    }, 200);
    return () => clearTimeout(timer);
  }, [finder, query, version]);

  useEffect(() => () => finder?.clear(), [finder]);

  const step = (d: number) => {
    if (!finder || !count) return;
    const n = (hit + d + count) % count;
    setHit(n);
    finder.focus(n);
  };
  return (
    <span className="vw-find">
      <input
        type="search"
        placeholder={t("office.find.placeholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
        }}
        aria-label={t("office.find.placeholder")}
      />
      <button className="small" disabled={!count} onClick={() => step(-1)} aria-label={t("actions.previous")}>
        ↑
      </button>
      <button className="small" disabled={!count} onClick={() => step(1)} aria-label={t("actions.next")}>
        ↓
      </button>
      {query.trim() && <span className="small muted">{count ? `${hit + 1}/${count}` : t("messages.notFound")}</span>}
    </span>
  );
}

/** Card for files too large to render comfortably in the browser. */
export function LargeFileCard({ size, onOpen, download }: { size: number; onOpen(): void; download?: ReactNode }) {
  const { t } = useTranslation("viewers");
  return (
    <div className="vw-center">
      <div className="vw-card">
        <h2>{t("office.largeFile.title")}</h2>
        <p className="muted small">{t("office.largeFile.description", { size: Math.round(size / 1024 / 1024) })}</p>
        <div className="row wrap">
          <button className="primary" onClick={onOpen}>
            {t("office.largeFile.actions.openAnyway")}
          </button>
          {download}
        </div>
      </div>
    </div>
  );
}
