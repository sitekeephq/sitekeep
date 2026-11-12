/**
 * Spreadsheet viewer: virtualized grid (rows and columns) over the server's sheet JSON (SheetJS
 * on the server, no office software), with sheet tabs, sticky headers, frozen first row, column
 * widths, basic merges, Turkish number formats (done on the server), search within the sheet
 * and a print view (browser print / save as PDF, A4, a page range per sheet).
 */
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { foldTr, officePdfAction, type SheetCell, type SheetDataDto, type SheetPreviewDto } from "@sitekeep/shared";
import { i18n } from "../i18n";
import { viewersApi } from "../shared/api/api-viewers";
import { formatNumber } from "../shared/lib/format";
import type { ViewerProps } from "./types";
import { PdfLayoutButton, PrintMenu } from "./office/OfficeTools";
import { printContent } from "./office/print";
import { sheetPrintLayout } from "./office/slide-size";

const ROW_H = 24;
const HEAD_H = 24;
const MAX_HITS = 5000;
const OVERSCAN = 4;

export function colName(c: number): string {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const textOf = (c: SheetCell | undefined): string => (c == null ? "" : Array.isArray(c) ? c[0] : c);

export default function SheetViewer({ projectId, info, onRequest }: ViewerProps) {
  const { t } = useTranslation("viewers");
  const [data, setData] = useState<SheetPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let alive = true;
    viewersApi.sheet(projectId, info.versionId).then(
      (d) => {
        if (!alive) return;
        setData(d);
        setIndex(Math.max(0, d.sheets.findIndex((s) => !s.hidden)));
      },
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [projectId, info.versionId]);

  const pdfLink = `/projects/${projectId}/view/${info.versionId}`;
  const extra = data && (
    <>
      <SheetPrint sheets={data.sheets} index={index} fileName={info.fileName} pdfLink={officePdfAction(info) === "open" ? pdfLink : null} />
      <PdfLayoutButton info={info} onRequest={onRequest} to={pdfLink} />
    </>
  );

  if (error) return <p className="error" style={{ margin: 16 }}>{error}</p>;
  if (!data) return <div className="vw-center muted"><span className="vw-spin" />{t("sheet.messages.loading")}</div>;
  const sheet = data.sheets[index];
  return (
    <>
      {sheet ? <Grid key={index} sheet={sheet} extra={extra} /> : <p className="muted" style={{ margin: 16 }}>{t("sheet.empty")}</p>}
      {data.sheets.length > 1 && (
        <div className="sh-tabs" role="tablist">
          {data.sheets.map((s, i) => (
            <button
              key={s.name}
              role="tab"
              aria-selected={i === index}
              className={`sh-tab${i === index ? " active" : ""}${s.hidden ? " hidden-sheet" : ""}`}
              title={s.hidden ? t("sheet.hiddenSheet") : undefined}
              onClick={() => setIndex(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function Grid({ sheet, extra }: { sheet: SheetDataDto; extra: ReactNode }) {
  const { t } = useTranslation("viewers");
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, left: 0, width: 800, height: 600 });
  const [freeze, setFreeze] = useState(true);
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const [current, setCurrent] = useState<[number, number] | null>(null);
  const deferred = useDeferredValue(query);

  const rowNumW = 14 + String(Math.max(sheet.rowCount, 1)).length * 8;
  const { colX, totalW } = useMemo(() => {
    const xs = [0];
    for (const w of sheet.colWidths) xs.push(xs[xs.length - 1]! + w);
    return { colX: xs, totalW: xs[xs.length - 1]! };
  }, [sheet]);
  const { covered, merges } = useMemo(() => {
    const cov = new Set<number>();
    for (const m of sheet.merges)
      for (let r = m.r0; r <= m.r1; r++) for (let c = m.c0; c <= m.c1; c++) cov.add(r * 16384 + c);
    return { covered: cov, merges: sheet.merges };
  }, [sheet]);

  const hits = useMemo(() => {
    const q = foldTr(deferred.trim());
    if (!q) return [] as [number, number][];
    const out: [number, number][] = [];
    for (let r = 0; r < sheet.rows.length && out.length < MAX_HITS; r++) {
      const row = sheet.rows[r]!;
      for (let c = 0; c < row.length; c++) if (row[c] != null && foldTr(textOf(row[c])).includes(q)) out.push([r, c]);
    }
    return out;
  }, [deferred, sheet]);
  const hitSet = useMemo(() => new Set(hits.map(([r, c]) => r * 16384 + c)), [hits]);

  useLayoutEffect(() => {
    const el = scroller.current!;
    const measure = () => setView((v) => ({ ...v, width: el.clientWidth, height: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const frame = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = scroller.current;
      if (el) setView((v) => ({ ...v, top: el.scrollTop, left: el.scrollLeft }));
    });
  };

  const goTo = (r: number, c: number) => {
    setCurrent([r, c]);
    const el = scroller.current;
    if (!el) return;
    const y = HEAD_H + r * ROW_H;
    const x = rowNumW + colX[c]!;
    if (y < el.scrollTop + HEAD_H * (freeze ? 2 : 1) || y + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = y - el.clientHeight / 2;
    if (x < el.scrollLeft + rowNumW || x + (sheet.colWidths[c] ?? 80) > el.scrollLeft + el.clientWidth) el.scrollLeft = x - el.clientWidth / 3;
  };

  useEffect(() => {
    setHit(0);
    if (hits[0]) goTo(hits[0][0], hits[0][1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits]);

  const step = (d: number) => {
    if (!hits.length) return;
    const n = (hit + d + hits.length) % hits.length;
    setHit(n);
    goTo(hits[n]![0], hits[n]![1]);
  };

  // Visible window.
  const r0 = Math.max(0, Math.floor((view.top - HEAD_H) / ROW_H) - OVERSCAN);
  const r1 = Math.min(sheet.rows.length - 1, Math.ceil((view.top + view.height) / ROW_H) + OVERSCAN);
  const firstCol = (x: number) => {
    let lo = 0;
    let hi = sheet.colWidths.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (colX[mid]! <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const c0 = Math.max(0, firstCol(view.left - rowNumW) - 1);
  const c1 = Math.min(sheet.colWidths.length - 1, firstCol(view.left + view.width) + 1);

  const cellEl = (r: number, c: number, top: number, w = sheet.colWidths[c] ?? 80, h = ROW_H, merged = false) => {
    const v = sheet.rows[r]?.[c];
    const key = r * 16384 + c;
    const isCur = current?.[0] === r && current?.[1] === c;
    return (
      <div
        key={`${r}:${c}`}
        className={`sh-cell${Array.isArray(v) ? " num" : ""}${merged ? " merged" : ""}${hitSet.has(key) ? " hit" : ""}${isCur ? " current" : ""}`}
        style={{ left: rowNumW + colX[c]!, top, width: w, height: h, justifyContent: Array.isArray(v) ? "flex-end" : undefined }}
        title={textOf(v).length > 20 ? textOf(v) : undefined}
        onClick={() => setCurrent([r, c])}
      >
        {textOf(v)}
      </div>
    );
  };

  const body: ReactNode[] = [];
  const rowNums: ReactNode[] = [];
  for (let r = r0; r <= r1; r++) {
    const top = HEAD_H + r * ROW_H;
    rowNums.push(
      <div key={r} className="sh-head" style={{ left: 0, top, width: rowNumW, height: ROW_H }}>
        {r + 1}
      </div>,
    );
    const row = sheet.rows[r]!;
    for (let c = c0; c <= Math.min(c1, row.length - 1); c++) {
      if (row[c] == null && !(current?.[0] === r && current?.[1] === c)) continue;
      if (covered.has(r * 16384 + c)) continue;
      body.push(cellEl(r, c, top));
    }
  }
  const mergeSpan = (m: (typeof merges)[number]) => ({
    w: colX[m.c1 + 1]! - colX[m.c0]!,
    h: (m.r1 - m.r0 + 1) * ROW_H,
  });
  for (const m of merges) {
    if (m.r1 < r0 || m.r0 > r1 || m.c1 < c0 || m.c0 > c1) continue;
    const { w, h } = mergeSpan(m);
    body.push(cellEl(m.r0, m.c0, HEAD_H + m.r0 * ROW_H, w, h, true));
  }
  const colHeads: ReactNode[] = [];
  const frozen: ReactNode[] = [];
  for (let c = c0; c <= c1; c++) {
    colHeads.push(
      <div key={c} className="sh-head" style={{ left: rowNumW + colX[c]!, top: 0, width: sheet.colWidths[c], height: HEAD_H }}>
        {colName(c)}
      </div>,
    );
    if (freeze && view.top > 0 && sheet.rows[0]?.[c] != null && !covered.has(c)) frozen.push(cellEl(0, c, HEAD_H));
  }

  const cur = current ? sheet.rows[current[0]]?.[current[1]] : undefined;
  return (
    <>
      <div className="vw-tool">
        <input
          type="search"
          placeholder={t("sheet.find.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && step(e.shiftKey ? -1 : 1)}
        />
        <button className="small" disabled={!hits.length} onClick={() => step(-1)} aria-label={t("actions.previous")}>
          ↑
        </button>
        <button className="small" disabled={!hits.length} onClick={() => step(1)} aria-label={t("actions.next")}>
          ↓
        </button>
        {deferred.trim() && (
          <span className="small muted">
            {hits.length ? `${hit + 1}/${hits.length}${hits.length >= MAX_HITS ? "+" : ""}` : t("messages.notFound")}
          </span>
        )}
        <button className={`small${freeze ? " on" : ""}`} onClick={() => setFreeze((f) => !f)} title={t("sheet.freezeHint")}>
          {t("sheet.actions.freeze")}
        </button>
        <div className="spacer" />
        <span className="small muted">
          {t("sheet.size", { rows: formatNumber(sheet.rowCount), cols: sheet.colCount })}
          {sheet.truncated && ` ${t("sheet.truncated")}`}
        </span>
        {extra}
      </div>
      <div className="sh-formula">
        <span className="ref">{current ? `${colName(current[1])}${current[0] + 1}` : ""}</span>
        <span className="val" title={textOf(cur)}>
          {textOf(cur)}
        </span>
      </div>
      <div className="sh-scroll" ref={scroller} onScroll={onScroll} tabIndex={0}>
        <div className="sh-canvas" style={{ width: rowNumW + totalW, height: HEAD_H + sheet.rows.length * ROW_H }}>
          <div className={`sh-sticky-top${freeze ? " sh-frozen" : ""}`} style={{ width: rowNumW + totalW }}>
            {colHeads}
            {frozen}
          </div>
          <div className="sh-sticky-left">{rowNums}</div>
          <div className="sh-corner">
            <div className="sh-head" style={{ left: 0, top: 0, width: rowNumW, height: HEAD_H }} />
            {freeze && view.top > 0 && (
              <div className="sh-head" style={{ left: 0, top: HEAD_H, width: rowNumW, height: ROW_H }}>
                1
              </div>
            )}
          </div>
          {body}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Print view
// ---------------------------------------------------------------------------------------------

/** Rows printed per sheet at most (browsers get slow above this). */
const PRINT_ROWS = 5000;

function SheetPrint({ sheets, index, fileName, pdfLink }: { sheets: SheetDataDto[]; index: number; fileName: string; pdfLink: string | null }) {
  const { t } = useTranslation("viewers");
  const visible = sheets.filter((s) => !s.hidden);
  const [all, setAll] = useState(false);
  const chosen = all ? visible : sheets[index] ? [sheets[index]!] : [];
  const cut = chosen.some((s) => s.rows.length > PRINT_ROWS);
  return (
    <PrintMenu
      onPrint={() => printSheets(chosen, fileName)}
      disabled={!chosen.length}
      exactPdf={
        pdfLink ? (
          <p className="small">
            <Trans t={t} i18nKey="office.print.exactPdf" components={{ link: <Link to={pdfLink} /> }} />
          </p>
        ) : undefined
      }
    >
      {visible.length > 1 && (
        <div className="vw-pop-options">
          <label>
            <input type="radio" checked={!all} onChange={() => setAll(false)} /> {t("sheet.print.options.thisSheet", { name: sheets[index]?.name })}
          </label>
          <label>
            <input type="radio" checked={all} onChange={() => setAll(true)} /> {t("sheet.print.options.allSheets", { count: visible.length })}
          </label>
        </div>
      )}
      <p className="small muted">
        {t("sheet.print.help")}
        {cut && ` ${t("sheet.print.rowLimit", { rows: formatNumber(PRINT_ROWS) })}`}
      </p>
    </PrintMenu>
  );
}

/** Each sheet as a plain table (merges, widths, right-aligned numbers); a new page per sheet. */
function printSheets(sheets: SheetDataDto[], fileName: string) {
  const widths = sheets.map((s) => s.colWidths.reduce((a, w) => a + w, 0));
  const layout = sheetPrintLayout(Math.max(1, ...widths));
  return printContent(
    (root) => {
      sheets.forEach((sheet, k) => {
        const sec = document.createElement("section");
        sec.className = "vw-print-sheet";
        const h = document.createElement("h2");
        h.textContent = sheets.length > 1 ? `${fileName} · ${sheet.name}` : fileName;
        sec.appendChild(h);
        const table = document.createElement("table");
        table.style.width = `${widths[k]}px`;
        table.style.zoom = String(layout.zoom);
        const cols = document.createElement("colgroup");
        for (const w of sheet.colWidths) {
          const col = document.createElement("col");
          col.style.width = `${w}px`;
          cols.appendChild(col);
        }
        table.appendChild(cols);
        const anchors = new Map<number, { rs: number; cs: number }>();
        const covered = new Set<number>();
        for (const m of sheet.merges) {
          anchors.set(m.r0 * 16384 + m.c0, { rs: m.r1 - m.r0 + 1, cs: m.c1 - m.c0 + 1 });
          for (let r = m.r0; r <= m.r1; r++) for (let c = m.c0; c <= m.c1; c++) if (r !== m.r0 || c !== m.c0) covered.add(r * 16384 + c);
        }
        const body = document.createElement("tbody");
        const n = Math.min(sheet.rows.length, PRINT_ROWS);
        for (let r = 0; r < n; r++) {
          const tr = document.createElement("tr");
          const row = sheet.rows[r]!;
          for (let c = 0; c < sheet.colCount; c++) {
            const key = r * 16384 + c;
            if (covered.has(key)) continue;
            const td = document.createElement("td");
            const v = row[c];
            td.textContent = textOf(v);
            if (Array.isArray(v)) td.className = "num";
            const a = anchors.get(key);
            if (a) {
              if (a.rs > 1) td.rowSpan = Math.min(a.rs, n - r);
              if (a.cs > 1) td.colSpan = a.cs;
            }
            tr.appendChild(td);
          }
          body.appendChild(tr);
        }
        table.appendChild(body);
        sec.appendChild(table);
        if (sheet.rows.length > n) {
          const p = document.createElement("p");
          p.textContent = i18n.t("viewers:sheet.print.moreRows", { rows: formatNumber(sheet.rows.length - n) });
          sec.appendChild(p);
        }
        root.appendChild(sec);
      });
    },
    { size: `A4 ${layout.orientation}`, margin: "10mm" },
  );
}
