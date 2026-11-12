import React from "react";
import type { ViewerEngine } from "../../core/ViewerEngine.js";
import type { ViewerExtension } from "../../extensions/types.js";
import { ViewerCanvas } from "../ViewerCanvas.js";
import { useViewerTools } from "../useViewerTools.js";
import { ViewerToolsHud } from "../ViewerToolsHud.js";
import * as THREE from "three";
import {
  applyTrackHeatmap,
  createScanLayers,
  fitCameraToRail,
  IoTDataView,
  iotSensorIdFromHit,
  paintIotLayer,
  type HeatmapFilter,
  type IotSensor,
  railFocusBox,
  SCAN_CLOSE_DISTANCE,
  SCAN_MAX_DISTANCE,
  applyScanClipPlanes,
  displayZoomRatio,
  distanceFromZoomProgress,
  installScanWheelZoom,
  readCameraPose,
  scanDollyPickRef,
  scanOrbitDistance,
  scanViewerDomRef,
  scanZoomOutLimitRef,
  tuneScanNavigation,
  zoomProgressFromDistance,
  applyScanSelectionColor,
  createScanSelectionOutline,
  scanElementFromHit,
  type ScanElementSelection,
} from "../../scan/index.js";
import { ZoomHud } from "./ZoomHud.js";
import { ErrorOverlay, LoadingOverlay, scanStatusText } from "./ScanChrome.js";
import { IoTExtensionPanel, type IotPanelView } from "./IoTExtensionPanel.js";
import { LayerVisibilityControl } from "./LayerVisibilityControl.js";
import { ModelElementPanel } from "./ModelElementPanel.js";
import { ScanIotToolbar } from "./ScanIotToolbar.js";

const EMPTY_EXTENSIONS: readonly ViewerExtension[] = [];

/** Heatmap and the km chart are the two large tools in the middle: opening one closes the other. */
const EXCLUSIVE_IOT_PANELS: Partial<Record<IotPanelView, IotPanelView>> = { heatmap: "range", range: "heatmap" };

export function withIotPanel(current: IotPanelView[], view: IotPanelView): IotPanelView[] {
  return [...current.filter((item) => item !== view && item !== EXCLUSIVE_IOT_PANELS[view]), view];
}

export interface ScanViewerProps {
  /** Fragment fallback routes when güzergah mesh is unavailable. */
  fragmentRoutes: string[];
  resolveModelUrl?: (url: string) => string;
  extensions?: readonly ViewerExtension[];
  branding?: React.ReactNode;
}

