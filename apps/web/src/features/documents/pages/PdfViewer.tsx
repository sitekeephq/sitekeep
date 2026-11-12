/**
 * PDF viewer with markups (Forma Docs style): page navigation, zoom, fit width, and
 * pen / rectangle / revision cloud / arrow / text markups stored per file version.
 * Markups start as drafts (only the author sees them) and are published explicitly.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import {
  type IssueLinkDto,
  type MarkupDto,
  type MarkupShape,
  type PdfPoint,
} from "@sitekeep/shared";
import { i18n, useLabel } from "../../../i18n";
import { api, formatDate } from "../../../shared/api/api";
import { documentsApi } from "../api";
import { viewersApi } from "../../../shared/api/api-viewers";
import { useAuth } from "../../../app/context/auth";
import { useAsk } from "../../../shared/ui/Ask";
import { useLoad, useProject } from "../../../app/context/project";
import { SHAPE_LABEL_KEYS, ShapeSvg, shapeBox, unionBox, type Projection, type Px } from "../../../pdf/shapes";
import { openPdf } from "../../../pdf/pdfjs";
import { MarkupIssueDialog as MarkupIssueDialogComponent } from "../components/MarkupIssueDialog";
import { webCapability } from "../../../sdk";

type Tool = "select" | MarkupShape["type"];

const TOOLS: { id: Tool; icon: string; labelKey: "documents:viewer.tools.select" | (typeof SHAPE_LABEL_KEYS)[MarkupShape["type"]] }[] = [
  { id: "select", icon: "↖", labelKey: "documents:viewer.tools.select" },
  { id: "pen", icon: "✎", labelKey: SHAPE_LABEL_KEYS.pen },
  { id: "rect", icon: "▭", labelKey: SHAPE_LABEL_KEYS.rect },
  { id: "cloud", icon: "☁", labelKey: SHAPE_LABEL_KEYS.cloud },
  { id: "arrow", icon: "↗", labelKey: SHAPE_LABEL_KEYS.arrow },
  { id: "text", icon: "T", labelKey: SHAPE_LABEL_KEYS.text },
];
const COLORS = ["#d92d20", "#f79009", "#12b76a", "#1f4e79", "#7a5af8", "#101828"];
const WIDTHS = [
  { value: 1, labelKey: "viewer.widths.thin", text: 10 },
  { value: 2, labelKey: "viewer.widths.medium", text: 14 },
  { value: 4, labelKey: "viewer.widths.thick", text: 20 },
] as const;
const STATUS_COLORS: Record<string, string> = { open: "#d92d20", in_progress: "#f79009", in_review: "#2e90fa", closed: "#12b76a" };
const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function PdfViewerPage() {
  const { t } = useTranslation(["documents", "common"]);
  const label = useLabel();
  const { confirm } = useAsk();
  const project = useProject();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { versionId } = useParams();
  const [params, setParams] = useSearchParams();
  const vid = versionId!;
  const pageNum = Math.max(1, Number(params.get("page")) || 1);

  const { data: info, error: infoError } = useLoad(() => api.versionInfo(project.id, vid), [project.id, vid]);
  const { data: file } = useLoad(
    () => (info ? documentsApi.file(project.id, info.fileId) : Promise.resolve(null)),
    [project.id, info?.fileId],
  );
  const { data: markups, setData: setMarkups } = useLoad(() => api.markups(project.id, vid), [project.id, vid]);
  const { data: links, reload: reloadLinks } = useLoad(() => api.versionIssueLinks(project.id, vid), [project.id, vid]);

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fit, setFit] = useState(true);
  // Narrow screens (≤ 900px, CSS) hide the side panel; "Ayrıntılar" opens it as a bottom sheet.
  const [panelOpen, setPanelOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [stageWidth, setStageWidth] = useState(800);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(COLORS[0]!);
  const [width, setWidth] = useState(2);
  const [selectedId, setSelectedId] = useState<string | null>(params.get("markup"));
  const [drawing, setDrawing] = useState<MarkupShape | null>(null);
  const [textAt, setTextAt] = useState<PdfPoint | null>(null);
  const [issueFor, setIssueFor] = useState<{ markup: MarkupDto | null } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  // Load the document.
  useEffect(() => {
    let destroyed = false;
    let task: { destroy(): Promise<void> } | null = null;
    setDoc(null);
    setPage(null);
    setError(null);
    void openPdf(viewersApi.pdfUrl(project.id, vid))
      .then((result) => {
        task = result;
        if (destroyed) return void result.destroy();
        setDoc(result.doc);
      })
      .catch((e: Error) => !destroyed && setError(i18n.t("documents:compare.errors.pdf", { error: e.message })));
    return () => {
      destroyed = true;
      void task?.destroy();
    };
  }, [project.id, vid]);

  const pageCount = doc?.numPages ?? 0;
  const goTo = useCallback(
    (n: number) =>
      setParams(
        (p) => {
          p.set("page", String(n));
          return p;
        },
        { replace: true },
      ),
    [setParams],
  );

  useEffect(() => {
    if (!doc) return;
    let alive = true;
    const n = Math.min(pageNum, doc.numPages);
    void doc.getPage(n).then((p) => alive && setPage(p), (e: Error) => setError(e.message));
    return () => {
      alive = false;
    };
  }, [doc, pageNum]);

  // Track the stage width for "fit width".
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageWidth(el.clientWidth));
    ro.observe(el);
    setStageWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const scale = useMemo(() => {
    if (!page) return zoom;
    if (!fit) return zoom;
    const base = page.getViewport({ scale: 1 }).width;
    return Math.max(0.1, (stageWidth - 56) / base);
  }, [page, fit, zoom, stageWidth]);
  const viewport: PageViewport | null = useMemo(() => page?.getViewport({ scale }) ?? null, [page, scale]);

  // Render the page into the canvas.
  useEffect(() => {
    if (!page || !viewport || !canvas.current) return;
    const c = canvas.current;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.floor(viewport.width * dpr);
    c.height = Math.floor(viewport.height * dpr);
    c.style.width = `${Math.floor(viewport.width)}px`;
    c.style.height = `${Math.floor(viewport.height)}px`;
    const task = page.render({
      canvas: c,
      canvasContext: c.getContext("2d")!,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    task.promise.catch((e: Error) => {
      if (e?.name !== "RenderingCancelledException") setError(e.message);
    });
    return () => task.cancel();
  }, [page, viewport]);

  const pr: Projection | null = useMemo(() => {
    if (!viewport) return null;
    return {
      scale: viewport.scale,
      toPx: (p) => viewport.convertToViewportPoint(p[0], p[1]) as Px,
      toPdf: (p) => {
        const [x, y] = viewport.convertToPdfPoint(p[0], p[1]) as [number, number];
        return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
      },
    };
  }, [viewport]);

  const pageMarkups = useMemo(() => (markups ?? []).filter((m) => m.page === pageNum), [markups, pageNum]);
  const selected = markups?.find((m) => m.id === selectedId) ?? null;
  const myDrafts = (markups ?? []).filter((m) => !m.published && m.authorId === user?.id);
  const linksByMarkup = useMemo(() => {
    const map = new Map<string, IssueLinkDto[]>();
    for (const l of links ?? []) if (l.kind === "markup") map.set(l.targetId, [...(map.get(l.targetId) ?? []), l]);
    return map;
  }, [links]);
  const canMarkup = !!info?.canMarkup;

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function save(shape: MarkupShape) {
    await act(async () => {
      const m = await api.createMarkup(project.id, vid, { page: pageNum, shapes: [shape] });
      setMarkups([...(markups ?? []), m]);
      setSelectedId(m.id);
    });
  }

  async function remove(m: MarkupDto) {
    if (!(await confirm({ title: t("viewer.deleteTitle"), message: t("viewer.deleteConfirm"), confirmLabel: t("common:actions.delete"), danger: true })))
      return;
    await act(async () => {
      await api.deleteMarkup(project.id, m.id);
      setMarkups((markups ?? []).filter((x) => x.id !== m.id));
      setSelectedId(null);
      reloadLinks();
    });
  }

  async function publish(list: MarkupDto[]) {
    await act(async () => {
      const done = new Map<string, MarkupDto>();
      for (const m of list) done.set(m.id, await api.publishMarkup(project.id, m.id));
      setMarkups((markups ?? []).map((m) => done.get(m.id) ?? m));
    });
  }

  // Keyboard: Delete removes the selected own markup, Esc cancels, PageUp/PageDown turn pages.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      if (e.key === "Escape") {
        setDrawing(null);
        setTool("select");
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected && selected.authorId === user?.id && canMarkup) {
        void remove(selected);
      } else if (e.key === "PageDown" && pageNum < pageCount) goTo(pageNum + 1);
      else if (e.key === "PageUp" && pageNum > 1) goTo(pageNum - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function pointerPx(e: ReactPointerEvent<SVGSVGElement>): Px {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (!pr || e.button !== 0) return;
    if (tool === "select") {
      setSelectedId(null);
      return;
    }
    if (!canMarkup) return;
    const p = pr.toPdf(pointerPx(e));
    if (tool === "text") {
      // Let the pointer-up finish before the editor takes focus.
      e.preventDefault();
      setTextAt(p);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === "pen") setDrawing({ type: "pen", color, width, points: [p] });
    else setDrawing({ type: tool, color, width, from: p, to: p });
  }

  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!drawing || !pr) return;
    const px = pointerPx(e);
    const p = pr.toPdf(px);
    if (drawing.type === "pen") {
      const last = pr.toPx(drawing.points[drawing.points.length - 1]!);
      if (Math.hypot(px[0] - last[0], px[1] - last[1]) < 2) return;
      setDrawing({ ...drawing, points: [...drawing.points, p] });
    } else if (drawing.type !== "text") {
      setDrawing({ ...drawing, to: p });
    }
  }

  function onPointerUp(e: ReactPointerEvent<SVGSVGElement>) {
    if (!drawing || !pr) return;
    let shape = drawing;
    // Keep the end point of a stroke even when no move event arrived for it.
    if (shape.type === "pen") shape = { ...shape, points: [...shape.points, pr.toPdf(pointerPx(e))] };
    setDrawing(null);
    const box = shapeBox(shape, pr);
    if (Math.max(box.w, box.h) < 4 || (shape.type === "pen" && shape.points.length < 2)) return;
    void save(shape);
  }

  function commitText(text: string) {
    const at = textAt;
    setTextAt(null);
    if (!at || !text.trim()) return;
    const size = WIDTHS.find((w) => w.value === width)?.text ?? 14;
    void save({ type: "text", color, width, at, text: text.trim(), size });
  }

  const versions = file?.versions ?? [];
  const versionLinks = (links ?? []).filter((l) => l.kind === "version");

  if (infoError) return <div className="page error">{infoError}</div>;

  return (
    <div className="viewer no-right pdf-viewer">
      {panelOpen && <div className="viewer-sheet-backdrop" onClick={() => setPanelOpen(false)} />}
      <aside className={`panel left${panelOpen ? " sheet-open" : ""}`} aria-label={t("viewer.details")}>
        <div className="viewer-sheet-head">
          <strong>{t("viewer.details")}</strong>
          <div className="spacer" />
          <button className="primary small" onClick={() => setPanelOpen(false)}>
            {t("common:actions.ok")}
          </button>
        </div>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <h3 style={{ margin: 0, wordBreak: "break-all", flex: 1 }}>📕 {info?.fileName ?? "…"}</h3>
        </div>
        {info && (
          <div className="row wrap small" style={{ margin: "8px 0" }}>
            <select
              value={vid}
              onChange={(e) => navigate(`/projects/${project.id}/view/${e.target.value}`)}
              style={{ width: "auto" }}
              aria-label={t("columns.version")}
            >
              {(versions.length ? versions : [{ id: vid, version: info.version }]).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.version === info.currentVersion ? t("compare.header.currentVersion", { version: v.version }) : `V${v.version}`}
                </option>
              ))}
            </select>
            {info.canDownload && (
              <a className="btn" href={documentsApi.downloadUrl(project.id, vid)}>
                {t("viewer.actions.download")}
              </a>
            )}
            <Link className="btn" to={`/projects/${project.id}/files/${info.folderId}`}>
              {t("common:fields.folder")}
            </Link>
            {webCapability("cost.takeoff") && (
              <Link className="btn" to={`/projects/${project.id}/takeoff/${vid}${pageNum > 1 ? `?page=${pageNum}` : ""}`} title={t("viewer.takeoffHint")}>
                {t("viewer.actions.takeoff")}
              </Link>
            )}
            {versions.some((v) => v.version < info.version) && (
              <Link className="btn" to={`/projects/${project.id}/compare?to=${vid}`} title={t("viewer.compareHint")}>
                {t("drawer.actions.compareRevision")}
              </Link>
            )}
          </div>
        )}
        {info && info.version !== info.currentVersion && (
          <p className="notice small">{t("viewer.oldVersion", { version: info.version, current: info.currentVersion })}</p>
        )}
        {!canMarkup && info && <p className="muted small">{t("viewer.noMarkupPermission")}</p>}
        {msg && <p className="error small">{msg}</p>}

        {selected && (
          <div className="card" style={{ padding: 10, margin: "10px 0" }}>
            <div className="row">
              <strong className="small">{t("viewer.selected.heading")}</strong>
              <div className="spacer" />
              <span className={`badge ${selected.published ? "ok" : "warn"}`}>{selected.published ? t("viewer.status.published") : t("viewer.status.draft")}</span>
            </div>
            <div className="small muted" style={{ margin: "4px 0 8px" }}>
              {selected.shapes.map((s) => t(SHAPE_LABEL_KEYS[s.type])).join(", ")} · {selected.authorName} · {formatDate(selected.createdAt)}
            </div>
            <div className="row wrap">
              {selected.authorId === user?.id && canMarkup && !selected.published && (
                <button className="small primary" onClick={() => void publish([selected])}>
                  {t("viewer.actions.publish")}
                </button>
              )}
              <button className="small" onClick={() => setIssueFor({ markup: selected })}>
                {t("viewer.actions.createIssue")}
              </button>
              {selected.authorId === user?.id && canMarkup && (
                <button className="small danger" onClick={() => void remove(selected)}>
                  {t("common:actions.delete")}
                </button>
              )}
            </div>
            {(linksByMarkup.get(selected.id) ?? []).map((l) => (
              <div key={l.id} className="small" style={{ marginTop: 6 }}>
                <Link to={`/projects/${project.id}/issues/${l.issueId}`}>
                  #{l.issue?.number} {l.issue?.title}
                </Link>
              </div>
            ))}
          </div>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <h3 style={{ margin: 0 }}>{t("viewer.markups.heading")}</h3>
          <div className="spacer" />
          {myDrafts.length > 0 && canMarkup && (
            <button className="small" onClick={() => void publish(myDrafts)} title={t("viewer.publishDraftsHint")}>
              {t("viewer.actions.publishDrafts", { count: myDrafts.length })}
            </button>
          )}
        </div>
        {markups?.length === 0 && <p className="muted small">{canMarkup ? t("viewer.markups.emptyCanDraw") : t("viewer.markups.empty")}</p>}
        {(markups ?? []).map((m) => (
          <div
            key={m.id}
            className="model-item small"
            style={{ cursor: "pointer", background: m.id === selectedId ? "var(--primary-soft)" : undefined }}
            onClick={() => {
              setSelectedId(m.id);
              setTool("select");
              if (m.page !== pageNum) goTo(m.page);
            }}
          >
            <span style={{ width: 10, height: 10, borderRadius: 2, background: m.shapes[0]?.color, marginTop: 3, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div>
                {m.shapes.map((s) => t(SHAPE_LABEL_KEYS[s.type])).join(", ")}
                {m.shapes[0]?.type === "text" && <span className="muted"> “{m.shapes[0].text.slice(0, 40)}”</span>}
              </div>
              <div className="muted">
                {t("compare.ai.pageShort", { page: m.page })} · {m.authorName} {!m.published && <span className="badge warn">{t("viewer.status.draft")}</span>}
                {(linksByMarkup.get(m.id)?.length ?? 0) > 0 && <span className="badge info">⚑ {linksByMarkup.get(m.id)!.length}</span>}
              </div>
            </div>
          </div>
        ))}

        <h3 style={{ marginTop: 16 }}>{t("viewer.links.heading")}</h3>
        {(links ?? []).length === 0 && <p className="muted small">{t("viewer.links.empty")}</p>}
        {[...versionLinks, ...(links ?? []).filter((l) => l.kind === "markup")].map((l) => (
          <Link key={l.id} to={`/projects/${project.id}/issues/${l.issueId}`} className="model-item small" style={{ color: "inherit" }}>
            <span style={{ width: 10, height: 10, borderRadius: 5, background: STATUS_COLORS[l.issue?.status ?? "open"], marginTop: 3, flexShrink: 0 }} />
            <div>
              <strong>#{l.issue?.number}</strong> {l.issue?.title}
              <div className="muted">
                {l.issue && label("issueStatus", l.issue.status)} · {l.kind === "markup" ? t("viewer.links.markup") : t("viewer.links.version")}
              </div>
            </div>
          </Link>
        ))}
        <button className="small" style={{ marginTop: 8 }} onClick={() => setIssueFor({ markup: null })}>
          {t("viewer.actions.issueOnVersion")}
        </button>
      </aside>

      <div className="canvas-wrap pdf-wrap">
        <div className="pdf-toolbar">
          <button className="small narrow-only-btn" onClick={() => setPanelOpen(true)} aria-haspopup="dialog">
            {t("viewer.actions.details")}
          </button>
          <button className="small" disabled={pageNum <= 1} onClick={() => goTo(pageNum - 1)} aria-label={t("compare.stage.previousPage")}>
            ◀
          </button>
          <input
            className="pdf-page-input"
            value={pageNum}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (n >= 1 && n <= pageCount) goTo(n);
            }}
            aria-label={t("viewer.page")}
          />
          <span className="muted small">/ {pageCount || "…"}</span>
          <button className="small" disabled={!pageCount || pageNum >= pageCount} onClick={() => goTo(pageNum + 1)} aria-label={t("compare.stage.nextPage")}>
            ▶
          </button>
          <span className="pdf-sep" />
          <button
            className="small"
            onClick={() => {
              setFit(false);
              setZoom(ZOOMS.slice().reverse().find((z) => z < scale - 0.01) ?? ZOOMS[0]!);
            }}
            aria-label={t("compare.stage.zoomOut")}
          >
            −
          </button>
          <span className="small" style={{ minWidth: 44, textAlign: "center" }}>
            {Math.round(scale * 100)}%
          </span>
          <button
            className="small"
            onClick={() => {
              setFit(false);
              setZoom(ZOOMS.find((z) => z > scale + 0.01) ?? ZOOMS[ZOOMS.length - 1]!);
            }}
            aria-label={t("compare.stage.zoomIn")}
          >
            +
          </button>
          <button className={`small${fit ? " active" : ""}`} onClick={() => setFit(true)}>
            {t("viewer.actions.fitWidth")}
          </button>
          <span className="pdf-sep" />
          {TOOLS.map((item) => (
            <button
              key={item.id}
              className={`small tool${tool === item.id ? " active" : ""}`}
              title={t(item.labelKey)}
              disabled={item.id !== "select" && !canMarkup}
              onClick={() => setTool(item.id)}
            >
              <span style={{ fontWeight: 700 }}>{item.icon}</span> {t(item.labelKey)}
            </button>
          ))}
          {canMarkup && (
            <>
              <span className="pdf-sep" />
              {COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch${color === c ? " active" : ""}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={t("viewer.colour", { colour: c })}
                />
              ))}
              <select value={width} onChange={(e) => setWidth(Number(e.target.value))} style={{ width: "auto", padding: "2px 6px" }} aria-label={t("viewer.width")}>
                {WIDTHS.map((w) => (
                  <option key={w.value} value={w.value}>
                    {t(w.labelKey)}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
        <div ref={stage} className="pdf-stage">
          {error && <p className="error" style={{ margin: 16 }}>{error}</p>}
          {!doc && !error && <p className="muted" style={{ margin: 16 }}>{t("pdfPages.loading")}</p>}
          <div className="pdf-sheet" style={viewport ? { width: Math.floor(viewport.width), height: Math.floor(viewport.height) } : { display: "none" }}>
            <canvas ref={canvas} />
            {pr && viewport && (
              <svg
                className={`pdf-overlay tool-${tool}`}
                width={Math.floor(viewport.width)}
                height={Math.floor(viewport.height)}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              >
                {pageMarkups.map((m) => (
                  <g
                    key={m.id}
                    opacity={m.published ? 1 : 0.75}
                    style={{ cursor: tool === "select" ? "pointer" : undefined }}
                    onPointerDown={(e) => {
                      if (tool !== "select") return;
                      e.stopPropagation();
                      setSelectedId(m.id);
                    }}
                  >
                    {m.shapes.map((s, i) => (
                      <ShapeSvg key={i} shape={s} pr={pr} hit={tool === "select"} />
                    ))}
                  </g>
                ))}
                {selected && selected.page === pageNum && <SelectionBox markup={selected} pr={pr} />}
                {drawing && <ShapeSvg shape={drawing} pr={pr} />}
              </svg>
            )}
            {pr && textAt && (
              <textarea
                autoFocus
                className="pdf-text-editor"
                placeholder={t("viewer.textPlaceholder")}
                style={{
                  left: pr.toPx(textAt)[0],
                  top: pr.toPx(textAt)[1],
                  color,
                  fontSize: (WIDTHS.find((w) => w.value === width)?.text ?? 14) * pr.scale,
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    commitText(e.currentTarget.value);
                  } else if (e.key === "Escape") setTextAt(null);
                }}
                onBlur={(e) => commitText(e.currentTarget.value)}
              />
            )}
            {pr &&
              pageMarkups.map((m) => {
                const l = linksByMarkup.get(m.id);
                if (!l?.length) return null;
                const b = unionBox(m.shapes.map((s) => shapeBox(s, pr)));
                return (
                  <div key={m.id} className="pdf-issue-badges" style={{ left: b.x + b.w, top: b.y - 10 }}>
                    {l.map((x) => (
                      <Link
                        key={x.id}
                        to={`/projects/${project.id}/issues/${x.issueId}`}
                        className="badge"
                        style={{ background: STATUS_COLORS[x.issue?.status ?? "open"], color: "#fff", borderColor: "transparent" }}
                        title={`${x.issue?.title ?? ""} (${x.issue ? label("issueStatus", x.issue.status) : ""})`}
                      >
                        #{x.issue?.number}
                      </Link>
                    ))}
                  </div>
                );
              })}
          </div>
        </div>
      </div>

      {issueFor && info && (
        <MarkupIssueDialogComponent
          markup={issueFor.markup}
          fileName={info.fileName}
          version={info.version}
          versionId={vid}
          page={issueFor.markup?.page ?? pageNum}
          onClose={() => setIssueFor(null)}
          onCreated={(published) => {
            if (published) setMarkups((markups ?? []).map((m) => (m.id === published.id ? published : m)));
            reloadLinks();
          }}
        />
      )}
    </div>
  );
}

function SelectionBox({ markup, pr }: { markup: MarkupDto; pr: Projection }) {
  const b = unionBox(markup.shapes.map((s) => shapeBox(s, pr)));
  const pad = 6;
  return (
    <rect
      x={b.x - pad}
      y={b.y - pad}
      width={b.w + pad * 2}
      height={b.h + pad * 2}
      fill="none"
      stroke="#2e90fa"
      strokeWidth={1.5}
      strokeDasharray="5 4"
      pointerEvents="none"
    />
  );
}

/** Same dialog as components/MarkupIssueDialog (kept exported from here for older imports). */
export { MarkupIssueDialog } from "../components/MarkupIssueDialog";
