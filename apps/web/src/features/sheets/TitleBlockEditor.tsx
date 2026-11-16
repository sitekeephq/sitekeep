/**
 * Title-block template editor (docs/features/SHEETS.md, "Title-block template"): a project
 * administrator draws the title-block rectangle on a sample sheet, then a sub-region or a label
 * keyword for each field (number, title, revision, discipline, date). One template per paper
 * orientation; coordinates are page-relative so every paper size of that orientation fits.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  TITLE_BLOCK_FIELDS,
  normalizeRelBox,
  normalizeTitleBlockTemplate,
  pageOrientation,
  type DrawingSheetDto,
  type RelBox,
  type SheetTemplatePreviewDto,
  type TitleBlockFieldKey,
  type TitleBlockFieldRule,
  type TitleBlockRegion,
  type TitleBlockTemplate,
} from "@sitekeep/shared";
import { openPdf, renderPage } from "../../pdf/pdfjs";
import { viewersApi } from "../../shared/api/api-viewers";
import { useLoad } from "../../app/context/project";
import { Dialog } from "../../shared/ui/Dialog";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { formatDate } from "../../shared/lib/format";
import { sheetsApi } from "./api";
import { OcrBadge } from "./OcrBadge";

type Tool = "region" | TitleBlockFieldKey;

const FULL: RelBox = { x0: 0, y0: 0, x1: 1, y1: 1 };
/** Width of the drawing area (CSS px). */
const VIEW_WIDTH = 760;

interface Rendered {
  url: string;
  /** Page size in PDF points. */
  width: number;
  height: number;
}

/** Margin around the title block when zoomed in. */
function zoomBox(b: RelBox): RelBox {
  const mx = (b.x1 - b.x0) * 0.08;
  const my = (b.y1 - b.y0) * 0.08;
  return { x0: Math.max(0, b.x0 - mx), y0: Math.max(0, b.y0 - my), x1: Math.min(1, b.x1 + mx), y1: Math.min(1, b.y1 + my) };
}

