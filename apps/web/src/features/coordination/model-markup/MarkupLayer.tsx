/**
 * Model markups on the viewer canvas: pins that follow the model, the drawing of the markup whose
 * viewpoint is shown, and the pin / drawing tools. Drawings live in view units (centre origin,
 * 1/1000 of the view height), so they fit the restored camera in a window of any width.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import * as THREE from "three";
import {
  MODEL_MARKUP_COLORS,
  MODEL_MARKUP_VIEW_UNITS,
  pxToView,
  rebasePoint,
  viewToPx,
  type MarkupShape,
  type MarkupShapeType,
  type ModelMarkupDto,
  type PdfPoint,
} from "@sitekeep/shared";
import { SHAPE_LABEL_KEYS, ShapeSvg, shapeBox, type Projection, type Px } from "../../../pdf/shapes";
import { composeSnapshot } from "./snapshot";
import type { ModelMarkups } from "./useModelMarkups";
import "./model-markup.css";

const TOOLS: { id: MarkupShapeType; icon: string }[] = [
  { id: "pen", icon: "✎" },
  { id: "arrow", icon: "↗" },
  { id: "cloud", icon: "☁" },
  { id: "rect", icon: "▭" },
  { id: "text", icon: "T" },
];
/** Stroke width and text size in view units. */
const STROKE = 4;
const TEXT_SIZE = 26;
const NAV_KEYS = new Set(["w", "a", "s", "d", "q", "e", "arrowup", "arrowdown", "arrowleft", "arrowright", "f", "1", "2", "3"]);

