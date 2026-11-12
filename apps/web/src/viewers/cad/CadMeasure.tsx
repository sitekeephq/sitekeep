/**
 * Measuring and inspection layer of the DWG/DXF viewer: Uzunluk, Zincir Uzunluk, Alan, Açı,
 * Koordinat and Bilgi with snapping (Yakalama), drawing units and the result list. Works on the
 * viewer's scene after load (whatever built it): pointer events of the canvas, the camera for
 * screen ↔ drawing coordinates and the scene geometry for snapping. Points are kept in true
 * drawing coordinates (viewer origin added back), so they survive a reload of the scene.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { DxfViewer } from "dxf-viewer";
import { Trans, useTranslation } from "react-i18next";
import * as THREE from "three";
import type { Pt } from "./geometry";
import { clipboardText, describe, hintText, minPoints, pointsNeeded, toolLabel, type Measurement, type MeasureTool, type ToolKey } from "./measure";
import { sceneSources, type SceneObjectLike } from "./scene-geometry";
import { SceneSnapper, shapeLabel, snapLabel, type SnapHit } from "./snap-index";
import { DISPLAY_UNITS, INSUNITS, OVERRIDE_UNITS, readDxfHeaderUnits, unitInfo, type DisplayUnit, type DxfHeaderUnits } from "./units";

/** Overlay colours per canvas background (like the background presets, fixed colours). */
const COLORS = {
  dark: { line: "#ffc233", snap: "#3ddc84", halo: "#1f2329", fill: "rgba(255, 194, 51, 0.15)" },
  light: { line: "#0b57d0", snap: "#0a8f3c", halo: "#ffffff", fill: "rgba(11, 87, 208, 0.12)" },
} as const;

const SNAP_PX = 12;
const TOUCH_SNAP_PX = 26;
const CLICK_PX = 6;
const TOUCH_CLICK_PX = 14;
const DOUBLE_MS = 450;

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* falls back below (plain http on a LAN has no Clipboard API) */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export interface CadMeasureOptions {
  viewer: DxfViewer | null;
  host: HTMLDivElement | null;
  /** The drawing is loaded (scene ready). */
  loaded: boolean;
  bg: "dark" | "light";
  /** Names of hidden layers, "\n"-joined (not snapped, not picked). */
  hiddenLayers: string;
  /** The DXF (original or converted), read only for its HEADER units. */
  dxfUrl: string;
  /** Units the server already read (dxf preview meta.cad); when given the DXF header is not fetched. */
  units?: DxfHeaderUnits | null;
  fileName: string;
  /** 2B metraj: saves a length / chain / area result (drawing coordinates, metres per unit). */
  takeoff?: { save(kind: "length" | "area", points: [number, number][], metresPerUnit: number): Promise<void>; href: string } | null;
}

interface Info {
  hit: SnapHit | null;
  /** Segment in drawing coordinates. */
  seg?: [Pt, Pt];
}

let nextId = 1;