export function ScanViewer({
  fragmentRoutes,
  resolveModelUrl = (url: string) => url,
  extensions = EMPTY_EXTENSIONS,
  branding,
}: ScanViewerProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [engine, setEngine] = React.useState<ViewerEngine | null>(null);
  const [world, setWorld] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadDetail, setLoadDetail] = React.useState("Sahne kuruluyor");
  const [scanSteps, setScanSteps] = React.useState({ las: false, bim: false, iot: false });
  const [error, setError] = React.useState<string | null>(null);
  const [modelLoaded, setModelLoaded] = React.useState(false);
  const [layersReady, setLayersReady] = React.useState(false);
  const ifcModelsRef = React.useRef<THREE.Object3D[]>([]);
  const v3ModelRef = React.useRef<any>(null);
  const scanSelectionOutlineRef = React.useRef<THREE.Box3Helper | null>(null);
  const scanSelectionColorCleanupRef = React.useRef<(() => void) | null>(null);
  const [scanSelection, setScanSelection] = React.useState<ScanElementSelection | null>(null);
  const [scanIfcStatus, setScanIfcStatus] = React.useState<"off" | "loading" | "ready" | "error">("off");
  const pointCloudRef = React.useRef<THREE.Points | null>(null);
  const iotGroupRef = React.useRef<THREE.Group | null>(null);
  const iotViewRef = React.useRef<IoTDataView | null>(null);
  const modelBoxRef = React.useRef<THREE.Box3 | null>(null);
  const iotRadiusRef = React.useRef(0.35);
  const remapIotRef = React.useRef(false);
  const trackPathRef = React.useRef<THREE.Vector3[]>([]);
  const [bimOn, setBimOn] = React.useState(true);
  const [pointCloudOn, setPointCloudOn] = React.useState(true);
  const [iotOn, setIotOn] = React.useState(true);
  const [sensors, setSensors] = React.useState<IotSensor[]>([]);
  const [selectedSensorId, setSelectedSensorId] = React.useState<string | null>(null);
  const [iotChannel, setIotChannel] = React.useState("alignment_r");
  const [heatmapFilter, setHeatmapFilter] = React.useState<HeatmapFilter>("sleepers");
  const [iotYear, setIotYear] = React.useState(2024);
  const [iotView, setIotView] = React.useState<IoTDataView | null>(null);
  const [iotPanelViews, setIotPanelViews] = React.useState<IotPanelView[]>([]);
  const [iotTrackReady, setIotTrackReady] = React.useState(false);
  const toggleIotPanelRef = React.useRef<(action?: IotPanelView | "sprites") => void>(() => {});
  const initialCameraRef = React.useRef<{
    eye: [number, number, number];
    target: [number, number, number];
    distance: number;
  } | null>(null);
  const resetCameraRef = React.useRef(() => {});
  const [zoomHud, setZoomHud] = React.useState({
    ratio: 1,
    percent: 0,
    atMax: false,
    ready: false,
  });

  const openIotPanel = (view: IotPanelView) => {
    setIotPanelViews((current) => (current.includes(view) ? current : withIotPanel(current, view)));
  };
  const closeIotPanel = (view: IotPanelView) => {
    setIotPanelViews((current) => current.filter((item) => item !== view));
  };
  toggleIotPanelRef.current = (action = "heatmap") => {
    if (action === "sprites") {
      setIotOn((visible) => !visible);
      return;
    }
    setIotPanelViews((current) =>
      current.includes(action as IotPanelView)
        ? current.filter((view) => view !== action)
        : withIotPanel(current, action as IotPanelView),
    );
  };

  React.useEffect(() => {
    const active = [...iotPanelViews, ...(iotOn ? ["sprites"] : [])];
    (window as any).__obIotActiveTools = active;
    window.dispatchEvent(new CustomEvent("ob-iot-tools-change", { detail: { active } }));
  }, [iotPanelViews, iotOn, layersReady]);

  const syncZoomHud = (controls = world?.camera?.controls) => {
    if (!controls) return;
    const current = scanOrbitDistance(controls);
    const initial = initialCameraRef.current?.distance || current;
    if (!(initial > 0) || !(current > 0)) return;
    const percent = zoomProgressFromDistance(current, initial, SCAN_CLOSE_DISTANCE);
    setZoomHud({
      ratio: displayZoomRatio(percent * 100),
      percent: Math.round(percent * 100),
      atMax: percent >= 0.98 || current <= SCAN_CLOSE_DISTANCE * 1.08,
      ready: true,
    });
  };

  const captureCameraPose = (controls: any, force = false) => {
    if (!controls || (initialCameraRef.current && !force)) return;
    const eye = new THREE.Vector3();
    const target = new THREE.Vector3();
    if (typeof controls.getPosition === "function") controls.getPosition(eye);
    else if (controls.camera?.position) eye.copy(controls.camera.position);
    if (typeof controls.getTarget === "function") controls.getTarget(target);
    else if (controls._target) target.copy(controls._target);
    if (eye.lengthSq() === 0 && target.lengthSq() === 0) return;
    const distance = eye.distanceTo(target) || scanOrbitDistance(controls);
    initialCameraRef.current = { eye: [eye.x, eye.y, eye.z], target: [target.x, target.y, target.z], distance };
    scanZoomOutLimitRef.current = distance;
    controls.maxDistance = distance;
    syncZoomHud(controls);
  };

  const resetCamera = () => {
    const controls = world?.camera?.controls;
    const cam = world?.camera;
    const pose = initialCameraRef.current;
    tuneScanNavigation(cam);
    if (pose && controls?.setLookAt) {
      controls.setLookAt(...pose.eye, ...pose.target, true);
    } else {
      const group = ifcModelsRef.current.find((item) => item.name === "guzergah-mesh");
      if (group) {
        fitCameraToRail(controls, railFocusBox(group));
      } else if (ifcModelsRef.current.length) {
        const box = new THREE.Box3();
        for (const model of ifcModelsRef.current) box.expandByObject(model);
        if (!box.isEmpty()) fitCameraToRail(controls, box);
      } else if (controls?.setLookAt) {
        controls.setLookAt(20, 20, 20, 0, 0, 0, true);
      }
    }
    applyScanClipPlanes(cam);
    engine?.fragments.core.update(true);
    syncZoomHud(controls);
  };
  resetCameraRef.current = resetCamera;

  scanDollyPickRef.current = (ndcX: number, ndcY: number) => {
    const camera = world?.camera?.three as THREE.Camera | undefined;
    if (!camera) return null;
    const ndc = new THREE.Vector2(ndcX, ndcY);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    const path = trackPathRef.current;
    if (path.length) {
      const ray = raycaster.ray;
      let best: THREE.Vector3 | null = null;
      let bestDist = 45;
      for (const point of path) {
        const dist = ray.distanceToPoint(point);
        if (dist < bestDist) {
          bestDist = dist;
          best = point;
        }
      }
      return best?.clone() || null;
    }
    const meshes: THREE.Object3D[] = [];
    for (const root of ifcModelsRef.current) {
      root.traverse((child) => {
        if ((child as THREE.Mesh).isMesh && child.visible) meshes.push(child);
      });
    }
    if (iotGroupRef.current?.visible) {
      iotGroupRef.current.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) meshes.push(child);
      });
    }
    const meshHit = raycaster.intersectObjects(meshes, false)[0];
    return meshHit ? meshHit.point.clone() : null;
  };

  const applyZoomPercent = (percent: number) => {
    const controls = world?.camera?.controls;
    const initial = initialCameraRef.current?.distance;
    if (!controls?.setLookAt || !initial) return;
    const next = distanceFromZoomProgress(percent / 100, initial, SCAN_CLOSE_DISTANCE);
    const { eye, target } = readCameraPose(controls);
    const dir = eye.clone().sub(target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 1, 1);
    dir.normalize();
    const nextEye = target.clone().addScaledVector(dir, next);
    controls.setLookAt(nextEye.x, nextEye.y, nextEye.z, target.x, target.y, target.z, false);
    applyScanClipPlanes(world?.camera);
    syncZoomHud(controls);
  };

  const scanHost = {
    world,
    iotOn,
    iotChannel,
    iotYear,
    bimOn,
    pointCloudOn,
    pointCloudRef,
    iotGroupRef,
    iotViewRef,
    modelBoxRef,
    iotRadiusRef,
    remapIotRef,
    trackPathRef,
    ifcModelsRef,
    v3ModelRef,
    setSensors,
    setIotView,
    setIotChannel,
    setLayersReady,
    setIotTrackReady,
    setScanIfcStatus,
    setModelLoaded,
    captureCameraPose,
    fragmentRoutes,
    onFragmentsUpdate: () => engine?.fragments.core.update(true),
  };

  const { rebuildIotSprites, attachSceneLayers, loadScanIfcModels, revealScanLayers } =
    createScanLayers(scanHost);

  const focusSensor = (id: string) => {
    setSelectedSensorId(id);
    const sensor = sensors.find((item) => item.id === id);
    const controls = world?.camera?.controls;
    if (!sensor || !controls?.setLookAt) return;
    const [x, y, z] = sensor.position;
    const d = Math.max(iotRadiusRef.current * 8, 8);
    controls.setLookAt(x + d, y + d * 0.75, z + d, x, y, z, true);
    engine?.fragments.core.update(true);
  };

  const clearScanSelection = () => {
    scanSelectionColorCleanupRef.current?.();
    scanSelectionColorCleanupRef.current = null;
    const outline = scanSelectionOutlineRef.current;
    const scene = world?.scene?.three as THREE.Scene | undefined;
    if (outline) {
      scene?.remove(outline);
      outline.geometry.dispose();
      (outline.material as THREE.Material).dispose();
      scanSelectionOutlineRef.current = null;
    }
    setScanSelection(null);
  };

  const viewerTools = useViewerTools(engine, {
    loaded: engine?.loadedIds ?? [],
    onFit: () => void resetCamera(),
  });

  const scanInitRef = React.useRef(false);

  const handleReady = React.useCallback((readyEngine: ViewerEngine) => {
    scanInitRef.current = false;
    setEngine(readyEngine);
    setWorld(readyEngine.world);
    setError(null);
    setLoading(true);
    setModelLoaded(false);
    setLayersReady(false);
    scanZoomOutLimitRef.current = SCAN_MAX_DISTANCE;
    initialCameraRef.current = null;
    clearScanSelection();
  }, []);

  React.useEffect(() => {
    if (!engine || !world || scanInitRef.current) return;
    scanInitRef.current = true;
    const currentWorld = world;
    void (async () => {
      try {
        setLoadDetail("LAS arazi noktaları yükleniyor");
        await attachSceneLayers(currentWorld, new THREE.Box3(), true);
        setScanSteps((prev) => ({ ...prev, las: true }));
        setLoadDetail("BIM / güzergah modeli yükleniyor");
        await loadScanIfcModels(currentWorld, {
          loadFragment: async (route) => {
            const modelId = route.split("/").pop()?.replace(/\.frag$/i, "") || "guzergah";
            await engine.load(modelId, resolveModelUrl(route));
            const model = engine.fragments.list.get(modelId);
            const object = model?.object as THREE.Object3D | undefined;
            if (object) {
              object.visible = false;
              object.name = modelId;
              ifcModelsRef.current.push(object);
            }
            v3ModelRef.current = model;
          },
          onFragmentsUpdate: () => engine.fragments.core.update(true),
        });
        setScanSteps((prev) => ({
          ...prev,
          bim: true,
          iot: Boolean(iotGroupRef.current),
        }));
        if (iotViewRef.current && !iotGroupRef.current) {
          setLoadDetail("Ölçüm noktaları yerleştiriliyor");
        }
        setScanSteps((prev) => ({ ...prev, iot: Boolean(iotGroupRef.current) || prev.iot }));
        revealScanLayers();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Scan sahnesi yüklenemedi.");
      } finally {
        setLoading(false);
      }
    })();
  }, [engine, world, attachSceneLayers, loadScanIfcModels, revealScanLayers]);

  React.useEffect(() => {
    if (!layersReady) return;
    if (pointCloudRef.current) pointCloudRef.current.visible = pointCloudOn;
  }, [pointCloudOn, layersReady]);

  React.useEffect(() => {
    if (!layersReady) return;
    if (iotGroupRef.current) iotGroupRef.current.visible = iotOn;
  }, [iotOn, layersReady]);

  React.useEffect(() => {
    if (!layersReady) return;
    const object = v3ModelRef.current?.object;
    if (object) object.visible = bimOn;
    for (const model of ifcModelsRef.current) model.visible = bimOn;
  }, [bimOn, layersReady]);

  React.useEffect(() => {
    const controls = world?.camera?.controls;
    if (!controls) return;
    let frame = 0;
    const onMove = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        syncZoomHud(controls);
      });
    };
    controls.addEventListener("update", onMove);
    controls.addEventListener("control", onMove);
    controls.addEventListener("controlend", onMove);
    syncZoomHud(controls);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      controls.removeEventListener("update", onMove);
      controls.removeEventListener("control", onMove);
      controls.removeEventListener("controlend", onMove);
    };
  }, [world, layersReady, modelLoaded]);

  React.useEffect(() => {
    if (containerRef.current) scanViewerDomRef.current = containerRef.current;
    if (world?.camera) {
      tuneScanNavigation(world.camera);
      installScanWheelZoom(world.camera);
    }
  }, [world, layersReady, modelLoaded]);

  React.useEffect(() => {
    const mesh = ifcModelsRef.current.find((item) => item.name === "guzergah-mesh");
    const heatmapOpen = iotPanelViews.includes("heatmap");
    if (!heatmapOpen) applyTrackHeatmap(mesh, [], heatmapFilter, false);
    if (!layersReady || !iotViewRef.current || !modelBoxRef.current) return;
    if (remapIotRef.current && trackPathRef.current.length < 2) return;
    const nextSensors = iotViewRef.current.toSceneSensors(
      modelBoxRef.current,
      iotChannel,
      iotYear,
      remapIotRef.current,
      trackPathRef.current,
    );
    rebuildIotSprites(nextSensors);
    if (iotGroupRef.current) {
      paintIotLayer(iotGroupRef.current, nextSensors);
      iotGroupRef.current.visible = iotOn;
    }
    applyTrackHeatmap(mesh, nextSensors, heatmapFilter, heatmapOpen);
  }, [iotChannel, iotYear, layersReady, iotTrackReady, heatmapFilter, iotPanelViews, iotOn]);

  React.useEffect(() => {
    if (!bimOn && scanSelection) clearScanSelection();
  }, [bimOn]);

  React.useEffect(() => {
    const container = containerRef.current;
    const camera = world?.camera?.three as THREE.Camera | undefined;
    if (!container || !camera || !layersReady) return;
    const pointerDown = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    const onPointerDown = (event: PointerEvent) => {
      pointerDown.set(event.clientX, event.clientY);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5) return;
      if ((event.target as HTMLElement).closest("button, input, select, [data-iot-panel], [data-model-panel]")) return;
      const rect = container.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const iotGroup = iotGroupRef.current;
      const sensorHit = iotGroup?.visible
        ? raycaster.intersectObject(iotGroup, true).find((intersection) => Boolean(iotSensorIdFromHit(intersection)))
        : undefined;
      const sensorId = sensorHit ? iotSensorIdFromHit(sensorHit) : undefined;
      if (sensorId) {
        clearScanSelection();
        focusSensor(sensorId);
        openIotPanel("detail");
        return;
      }
      const scanRoot = ifcModelsRef.current.find((item) => item.name === "guzergah-mesh");
      const scene = world?.scene?.three as THREE.Scene | undefined;
      if (!scanRoot || !scene) return;
      const sleepers = scanRoot.getObjectByName("guzergah-sleepers");
      const rails = scanRoot.getObjectByName("guzergah-rails");
      const modelHit =
        (sleepers ? raycaster.intersectObject(sleepers, false)[0] : undefined)
        || (rails ? raycaster.intersectObject(rails, false)[0] : undefined);
      const nextSelection = modelHit
        ? scanElementFromHit(scanRoot, modelHit.object, modelHit.faceIndex ?? undefined)
        : null;
      clearScanSelection();
      if (nextSelection) {
        const outline = createScanSelectionOutline(nextSelection.box);
        scene.add(outline);
        scanSelectionOutlineRef.current = outline;
        scanSelectionColorCleanupRef.current = applyScanSelectionColor(nextSelection);
        setScanSelection(nextSelection);
      }
    };
    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointerup", onPointerUp);
    return () => {
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointerup", onPointerUp);
    };
  }, [world, layersReady, sensors]);

  const iotActive = [...iotPanelViews, ...(iotOn ? ["sprites"] : [])];

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        background: "var(--background-200)",
      }}
    >
      <ViewerCanvas
        workerUrl="/fragments-worker.mjs"
        extensions={extensions}
        onReady={handleReady}
        onError={(viewerError) => {
          setError(
            viewerError instanceof Error ? viewerError.message : "Görüntüleyici başlatılamadı.",
          );
          setLoading(false);
        }}
      />

      <ViewerToolsHud
        {...viewerTools}
        loaded={layersReady && !loading}
        branding={branding}
      />

      <LoadingOverlay
        show={loading}
        title="Sahne hazırlanıyor"
        detail={loadDetail}
        steps={[
          { id: "las", label: "LAS arazi", done: scanSteps.las },
          { id: "bim", label: "BIM / güzergah", done: scanSteps.bim },
          { id: "iot", label: "Ölçüm noktaları", done: scanSteps.iot },
        ]}
      />
      <ErrorOverlay message={error} />

      {layersReady && !loading && (
        <LayerVisibilityControl
          modelVisible={bimOn}
          lasVisible={pointCloudOn}
          onModelVisible={setBimOn}
          onLasVisible={setPointCloudOn}
        />
      )}

      {layersReady && !loading && (
        <ScanIotToolbar
          active={iotActive}
          onToggle={(action) => toggleIotPanelRef.current(action)}
        />
      )}

      {!loading && scanSelection && (
        <ModelElementPanel
          selection={scanSelection}
          meta={ifcModelsRef.current.find((item) => item.name === "guzergah-mesh")?.userData.ifcMeta}
          onClose={clearScanSelection}
        />
      )}

      <ZoomHud
        visible={!loading && (modelLoaded || layersReady)}
        zoom={zoomHud}
        status={!error && modelLoaded ? scanStatusText(true, scanIfcStatus) : null}
        onReset={resetCamera}
        onZoomPercent={applyZoomPercent}
      />

      {layersReady && !loading && iotPanelViews.map((view) => (
        <IoTExtensionPanel
          key={view}
          view={view}
          bimOn={bimOn}
          pointCloudOn={pointCloudOn}
          sensors={sensors}
          selectedId={selectedSensorId}
          dataView={iotView}
          channelId={iotChannel}
          year={iotYear}
          onChannel={setIotChannel}
          onYear={setIotYear}
          onToggleBim={setBimOn}
          onTogglePointCloud={setPointCloudOn}
          onSelect={focusSensor}
          onOpenDetail={() => openIotPanel("detail")}
          onClose={() => closeIotPanel(view)}
          heatmapFilter={heatmapFilter}
          onHeatmapFilter={setHeatmapFilter}
        />
      ))}
    </div>
  );
}