export function MarkupLayer({ mm, visible }: { mm: ModelMarkups; visible: boolean }) {
  const { t } = useTranslation(["modelMarkup", "documents"]);
  const layer = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tool, setTool] = useState<MarkupShapeType>("pen");
  const [shapes, setShapes] = useState<MarkupShape[]>([]);
  const [drawing, setDrawing] = useState<MarkupShape | null>(null);
  const [textAt, setTextAt] = useState<PdfPoint | null>(null);
  const [busy, setBusy] = useState(false);
  const { engine, mode } = mm;

  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const pr: Projection | null = useMemo(
    () =>
      size.h > 0
        ? { toPx: (p) => viewToPx(p, size.w, size.h), toPdf: (p) => pxToView(p, size.w, size.h), scale: size.h / MODEL_MARKUP_VIEW_UNITS }
        : null,
    [size.w, size.h],
  );

  // A new drawing starts empty; leaving the drawing mode drops what was not saved.
  useEffect(() => {
    setShapes([]);
    setDrawing(null);
    setTextAt(null);
  }, [mode]);

  // The drawing belongs to its camera: moving the view hides it.
  useEffect(() => {
    const host = layer.current?.parentElement;
    if (!host || !mm.shownId || mode) return;
    const hide = (e: Event) => {
      if ((e.target as Element | null)?.closest?.(".mm-ui")) return;
      mm.hideOverlay();
    };
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (NAV_KEYS.has(e.key.toLowerCase())) mm.hideOverlay();
    };
    host.addEventListener("pointerdown", hide, true);
    host.addEventListener("wheel", hide, { capture: true, passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      host.removeEventListener("pointerdown", hide, true);
      host.removeEventListener("wheel", hide, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [mm.shownId, mode, mm.hideOverlay]);

  // Pin mode: one click on the model.
  useEffect(() => {
    if (!engine || mode !== "pin") return;
    let alive = true;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      engine.cancelPick();
      mm.setMode(null);
    };
    window.addEventListener("keydown", onEsc);
    void engine.pickPoint().then(async (hit) => {
      window.removeEventListener("keydown", onEsc);
      if (!alive) return;
      if (!hit) return mm.setMode(null);
      if (!mm.markupVersions.includes(hit.modelId)) {
        mm.setError(t("noPermission"));
        return mm.setMode(null);
      }
      setBusy(true);
      try {
        const vp = await engine.viewpoint();
        const at = project(engine, hit.point, size);
        const snapshot = await composeSnapshot(vp.snapshot, { pin: at ? { ...at, color: mm.color } : null, width: size.w, height: size.h });
        mm.setPending({
          kind: "pin",
          versionId: hit.modelId,
          viewpoint: { ...vp, snapshot },
          anchor: { point: hit.point, globalId: hit.globalId, fileVersionId: hit.modelId },
          color: mm.color,
        });
      } finally {
        setBusy(false);
        mm.setMode(null);
      }
    });
    return () => {
      alive = false;
      window.removeEventListener("keydown", onEsc);
      engine.cancelPick();
    };
  }, [engine, mode]);

  // Pins follow the camera: positions are written straight to the DOM every frame.
  const pins = useMemo(
    () =>
      visible
        ? (mm.list?.current ?? []).filter((m) => m.kind === "pin" && m.anchor && (m.status === "open" || m.id === mm.active?.id))
        : [],
    [visible, mm.list, mm.active?.id],
  );
  const pinEls = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (!engine || !pins.length || !mm.frame) return;
    let raf = 0;
    const v = new THREE.Vector3();
    const tick = () => {
      const cam = engine.world.camera.three;
      const el = layer.current;
      if (el) {
        const w = el.clientWidth;
        const h = el.clientHeight;
        for (const m of pins) {
          const btn = pinEls.current.get(m.id);
          if (!btn) continue;
          const p = rebasePoint(m.anchor!.point, m.viewpoint.sceneOffset, mm.frame!);
          v.set(p[0], p[1], p[2]).project(cam);
          const on = v.z > -1 && v.z < 1 && Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05;
          btn.style.display = on ? "" : "none";
          if (on) btn.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, pins, mm.frame]);

  const shown: ModelMarkupDto | null = mm.active && mm.shownId === mm.active.id ? mm.active : null;

  function pointerPx(e: ReactPointerEvent<SVGSVGElement>): Px {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (mode !== "draw" || !pr || e.button !== 0 || busy) return;
    const p = pr.toPdf(pointerPx(e));
    if (tool === "text") {
      e.preventDefault();
      setTextAt(p);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === "pen") setDrawing({ type: "pen", color: mm.color, width: STROKE, points: [p] });
    else setDrawing({ type: tool, color: mm.color, width: STROKE, from: p, to: p });
  }

  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!drawing || !pr) return;
    const px = pointerPx(e);
    const p = pr.toPdf(px);
    if (drawing.type === "pen") {
      const last = pr.toPx(drawing.points[drawing.points.length - 1]!);
      if (Math.hypot(px[0] - last[0], px[1] - last[1]) < 2) return;
      setDrawing({ ...drawing, points: [...drawing.points, p] });
    } else if (drawing.type !== "text") setDrawing({ ...drawing, to: p });
  }

  function onPointerUp(e: ReactPointerEvent<SVGSVGElement>) {
    if (!drawing || !pr) return;
    let shape = drawing;
    if (shape.type === "pen") shape = { ...shape, points: [...shape.points, pr.toPdf(pointerPx(e))] };
    setDrawing(null);
    const box = shapeBox(shape, pr);
    if (Math.max(box.w, box.h) < 4 || (shape.type === "pen" && shape.points.length < 2)) return;
    setShapes((s) => [...s, shape]);
  }

  function commitText(text: string) {
    const at = textAt;
    setTextAt(null);
    if (!at || !text.trim()) return;
    setShapes((s) => [...s, { type: "text", color: mm.color, width: STROKE, at, text: text.trim(), size: TEXT_SIZE }]);
  }

  async function save() {
    if (!engine || !shapes.length) return;
    const versionId = mm.markupVersions[0];
    if (!versionId) return mm.setError(t("noPermission"));
    setBusy(true);
    try {
      const vp = await engine.viewpoint();
      const snapshot = await composeSnapshot(vp.snapshot, { svg: svg.current, width: size.w, height: size.h });
      mm.setPending({ kind: "drawing", versionId, viewpoint: { ...vp, snapshot }, shapes, color: shapes[0]!.color });
    } finally {
      setBusy(false);
    }
  }

  const drawMode = mode === "draw";
  const shownShapes = drawMode ? shapes : shown?.kind === "drawing" ? shown.shapes : [];

  return (
    <div ref={layer} className={`mm-layer${drawMode ? " drawing" : ""}`}>
      {pr && (drawMode || shownShapes.length > 0) && (
        <svg
          ref={svg}
          className="mm-overlay"
          width={size.w}
          height={size.h}
          aria-label={t("panel")}
          data-markup={shown?.id ?? (drawMode ? "draft" : undefined)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {shownShapes.map((s, i) => (
            <ShapeSvg key={i} shape={s} pr={pr} />
          ))}
          {drawing && <ShapeSvg shape={drawing} pr={pr} />}
        </svg>
      )}
      {pr && textAt && (
        <textarea
          autoFocus
          className="pdf-text-editor mm-ui"
          placeholder={t("textPlaceholder")}
          style={{ left: pr.toPx(textAt)[0], top: pr.toPx(textAt)[1], color: mm.color, fontSize: TEXT_SIZE * pr.scale }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commitText(e.currentTarget.value);
            } else if (e.key === "Escape") setTextAt(null);
          }}
          onBlur={(e) => commitText(e.currentTarget.value)}
        />
      )}
      {pins.map((m) => (
        <button
          key={m.id}
          ref={(el) => {
            if (el) pinEls.current.set(m.id, el);
            else pinEls.current.delete(m.id);
          }}
          type="button"
          className={`mm-pin mm-ui${m.id === mm.active?.id ? " active" : ""}${m.anchor?.missing ? " missing" : ""}${m.status === "closed" ? " closed" : ""}`}
          style={{ background: m.color, display: "none" }}
          title={m.title || t("untitled")}
          aria-label={`📍 ${m.title || t("untitled")}`}
          onClick={() => mm.select(m.id)}
        />
      ))}
      {(mode === "pin" || busy) && <div className="mm-hint mm-ui">{busy ? t("saving") : t("pickPin")}</div>}
      {drawMode && (
        <div className="mm-toolbar mm-ui" role="toolbar" aria-label={t("actions.draw")}>
          {TOOLS.map((x) => (
            <button
              key={x.id}
              type="button"
              className={`small tool${tool === x.id ? " active" : ""}`}
              title={t(SHAPE_LABEL_KEYS[x.id])}
              aria-pressed={tool === x.id}
              onClick={() => setTool(x.id)}
            >
              <span aria-hidden>{x.icon}</span> <span className="mm-tool-label">{t(SHAPE_LABEL_KEYS[x.id])}</span>
            </button>
          ))}
          <span className="pdf-sep" />
          {MODEL_MARKUP_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`swatch${mm.color === c ? " active" : ""}`}
              style={{ background: c }}
              onClick={() => mm.setColor(c)}
              aria-label={t("colour", { colour: c })}
            />
          ))}
          <span className="pdf-sep" />
          <button type="button" className="small" disabled={!shapes.length || busy} onClick={() => setShapes((s) => s.slice(0, -1))}>
            {t("actions.undo")}
          </button>
          <button type="button" className="small" onClick={() => mm.setMode(null)}>
            {t("actions.cancel")}
          </button>
          <button type="button" className="small primary" disabled={!shapes.length || busy} onClick={() => void save()}>
            {t("actions.save")}
          </button>
        </div>
      )}
      {drawMode && !shapes.length && !drawing && <div className="mm-hint mm-ui">{t("drawHint")}</div>}
    </div>
  );
}

/** Scene point → pixels of the layer (null when behind the camera). */
function project(engine: NonNullable<ModelMarkups["engine"]>, p: [number, number, number], size: { w: number; h: number }) {
  const v = new THREE.Vector3(...p).project(engine.world.camera.three);
  if (v.z <= -1 || v.z >= 1) return null;
  return { x: ((v.x + 1) / 2) * size.w, y: ((1 - v.y) / 2) * size.h };
}