export function useCadMeasure(o: CadMeasureOptions) {
  const { t } = useTranslation(["viewers", "common"]);
  const [tool, setToolState] = useState<ToolKey | null>(null);
  const [snapOn, setSnapOnState] = useState(() => load("cde.cad.snap") !== "0");
  const [draft, setDraft] = useState<Pt[]>([]);
  const [hover, setHover] = useState<{ p: Pt; snap: SnapHit | null } | null>(null);
  const [items, setItems] = useState<Measurement[]>([]);
  const [info, setInfo] = useState<Info | null>(null);
  const [header, setHeader] = useState<DxfHeaderUnits | null>(null);
  const [override, setOverride] = useState<number | null>(null);
  const [unit, setUnitState] = useState<DisplayUnit>(() => {
    const u = load("cde.cad.unit");
    return u === "mm" || u === "cm" || u === "m" ? u : "m";
  });
  const [building, setBuilding] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [saved, setSaved] = useState<Set<number>>(() => new Set());
  const [saving, setSaving] = useState<number | null>(null);
  const snapRef = useRef<{ v: DxfViewer; s: SceneSnapper } | null>(null);

  // Units from the DXF header (streams only the start of the file), unless the server read them.
  useEffect(() => {
    if (o.units) {
      setHeader(o.units);
      return;
    }
    const ac = new AbortController();
    setHeader(null);
    readDxfHeaderUnits(o.dxfUrl, ac.signal).then(
      (h) => setHeader(h),
      () => !ac.signal.aborted && setHeader({ insunits: null, measurement: null }),
    );
    return () => ac.abort();
  }, [o.dxfUrl, o.units]);

  const fileCode = header?.insunits ?? null;
  const code = override ?? fileCode ?? 0;
  const metres = unitInfo(code).metres;
  const fmt = { metres: metres ?? 1, unit };
  const fileUnitText = !header ? "…" : fileCode && INSUNITS[fileCode] ? INSUNITS[fileCode]!.short : t("cad.units.unknown");
  const unitNote =
    override !== null
      ? t("cad.measure.unitManual", { unit: unitInfo(override).short })
      : !header
        ? "…"
        : metres === null
          ? t("cad.measure.unitAssumed", { unit: fileUnitText })
          : fileUnitText;

  const setUnit = (u: DisplayUnit) => {
    setUnitState(u);
    save("cde.cad.unit", u);
  };
  const setSnapOn = (on: boolean) => {
    setSnapOnState(on);
    save("cde.cad.snap", on ? "1" : "0");
    setHover(null);
  };
  const setTool = useCallback((t: ToolKey | null) => {
    setToolState(t);
    setDraft([]);
    setHover(null);
    setInfo(null);
  }, []);

  /** The snap index of the current scene (built once per loaded viewer). */
  const snapper = useCallback((): SceneSnapper | null => {
    const v = o.viewer;
    if (!v || !o.loaded) return null;
    if (snapRef.current?.v === v) return snapRef.current.s;
    const t0 = performance.now();
    const { lines, points } = sceneSources(v.GetScene().children as unknown as SceneObjectLike[]);
    const s = new SceneSnapper(lines, points);
    s.setHiddenLayers(o.hiddenLayers ? o.hiddenLayers.split("\n") : []);
    snapRef.current = { v, s };
    console.info(`CAD yakalama dizini: ${s.segmentCount} parça, ${Math.round(performance.now() - t0)} ms`); // i18n-ok: console
    return s;
  }, [o.viewer, o.loaded, o.hiddenLayers]);

  // Build the index in the background once a tool needs it, so the first click does not wait.
  const needsIndex = !!tool && (snapOn || tool === "info");
  useEffect(() => {
    if (!needsIndex || !o.loaded || !o.viewer || snapRef.current?.v === o.viewer) return;
    setBuilding(true);
    const timer = setTimeout(() => {
      try {
        snapper();
      } finally {
        setBuilding(false);
      }
    }, 30);
    return () => {
      clearTimeout(timer);
      setBuilding(false);
    };
  }, [needsIndex, o.loaded, o.viewer, snapper]);

  useEffect(() => {
    if (snapRef.current?.v === o.viewer) snapRef.current.s.setHiddenLayers(o.hiddenLayers ? o.hiddenLayers.split("\n") : []);
  }, [o.hiddenLayers, o.viewer]);

  // Screen ↔ scene ↔ drawing coordinates.
  const origin = (): Pt => {
    const g = o.viewer?.GetOrigin();
    return g ? { x: g.x, y: g.y } : { x: 0, y: 0 };
  };
  const sceneAt = (cx: number, cy: number): Pt | null => {
    const v = o.viewer;
    const h = o.host;
    if (!v || !h || !h.clientWidth || !h.clientHeight) return null;
    const p = new THREE.Vector3((cx * 2) / h.clientWidth - 1, (-cy * 2) / h.clientHeight + 1, 1).unproject(v.GetCamera());
    return { x: p.x, y: p.y };
  };
  const pxScale = (): number => {
    const a = sceneAt(0, 0);
    const b = sceneAt(1, 0);
    return a && b ? Math.abs(b.x - a.x) : 0;
  };
  const toScreen = (d: Pt): Pt | null => {
    const v = o.viewer;
    const h = o.host;
    if (!v || !h) return null;
    const org = origin();
    const ndc = new THREE.Vector3(d.x - org.x, d.y - org.y, 0).project(v.GetCamera());
    return { x: ((ndc.x + 1) / 2) * h.clientWidth, y: ((1 - ndc.y) / 2) * h.clientHeight };
  };

  /** Drawing point under the pointer, snapped when Yakalama is on. */
  const pointAt = (cx: number, cy: number, touch: boolean): { p: Pt; snap: SnapHit | null } | null => {
    const raw = sceneAt(cx, cy);
    if (!raw) return null;
    const org = origin();
    let hit: SnapHit | null = null;
    if (snapOn) hit = snapper()?.snap(raw.x, raw.y, (touch ? TOUCH_SNAP_PX : SNAP_PX) * pxScale()) ?? null;
    const s = hit ?? raw;
    return { p: { x: s.x + org.x, y: s.y + org.y }, snap: hit ? { ...hit, x: hit.x + org.x, y: hit.y + org.y } : null };
  };

  const commit = (t: MeasureTool, pts: Pt[]) => setItems((it) => [...it, { id: nextId++, tool: t, pts }]);

  const finish = () => {
    if (!tool || tool === "info") return;
    if (draft.length >= minPoints(tool)) commit(tool, draft);
    setDraft([]);
  };

  const cancel = () => {
    if (draft.length) setDraft([]);
    else setTool(null);
  };

  // Latest state for the DOM listeners below (they are bound once per viewer/tool).
  const latest = useRef({ draft, tool, finish, cancel, pointAt, toScreen, sceneAt, pxScale, snapper });
  latest.current = { draft, tool, finish, cancel, pointAt, toScreen, sceneAt, pxScale, snapper };

  // Pointer input on the canvas: a click (no drag) adds a point, a drag still pans.
  useEffect(() => {
    const h = o.host;
    if (!h || !tool || !o.loaded) return;
    const pointers = new Set<number>();
    let down: { x: number; y: number; id: number; touch: boolean } | null = null;
    let lastClick: { x: number; y: number; t: number } | null = null;
    let frame = 0;
    const local = (e: PointerEvent) => {
      const r = h.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent) => {
      pointers.add(e.pointerId);
      if (pointers.size > 1 || e.button !== 0) {
        down = null;
        return;
      }
      const p = local(e);
      down = { ...p, id: e.pointerId, touch: e.pointerType === "touch" };
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      const d = down;
      down = null;
      if (!d || d.id !== e.pointerId) return;
      const p = local(e);
      if (Math.hypot(p.x - d.x, p.y - d.y) > (d.touch ? TOUCH_CLICK_PX : CLICK_PX)) return;
      const L = latest.current;
      const t = L.tool;
      if (!t) return;
      const now = performance.now();
      const dbl = !!lastClick && now - lastClick.t < DOUBLE_MS && Math.hypot(p.x - lastClick.x, p.y - lastClick.y) <= (d.touch ? TOUCH_CLICK_PX : CLICK_PX);
      lastClick = { ...p, t: now };
      if (t === "info") {
        const raw = L.sceneAt(p.x, p.y);
        const s = L.snapper();
        if (!raw || !s) return;
        const hit = s.pick(raw.x, raw.y, (d.touch ? TOUCH_SNAP_PX : SNAP_PX) * L.pxScale());
        const org = origin();
        setInfo({
          hit,
          seg: hit?.seg
            ? [
                { x: hit.seg[0] + org.x, y: hit.seg[1] + org.y },
                { x: hit.seg[2] + org.x, y: hit.seg[3] + org.y },
              ]
            : undefined,
        });
        return;
      }
      const need = pointsNeeded(t);
      if (need === null && dbl) {
        // Double click / double tap ends Zincir Uzunluk and Alan (the first click added the point).
        L.finish();
        lastClick = null;
        return;
      }
      const at = L.pointAt(p.x, p.y, d.touch);
      if (!at) return;
      const next = [...L.draft, at.p];
      if (need !== null && next.length >= need) {
        commit(t as MeasureTool, next);
        setDraft([]);
      } else setDraft(next);
      if (d.touch) setHover(at);
    };
    const onCancel = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      down = null;
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch" || e.buttons) return;
      const p = local(e);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (latest.current.tool === "info") return;
        setHover(latest.current.pointAt(p.x, p.y, false));
      });
    };
    const onLeave = () => {
      cancelAnimationFrame(frame);
      setHover(null);
    };
    h.addEventListener("pointerdown", onDown);
    h.addEventListener("pointerup", onUp);
    h.addEventListener("pointercancel", onCancel);
    h.addEventListener("pointermove", onMove);
    h.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(frame);
      h.removeEventListener("pointerdown", onDown);
      h.removeEventListener("pointerup", onUp);
      h.removeEventListener("pointercancel", onCancel);
      h.removeEventListener("pointermove", onMove);
      h.removeEventListener("pointerleave", onLeave);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.host, o.viewer, o.loaded, tool]);

  // Esc cancels (the point being drawn, then the tool), Enter ends, Backspace removes the last point.
  useEffect(() => {
    if (!tool) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "Escape") latest.current.cancel();
      else if (e.key === "Enter") latest.current.finish();
      else if (e.key === "Backspace" && latest.current.draft.length) {
        e.preventDefault();
        setDraft((d) => d.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  const heading = t("cad.measure.clipboardHeading", { file: o.fileName, unitNote, unit });
  const copy = async () => {
    const ok = await copyText(clipboardText(items, fmt, heading));
    setCopied(ok ? t("cad.measure.messages.copied") : t("cad.measure.errors.copyFailed"));
  };
  const clear = () => {
    setItems([]);
    setDraft([]);
  };
  const remove = (id: number) => setItems((it) => it.filter((m) => m.id !== id));
  const toTakeoff = async (m: Measurement) => {
    if (!o.takeoff || (m.tool !== "length" && m.tool !== "chain" && m.tool !== "area")) return;
    setSaving(m.id);
    try {
      await o.takeoff.save(m.tool === "area" ? "area" : "length", m.pts.map((p) => [p.x, p.y]), fmt.metres);
      setSaved((s) => new Set(s).add(m.id));
    } catch (e) {
      setCopied((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  // ---- Overlay -------------------------------------------------------------------------------
  const c = COLORS[o.bg];
  const live = tool && tool !== "info" && hover && (pointsNeeded(tool) === null || draft.length < (pointsNeeded(tool) ?? 0)) ? [...draft, hover.p] : draft;
  const label = (x: number, y: number, text: string, key: string, color: string = c.line) => (
    <text key={key} x={x} y={y} fill={color} stroke={c.halo} strokeWidth={3} paintOrder="stroke" fontSize={12} fontWeight={600}>
      {text}
    </text>
  );
  const shape = (m: { tool: MeasureTool; pts: Pt[] }, key: string, isDraft: boolean): ReactNode => {
    const s = m.pts.map(toScreen).filter((p): p is Pt => !!p);
    if (!s.length) return null;
    const d = describe(m.tool, m.pts, fmt);
    const poly = s.map((p) => `${p.x},${p.y}`).join(" ");
    const dash = isDraft ? "6 4" : undefined;
    const dots = s.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={3} fill={c.line} />);
    const last = s[s.length - 1]!;
    switch (m.tool) {
      case "coord":
        return (
          <g key={key}>
            <path d={`M${last.x - 8} ${last.y}H${last.x + 8}M${last.x} ${last.y - 8}V${last.y + 8}`} stroke={c.line} strokeWidth={2} />
            {label(last.x + 8, last.y - 8, d.value, "l")}
          </g>
        );
      case "area": {
        const cx = s.reduce((a, p) => a + p.x, 0) / s.length;
        const cy = s.reduce((a, p) => a + p.y, 0) / s.length;
        return (
          <g key={key}>
            <polygon points={poly} fill={c.fill} stroke={c.line} strokeWidth={2} strokeDasharray={dash} />
            {dots}
            {s.length >= 3 && label(cx, cy, d.value, "l")}
          </g>
        );
      }
      case "angle": {
        const v = s[1];
        return (
          <g key={key}>
            <polyline points={poly} fill="none" stroke={c.line} strokeWidth={2} strokeDasharray={dash} />
            {dots}
            {v && s.length >= 3 && label(v.x + 10, v.y - 10, d.value, "l")}
          </g>
        );
      }
      default: {
        const mid = s.length === 2 ? { x: (s[0]!.x + s[1]!.x) / 2, y: (s[0]!.y + s[1]!.y) / 2 } : last;
        return (
          <g key={key}>
            <polyline points={poly} fill="none" stroke={c.line} strokeWidth={2} strokeDasharray={dash} />
            {dots}
            {s.length >= 2 && label(mid.x + 8, mid.y - 8, d.value, "l")}
          </g>
        );
      }
    }
  };
  const snapMarker = (h: SnapHit): ReactNode => {
    const p = toScreen(h);
    if (!p) return null;
    const { x, y } = p;
    const r = 6;
    const marks: Record<SnapHit["kind"], ReactNode> = {
      end: <rect x={x - r} y={y - r} width={2 * r} height={2 * r} fill="none" stroke={c.snap} strokeWidth={2} />,
      mid: <polygon points={`${x},${y - r - 1} ${x + r + 1},${y + r} ${x - r - 1},${y + r}`} fill="none" stroke={c.snap} strokeWidth={2} />,
      center: <circle cx={x} cy={y} r={r} fill="none" stroke={c.snap} strokeWidth={2} />,
      near: <path d={`M${x - r} ${y - r}H${x + r}L${x - r} ${y + r}H${x + r}Z`} fill="none" stroke={c.snap} strokeWidth={2} />,
    };
    return (
      <g>
        {marks[h.kind]}
        {label(x + 10, y + 18, snapLabel(h.kind), "s", c.snap)}
      </g>
    );
  };
  const infoSeg = info?.seg?.map(toScreen);
  const overlay = (
    <svg className="cad-overlay" width="100%" height="100%">
      {items.map((m) => shape(m, `m${m.id}`, false))}
      {tool && tool !== "info" && live.length > 0 && shape({ tool, pts: live }, "draft", true)}
      {hover?.snap && snapMarker(hover.snap)}
      {infoSeg?.[0] && infoSeg[1] && <line x1={infoSeg[0].x} y1={infoSeg[0].y} x2={infoSeg[1].x} y2={infoSeg[1].y} stroke={c.snap} strokeWidth={5} strokeLinecap="round" opacity={0.8} />}
    </svg>
  );

  // ---- Hint bar (tool, instruction, live value) --------------------------------------------------
  const liveValue = tool && tool !== "info" && live.length >= 2 ? describe(tool, live, fmt).value : null;
  const canFinish = !!tool && pointsNeeded(tool) === null && draft.length >= minPoints(tool);
  const hint = tool ? (
    <div className="cad-hint" role="status">
      <strong>{toolLabel(tool)}</strong>
      <span>{hintText(tool, draft.length)}</span>
      {liveValue && <span className="cad-live">{liveValue}</span>}
      {building && <span className="muted">{t("cad.measure.messages.preparingSnap")}</span>}
      {tool === "info" && info && (
        <span>
          {info.hit ? (
            <Trans
              t={t}
              i18nKey="cad.measure.infoHit"
              values={{ layer: info.hit.layer, shape: shapeLabel(info.hit.shape) }}
              components={{ b: <strong /> }}
            />
          ) : (
            t("cad.measure.messages.noLineNearby")
          )}
        </span>
      )}
      <span className="cad-hint-actions">
        {canFinish && (
          <button className="small" onClick={finish}>
            {t("cad.measure.actions.finish")}
          </button>
        )}
        <button
          className="small"
          onClick={cancel}
          title="Esc" // i18n-ok: key name
        >
          {draft.length ? t("cad.measure.actions.undo") : t("common:actions.close")}
        </button>
      </span>
    </div>
  ) : null;

  // ---- Result list ------------------------------------------------------------------------------
  const showPanel = items.length > 0 || (!!tool && tool !== "info");
  const panel = showPanel ? (
    <div className="cad-results">
      <div className="cad-results-head">
        <strong>{t("cad.measure.title")}</strong>
        <span className="muted small">{t("cad.measure.unitSummary", { unit: unitNote })}</span>
      </div>
      <div className="cad-results-units">
        <label>
          {t("cad.measure.fields.drawingUnit")}
          <select value={override ?? "file"} onChange={(e) => setOverride(e.target.value === "file" ? null : Number(e.target.value))}>
            <option value="file">{t("cad.measure.options.fromFile", { unit: fileUnitText })}</option>
            {OVERRIDE_UNITS.map((u) => (
              <option key={u} value={u}>
                {INSUNITS[u]!.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("cad.measure.fields.displayUnit")}
          <select value={unit} onChange={(e) => setUnit(e.target.value as DisplayUnit)}>
            {(Object.keys(DISPLAY_UNITS) as DisplayUnit[]).map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
      </div>
      {items.length ? (
        <ol className="cad-results-list">
          {items.map((m, i) => {
            const d = describe(m.tool, m.pts, fmt);
            return (
              <li key={m.id}>
                <span className="cad-results-name">
                  {i + 1}. {toolLabel(m.tool)}
                </span>
                <span className="cad-results-value">
                  {d.value}
                  {d.detail && <small>{d.detail}</small>}
                </span>
                {o.takeoff && (m.tool === "length" || m.tool === "chain" || m.tool === "area") &&
                  (saved.has(m.id) ? (
                    <span className="badge ok small">{t("cad.measure.takeoff.saved")}</span>
                  ) : (
                    <button className="small" disabled={saving === m.id} onClick={() => void toTakeoff(m)} aria-label={t("cad.measure.takeoff.addLabel", { n: i + 1 })}>
                      {t("cad.measure.takeoff.add")}
                    </button>
                  ))}
                <button className="small" onClick={() => remove(m.id)} title={t("common:actions.delete")} aria-label={t("cad.measure.deleteLabel", { n: i + 1 })}>
                  ✕
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="muted small">{t("cad.measure.empty")}</p>
      )}
      {items.length > 0 && (
        <div className="cad-results-foot">
          <button className="small" onClick={copy}>
            {t("cad.measure.actions.copy")}
          </button>
          <button className="small" onClick={clear}>
            {t("common:actions.clear")}
          </button>
          {o.takeoff && saved.size > 0 && (
            <a className="small" href={o.takeoff.href}>
              {t("cad.measure.takeoff.open")}
            </a>
          )}
          {copied && <span className="muted small">{copied}</span>}
        </div>
      )}
    </div>
  ) : null;

  return { tool, setTool, snapOn, setSnapOn, items, copy, clear, overlay, hint, panel, building };
}
