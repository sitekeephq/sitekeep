/**
 * DWG/DXF viewer: dxf-viewer (MPL-2.0, three.js) in its own lazy chunk; parsing runs in a web
 * worker. DWG files arrive as DXF converted on the server (LibreDWG). When the server has built the
 * drawing's 2D scene, it is loaded instead of the DXF (cad/scene-loader.ts; cad/CadGate.tsx picks).
 * Pan/zoom, fit (robust:
 * stray far-away entities do not shrink the drawing to a dot; "Tümünü Göster" for the full
 * extents), layers, model space only or all, dark/light background. Measuring, snapping, units
 * and "Bilgi" live in ./cad/ (CadMeasure.tsx). Text uses bundled Noto Sans (latin + latin-ext:
 * Turkish letters), so nothing is fetched from the internet.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { DxfViewer, type LayerInfo } from "dxf-viewer";
import { useTranslation } from "react-i18next";
import * as THREE from "three";
import notoLatin from "@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff?url";
import notoLatinExt from "@fontsource/noto-sans/files/noto-sans-latin-ext-400-normal.woff?url";
import { useLoad } from "../app/context/project";
import { webCapability } from "../sdk";
import { viewersApi } from "../shared/api/api-viewers";
import { formatPercent, dataLocale, intlLocale } from "../shared/lib/format";
import { MoreMenu } from "../shared/ui/MoreMenu";
import { usePhoneWidth } from "../shared/ui/RecordCards";
import { robustBounds, type RobustBounds } from "./cad/bounds";
import { cadMoreItems, type CadMoreKey } from "./cad/cad-phone";
import { useCadMeasure } from "./cad/CadMeasure";
import { TOOLS, toolLabel } from "./cad/measure";
import { scenePoints, type SceneObjectLike } from "./cad/scene-geometry";
import type { ViewerProps } from "./types";
import { sceneUrl, sceneWorkerFactory, type CadSource } from "./cad/scene-loader";

/** Canvas background presets (the only fixed colours of the viewers). */
const BACKGROUNDS = { dark: "#1f2329", light: "#ffffff" } as const;
type Bg = keyof typeof BACKGROUNDS;

/** Loading phases of dxf-viewer. */
const PHASES = ["font", "fetch", "parse", "prepare"] as const;
const isPhase = (p: string): p is (typeof PHASES)[number] => (PHASES as readonly string[]).includes(p);

function prefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export default function CadViewer({ projectId, info, source = "dxf", notice = null }: ViewerProps & { source?: CadSource; notice?: string | null }) {
  const { t } = useTranslation("viewers");
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<DxfViewer | null>(null);
  const [bg, setBg] = useState<Bg>(() => (prefersDark() ? "dark" : "light"));
  const [modelOnly, setModelOnly] = useState(false);
  const [layers, setLayers] = useState<(LayerInfo & { visible: boolean })[]>([]);
  const [progress, setProgress] = useState<string | null>(() => t("cad.messages.loading"));
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [, setViewTick] = useState(0);
  const [layerFilter, setLayerFilter] = useState("");
  const [showLayers, setShowLayers] = useState(() => window.innerWidth > 760);
  const phone = usePhoneWidth();
  const robust = useRef<{ v: DxfViewer; b: RobustBounds | null } | null>(null);

  const preview = info.previews.find((p) => p.kind === "dxf");
  // The prebuilt scene, or the DXF (the original, or the one converted from a DWG).
  const url = source === "scene" ? sceneUrl(projectId, info, modelOnly) : viewersApi.previewUrl(projectId, info.versionId, "dxf");
  const encoding = preview?.meta.encoding ?? "utf-8";

  // Create the viewer and load the drawing (again when "model space only" changes).
  useEffect(() => {
    const el = host.current!;
    let disposed = false;
    setError(null);
    setWarning(null);
    setLayers([]);
    setProgress(t("cad.messages.loading"));
    let v: DxfViewer;
    try {
      v = new DxfViewer(el, {
        autoResize: true,
        clearColor: new THREE.Color(BACKGROUNDS[bg]),
        colorCorrection: true,
        antialias: true,
        fileEncoding: encoding,
        sceneOptions: { suppressPaperSpace: modelOnly },
      });
    } catch (e) {
      setError(t("cad.errors.webgl", { message: (e as Error).message }));
      setProgress(null);
      return;
    }
    viewer.current = v;
    const onView = () => setViewTick((n) => n + 1);
    const onMessage = (e: Event) => {
      const d = (e as CustomEvent<{ message: string; level: string }>).detail;
      if (d.level !== "info" && /missing fonts/i.test(d.message)) setWarning(t("cad.messages.missingGlyphs"));
    };
    v.Subscribe("viewChanged", onView);
    v.Subscribe("message", onMessage);
    v.Load({
      url,
      fonts: [notoLatin, notoLatinExt],
      workerFactory: source === "scene" ? sceneWorkerFactory() : () => new Worker(new URL("./dxf.worker.ts", import.meta.url), { type: "module" }),
      progressCbk: (phase, done, total) => {
        if (disposed) return;
        const name = isPhase(phase) ? t(`cad.phases.${phase}`) : phase;
        setProgress(total ? t("cad.progressPercent", { phase: name, percent: formatPercent(done / total) }) : t("cad.progress", { phase: name }));
      },
    }).then(
      () => {
        if (disposed) return;
        setProgress(null);
        setLayers([...v.GetLayers(true)].map((l) => ({ ...l, visible: true })).sort((a, b) => a.displayName.localeCompare(b.displayName, dataLocale())));
      },
      (e: unknown) => {
        if (disposed) return;
        setProgress(null);
        const msg = e instanceof Error ? e.message : typeof e === "string" ? e : String((e as { message?: unknown })?.message ?? e);
        setError(t("cad.errors.openFailed", { message: msg }));
      },
    );
    return () => {
      disposed = true;
      viewer.current = null;
      v.Destroy();
    };
    // Background changes are applied without reloading (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, encoding, modelOnly]);

  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    v.SetClearColor(BACKGROUNDS[bg]);
    v.Render();
    // Layer colours are corrected against the background.
    setLayers((ls) => {
      const now = new Map([...v.GetLayers(true)].map((l) => [l.name, l.color]));
      return ls.map((l) => ({ ...l, color: now.get(l.name) ?? l.color }));
    });
  }, [bg]);

  // Font warnings fade out so they do not cover the drawing.
  useEffect(() => {
    if (!warning) return;
    const timer = setTimeout(() => setWarning(null), 8000);
    return () => clearTimeout(timer);
  }, [warning]);

  const loaded = progress === null && !error && !!viewer.current;

  /** Extents of the main body of the drawing (scene coordinates), once per loaded scene. */
  const mainBounds = (v: DxfViewer): RobustBounds | null => {
    if (robust.current?.v !== v) robust.current = { v, b: robustBounds(scenePoints(v.GetScene().children as unknown as SceneObjectLike[])) };
    return robust.current.b;
  };
  /** Tümünü Göster: the full extents, stray entities included. */
  const fitAll = () => {
    const v = viewer.current;
    const b = v?.GetBounds();
    if (!v || !b) return;
    const o = v.GetOrigin();
    v.FitView(b.minX - o.x, b.maxX - o.x, b.minY - o.y, b.maxY - o.y);
  };
  /** Sığdır: the main body; far-away stray entities (e.g. one at 0,0 in a UTM drawing) are left out. */
  const fit = () => {
    const v = viewer.current;
    const b = v && mainBounds(v);
    if (!v || !b) return fitAll();
    v.FitView(b.minX, b.maxX, b.minY, b.maxY);
  };
  // The first view after loading is the smart fit too (the viewer itself fits the full extents).
  const loadedViewer = loaded ? viewer.current : null;
  useEffect(() => {
    if (!loadedViewer) return;
    const b = mainBounds(loadedViewer);
    if (b && b.outliers > 0) loadedViewer.FitView(b.minX, b.maxX, b.minY, b.maxY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedViewer]);

  const hiddenLayers = useMemo(
    () =>
      layers
        .filter((l) => !l.visible)
        .map((l) => l.name)
        .join("\n"),
    [layers],
  );
  // Units: the server's drawing check already read $INSUNITS / $MEASUREMENT (meta.cad); older
  // previews without it stream the DXF header (never the scene URL).
  const cad = preview?.meta.cad;
  const units = useMemo(() => (cad ? { insunits: cad.insunits, measurement: cad.measurement ?? null } : null), [cad?.insunits, cad?.measurement]);
  // 2D takeoff comes from the Cost module; without it the measure tools only measure.
  const takeoffApi = webCapability("cost.takeoff");
  const takeoffState = useLoad(() => (takeoffApi ? takeoffApi.get(projectId, info.versionId).catch(() => null) : Promise.resolve(null)), [projectId, info.versionId]).data;
  const takeoff = useMemo(
    () =>
      takeoffApi && takeoffState?.canEdit
        ? {
            href: `/projects/${projectId}/takeoff/${info.versionId}`,
            save: async (kind: "length" | "area", points: [number, number][], metresPerUnit: number) => {
              await takeoffApi.add(projectId, info.versionId, { page: 1, kind, points, drawingUnits: metresPerUnit });
            },
          }
        : null,
    [takeoffState?.canEdit, projectId, info.versionId],
  );
  const m = useCadMeasure({ viewer: viewer.current, host: host.current, loaded, bg, hiddenLayers, dxfUrl: viewersApi.previewUrl(projectId, info.versionId, "dxf"), units, fileName: info.fileName, takeoff });

  const setLayer = (name: string, visible: boolean) => {
    viewer.current?.ShowLayer(name, visible);
    viewer.current?.Render();
    setLayers((ls) => ls.map((l) => (l.name === name ? { ...l, visible } : l)));
  };
  const visibleLayers = layers.filter((l) => !layerFilter || l.displayName.toLocaleLowerCase(dataLocale()).includes(layerFilter.toLocaleLowerCase(dataLocale())));
  /** Tümünü Aç / Tümünü Kapat: the layers in the list (the search result when searching). */
  const setAll = (visible: boolean) => {
    const names = new Set(visibleLayers.map((l) => l.name));
    for (const name of names) viewer.current?.ShowLayer(name, visible);
    viewer.current?.Render();
    setLayers((ls) => ls.map((l) => (names.has(l.name) ? { ...l, visible } : l)));
  };

  const toggleBg = () => setBg((b) => (b === "dark" ? "light" : "dark"));
  const onMore = (k: CadMoreKey) => {
    if (k === "fit_all") fitAll();
    else if (k === "snap") m.setSnapOn(!m.snapOn);
    else if (k === "bg") toggleBg();
    else if (k === "model") setModelOnly((x) => !x);
    else if (k === "copy") void m.copy();
    else if (k === "clear") m.clear();
    else m.setTool(m.tool === k ? null : k);
  };

  return (
    <>
      <div className="vw-tool">
        <button className="small" onClick={fit} title={t("cad.toolbar.fitHint")}>
          ⤢ {t("actions.fit")}
        </button>
        {!phone && (
          <>
            <button className="small" onClick={fitAll} title={t("cad.toolbar.fitAllHint")}>
              {t("cad.toolbar.actions.fitAll")}
            </button>
            <span className="cad-tool-sep" aria-hidden="true" />
            {TOOLS.map((tool) => (
              <button
                key={tool.key}
                className={`small${m.tool === tool.key ? " on" : ""}`}
                aria-pressed={m.tool === tool.key}
                disabled={!loaded}
                onClick={() => m.setTool(m.tool === tool.key ? null : tool.key)}
              >
                {tool.icon} {toolLabel(tool.key)}
              </button>
            ))}
            <button
              className={`small${m.snapOn ? " on" : ""}`}
              aria-pressed={m.snapOn}
              onClick={() => m.setSnapOn(!m.snapOn)}
              title={t("cad.toolbar.snapHint")}
            >
              ⌁ {t("cad.toolbar.actions.snap")}
            </button>
            <span className="cad-tool-sep" aria-hidden="true" />
            <button className="small" onClick={toggleBg} title={t("cad.toolbar.backgroundHint")}>
              {bg === "dark" ? `☀ ${t("cad.toolbar.actions.lightBackground")}` : `☾ ${t("cad.toolbar.actions.darkBackground")}`}
            </button>
            <button className={`small${modelOnly ? " on" : ""}`} onClick={() => setModelOnly((x) => !x)} title={t("cad.toolbar.modelOnlyHint")}>
              {t("cad.toolbar.actions.modelSpaceOnly")}
            </button>
          </>
        )}
        <button className={`small${showLayers ? " on" : ""}`} onClick={() => setShowLayers((x) => !x)}>
          {t("cad.toolbar.actions.layers", { count: layers.length })}
        </button>
        {phone && <MoreMenu items={cadMoreItems({ loaded, tool: m.tool, snap: m.snapOn, bg, modelOnly, count: m.items.length })} onSelect={onMore} />}
      </div>
      <div className="cad" style={showLayers ? undefined : { gridTemplateColumns: "1fr", gridTemplateRows: "1fr" }}>
        <div className={`cad-canvas${m.tool ? " measuring" : ""}`}>
          {/* dxf-viewer makes its container position: relative, so it is sized, not inset. */}
          <div ref={host} style={{ width: "100%", height: "100%" }} />
          {m.overlay}
          {m.hint}
          {m.panel}
          {(progress || error || warning || notice) && (
            <div className={`cad-status${error ? " error" : ""}`}>
              {progress && <span className="vw-spin" />}
              {error ?? progress ?? warning ?? notice}
            </div>
          )}
        </div>
        {showLayers && (
          <div className="cad-layers">
            <input type="search" placeholder={t("cad.layers.placeholder")} value={layerFilter} onChange={(e) => setLayerFilter(e.target.value)} style={{ marginBottom: 6 }} />
            <div className="row" style={{ marginBottom: 6 }}>
              <button className="small" onClick={() => setAll(true)}>
                {t("cad.layers.actions.allOn")}
              </button>
              <button className="small" onClick={() => setAll(false)}>
                {t("cad.layers.actions.allOff")}
              </button>
            </div>
            {visibleLayers.map((l) => (
              <label key={l.name} className="cad-layer">
                <input type="checkbox" checked={l.visible} onChange={(e) => setLayer(l.name, e.target.checked)} />
                <span className="cad-swatch" style={{ background: `#${l.color.toString(16).padStart(6, "0")}` }} />
                <span>{l.displayName}</span>
              </label>
            ))}
            {!layers.length && !progress && <p className="muted small">{t("cad.layers.empty")}</p>}
            {layers.length > 0 && !visibleLayers.length && <p className="muted small">{t("cad.layers.noMatch")}</p>}
          </div>
        )}
      </div>
    </>
  );
}