export function TitleBlockEditor({ pid, sheet, onClose, onSaved }: { pid: string; sheet: DrawingSheetDto; onClose(): void; onSaved(message: string): void }) {
  const { t } = useTranslation(["sheets", "common"]);
  const settings = useLoad(() => sheetsApi.settings(pid), [pid]);
  const [page, setPage] = useState<Rendered | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [region, setRegion] = useState<TitleBlockRegion | null>(null);
  const [tool, setTool] = useState<Tool>("region");
  const [zoom, setZoom] = useState(false);
  const [preview, setPreview] = useState<SheetTemplatePreviewDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedFor = useRef<string | null>(null);
  const orientation = page ? pageOrientation(page.width, page.height) : null;

  // The page, rendered once at a resolution sharp enough for the zoomed title block.
  useEffect(() => {
    let alive = true;
    let release: (() => Promise<void>) | null = null;
    (async () => {
      const { doc, destroy } = await openPdf(viewersApi.pdfUrl(pid, sheet.versionId));
      release = destroy;
      const p = await doc.getPage(Math.min(sheet.page, doc.numPages));
      const base = p.getViewport({ scale: 1 });
      // About 3× the view width: the zoomed title block (a third of the page or more) stays sharp.
      const scale = Math.min((VIEW_WIDTH * 3) / base.width, 6000 / Math.max(base.width, base.height));
      const canvas = await renderPage(p, scale);
      p.cleanup();
      if (alive) setPage({ url: canvas.toDataURL("image/png"), width: base.width, height: base.height });
    })().catch((e: unknown) => alive && setRenderError((e as Error).message));
    return () => {
      alive = false;
      void release?.().catch(() => undefined);
    };
  }, [pid, sheet.versionId, sheet.page]);

  // The saved region of this orientation, once both the settings and the page are there.
  useEffect(() => {
    if (!settings.data || !orientation || loadedFor.current === orientation) return;
    loadedFor.current = orientation;
    const saved = settings.data.titleBlock?.[orientation] ?? null;
    setRegion(saved);
    if (saved) {
      setZoom(true);
      setTool("number");
    }
  }, [settings.data, orientation]);

  if (settings.error) return <Dialog title={t("template.title")} onClose={onClose} wide><div className="error">{settings.error}</div></Dialog>;

  const view = zoom && region ? zoomBox(region.box) : FULL;
  const rule = (key: TitleBlockFieldKey): TitleBlockFieldRule => region?.fields.find((f) => f.key === key) ?? { key, box: null, label: null };
  const setRule = (key: TitleBlockFieldKey, patch: Partial<TitleBlockFieldRule>) => {
    if (!region) return;
    const next = { ...rule(key), ...patch };
    const others = region.fields.filter((f) => f.key !== key);
    setRegion({ ...region, fields: TITLE_BLOCK_FIELDS.map((k) => (k === key ? next : others.find((f) => f.key === k))).filter((f): f is TitleBlockFieldRule => !!f) });
    setPreview(null);
  };

  function draw(box: RelBox) {
    if (tool === "region") {
      setRegion({ box, fields: region?.fields ?? [] });
      setPreview(null);
      setTool("number");
      setZoom(true);
    } else if (region) setRule(tool, { box });
  }

  /** The project's template with this orientation's region replaced (null when none is left). */
  function template(): TitleBlockTemplate | null {
    if (!orientation || !settings.data) return null;
    const current = settings.data.titleBlock ?? { landscape: null, portrait: null };
    return normalizeTitleBlockTemplate({ ...current, [orientation]: region, sample: { versionId: sheet.versionId, page: sheet.page } });
  }

  async function test() {
    const tb = template();
    if (!tb) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await sheetsApi.templatePreview(pid, sheet.id, tb));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save(readAgain: boolean) {
    if (!orientation || !settings.data) return;
    setBusy(true);
    setError(null);
    try {
      // Without a region the template of this orientation is removed (the other one stays).
      await sheetsApi.saveSettings(pid, { titleBlock: template() });
      if (readAgain) {
        const r = await sheetsApi.rescan(pid);
        onSaved(t("template.savedReading", { count: r.queued }));
      } else onSaved(t("template.saved"));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog title={t("template.title")} onClose={onClose} wide>
      <div className="titleblock-editor">
        <div className="titleblock-stage">
          {renderError && <div className="error">{renderError}</div>}
          {!page && !renderError && <LoadingIndicator />}
          {page && (
            <DrawArea
              page={page}
              view={view}
              region={region}
              tool={tool}
              onDraw={draw}
            />
          )}
          <p className="muted small">{t(tool === "region" ? "template.hintRegion" : "template.hintField", { field: tool === "region" ? "" : t(`template.fields.${tool}`) })}</p>
        </div>
        <div className="titleblock-panel stack">
          {orientation && <p className="muted small" style={{ margin: 0 }}>{t(`template.appliesTo.${orientation}`)}</p>}
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            <button type="button" className={tool === "region" ? "primary" : ""} onClick={() => { setTool("region"); setZoom(false); }} data-testid="titleblock-tool-region">
              {region ? t("template.redrawRegion") : t("template.drawRegion")}
            </button>
            {region && (
              <button type="button" onClick={() => setZoom((z) => !z)}>
                {zoom ? t("template.wholeSheet") : t("template.zoom")}
              </button>
            )}
          </div>
          {region ? (
            <table className="titleblock-fields">
              <thead>
                <tr>
                  <th>{t("template.field")}</th>
                  <th>{t("template.area")}</th>
                  <th>{t("template.label")}</th>
                </tr>
              </thead>
              <tbody>
                {TITLE_BLOCK_FIELDS.map((key) => {
                  const r = rule(key);
                  return (
                    <tr key={key} className={tool === key ? "active" : ""}>
                      <td>{t(`template.fields.${key}`)}</td>
                      <td>
                        <div className="row" style={{ gap: 4 }}>
                          <button type="button" className={`small${tool === key ? " primary" : ""}`} onClick={() => setTool(key)} data-testid={`titleblock-tool-${key}`}>
                            {r.box ? t("template.redraw") : t("template.draw")}
                          </button>
                          {r.box && (
                            <button type="button" className="small ghost" onClick={() => setRule(key, { box: null })} aria-label={t("template.clearArea", { field: t(`template.fields.${key}`) })}>
                              ×
                            </button>
                          )}
                        </div>
                      </td>
                      <td>
                        <input
                          value={r.label ?? ""}
                          onChange={(e) => setRule(key, { label: e.target.value })}
                          placeholder={t(`template.labelExamples.${key}`)}
                          maxLength={60}
                          aria-label={t("template.labelFor", { field: t(`template.fields.${key}`) })}
                          data-testid={`titleblock-label-${key}`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="muted">{t("template.noRegion")}</p>
          )}
          <p className="muted small" style={{ margin: 0 }}>{t("template.fallback")}</p>
          {preview && (
            <div className="card titleblock-preview" data-testid="titleblock-preview">
              <strong>{t("template.previewTitle")}</strong> <OcrBadge sheet={preview} />
              <dl className="sheet-meta">
                <dt>{t("columns.number")}</dt>
                <dd>{preview.number}</dd>
                <dt>{t("columns.title")}</dt>
                <dd>{preview.title ?? "—"}</dd>
                <dt>{t("columns.revision")}</dt>
                <dd>{preview.revision ?? "—"}</dd>
                <dt>{t("columns.discipline")}</dt>
                <dd>{preview.discipline ?? "—"}</dd>
                <dt>{t("columns.date")}</dt>
                <dd>{preview.date ? formatDate(preview.date) : "—"}</dd>
              </dl>
            </div>
          )}
          {error && <div className="error">{error}</div>}
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            <button type="button" onClick={test} disabled={busy || !region || sheet.format !== "pdf"} data-testid="titleblock-test">
              {t("template.test")}
            </button>
            <span className="spacer" />
            <button type="button" onClick={onClose}>
              {t("common:actions.cancel")}
            </button>
            {!region && settings.data?.titleBlock?.[orientation ?? "landscape"] ? (
              <button type="button" className="danger" onClick={() => save(true)} disabled={busy}>
                {t("template.remove")}
              </button>
            ) : (
              <>
                <button type="button" onClick={() => save(false)} disabled={busy || !region}>
                  {t("common:actions.save")}
                </button>
                <button type="button" className="primary" onClick={() => save(true)} disabled={busy || !region} data-testid="titleblock-save-read">
                  {t("template.saveAndRead")}
                </button>
              </>
            )}
          </div>
          {region && (
            <button type="button" className="ghost small" onClick={() => { setRegion(null); setPreview(null); setTool("region"); setZoom(false); }}>
              {t("template.clear")}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

const pct = (v: number) => `${v * 100}%`;

/** The page (or the zoomed title block) with the rectangles; dragging draws a rectangle for the tool. */
function DrawArea({ page, view, region, tool, onDraw }: { page: Rendered; view: RelBox; region: TitleBlockRegion | null; tool: Tool; onDraw(box: RelBox): void }) {
  const { t } = useTranslation("sheets");
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ start: { x: number; y: number }; box: RelBox } | null>(null);
  const vw = view.x1 - view.x0;
  const vh = view.y1 - view.y0;
  const aspect = (vw * page.width) / (vh * page.height);

  const toRel = (e: ReactPointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    return { x: view.x0 + fx * vw, y: view.y0 + fy * vh };
  };
  const place = (b: RelBox) => ({ left: pct((b.x0 - view.x0) / vw), top: pct((b.y0 - view.y0) / vh), width: pct((b.x1 - b.x0) / vw), height: pct((b.y1 - b.y0) / vh) });

  return (
    <div
      ref={ref}
      className={`titleblock-area tool-${tool}`}
      style={{ aspectRatio: String(aspect), maxWidth: VIEW_WIDTH }}
      data-testid="titleblock-area"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = toRel(e);
        setDrag({ start: p, box: { x0: p.x, y0: p.y, x1: p.x, y1: p.y } });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const p = toRel(e);
        setDrag({ ...drag, box: { x0: drag.start.x, y0: drag.start.y, x1: p.x, y1: p.y } });
      }}
      onPointerUp={() => {
        if (!drag) return;
        const box = normalizeRelBox(drag.box);
        setDrag(null);
        if (box) onDraw(box);
      }}
    >
      <img
        src={page.url}
        alt=""
        draggable={false}
        style={{ position: "absolute", left: pct(-view.x0 / vw), top: pct(-view.y0 / vh), width: pct(1 / vw), height: pct(1 / vh), maxWidth: "none" }}
      />
      {region && <div className="titleblock-box region" style={place(region.box)} data-testid="titleblock-region" />}
      {region?.fields
        .filter((f) => f.box)
        .map((f) => (
          <div key={f.key} className={`titleblock-box field${tool === f.key ? " active" : ""}`} style={place(f.box!)}>
            <span>{t(`template.fields.${f.key}`)}</span>
          </div>
        ))}
      {drag && <div className="titleblock-box drawing" style={place({ x0: Math.min(drag.box.x0, drag.box.x1), y0: Math.min(drag.box.y0, drag.box.y1), x1: Math.max(drag.box.x0, drag.box.x1), y1: Math.max(drag.box.y0, drag.box.y1) })} />}
    </div>
  );
}
