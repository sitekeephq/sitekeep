/**
 * Scan project layers: LAS preview, IoT markers, güzergah mesh, optional frag fallback.
 */
import * as THREE from "three";
import { createSamplePointCloud, loadLasPreview } from "./layers/pointCloud.js";
import {
  ensureScanLights,
  extractTrackPath,
  fitCameraToRail,
  loadGuzergahMesh,
  railFocusBox,
} from "./layers/ifcMesh.js";
import { createIotLayer, iotMarkerRadius } from "./layers/iotLayer.js";
import type { IotSensor } from "./types.js";
import { IoTDataView } from "./iot/dataView.js";
import { tuneScanNavigation } from "./navigation/scanNavigation.js";

export interface ScanLayerHost {
  world?: { scene?: { three?: THREE.Scene }; camera?: any };
  iotOn: boolean;
  iotChannel: string;
  iotYear: number;
  bimOn: boolean;
  pointCloudOn: boolean;
  pointCloudRef: { current: THREE.Points | null };
  iotGroupRef: { current: THREE.Group | null };
  iotViewRef: { current: IoTDataView | null };
  modelBoxRef: { current: THREE.Box3 | null };
  iotRadiusRef: { current: number };
  remapIotRef: { current: boolean };
  trackPathRef: { current: THREE.Vector3[] };
  ifcModelsRef: { current: THREE.Object3D[] };
  v3ModelRef: { current: { object?: THREE.Object3D } | null };
  setSensors: (sensors: IotSensor[]) => void;
  setIotView: (view: IoTDataView | null) => void;
  setIotChannel: (channel: string) => void;
  setLayersReady: (ready: boolean) => void;
  setIotTrackReady: (ready: boolean) => void;
  setScanIfcStatus: (status: "off" | "loading" | "ready" | "error") => void;
  setModelLoaded: (loaded: boolean) => void;
  captureCameraPose: (controls: any, force?: boolean) => void;
  fragmentRoutes: string[];
  onFragmentsUpdate?: () => void;
}

/**
 * The sphere That Open's OrthoPerspectiveCamera.fit(meshes, offset) frames for one box: it starts its bounds at
 * min = +MAX_VALUE and max = +MIN_VALUE (the smallest positive number, not -MAX_VALUE), so on an axis
 * where the box lies below zero the bounds reach out to the origin; radius = largest side × offset.
 * The scan view's starting distance has always come from this; a sphere around the box alone put the
 * camera far too close (0.3.1 – 0.4.1).
 */
export function thatOpenFitSphere(center: THREE.Vector3, size: THREE.Vector3, offset: number): THREE.Sphere {
  const box = new THREE.Box3().setFromCenterAndSize(center, size);
  const min = new THREE.Vector3(Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE).min(box.min);
  const max = new THREE.Vector3(Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE).max(box.max);
  const bounds = new THREE.Box3(min, max);
  const extent = bounds.getSize(new THREE.Vector3());
  return new THREE.Sphere(bounds.getCenter(new THREE.Vector3()), Math.max(extent.x, extent.y, extent.z) * offset);
}

export function createScanLayers(host: ScanLayerHost) {
  const {
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
    onFragmentsUpdate,
  } = host;

  const scanRevealedRef = { current: false };

  const applyLayerVisibility = () => {
    const shown = scanRevealedRef.current;
    if (pointCloudRef.current) pointCloudRef.current.visible = shown && pointCloudOn;
    if (iotGroupRef.current) iotGroupRef.current.visible = shown && iotOn;
    for (const model of ifcModelsRef.current) model.visible = shown && bimOn;
    const v3 = v3ModelRef.current?.object;
    if (v3) v3.visible = shown && bimOn;
  };

  const revealScanLayers = () => {
    scanRevealedRef.current = true;
    applyLayerVisibility();
    setLayersReady(true);
    setModelLoaded(true);
  };

  const rebuildIotSprites = (nextSensors: IotSensor[], sceneOverride?: THREE.Scene) => {
    const scene = sceneOverride || world?.scene?.three;
    if (!scene) return;
    if (iotGroupRef.current) scene.remove(iotGroupRef.current);
    const iot = createIotLayer(nextSensors, iotRadiusRef.current);
    iot.visible = scanRevealedRef.current && iotOn;
    scene.add(iot);
    iotGroupRef.current = iot;
    setSensors(nextSensors);
  };

  const attachSceneLayers = async (currentWorld: ScanLayerHost["world"], box: THREE.Box3, useLas = false) => {
    if (!currentWorld?.scene?.three) return;
    const scene = currentWorld.scene.three;

    if (pointCloudRef.current) {
      scene.remove(pointCloudRef.current);
      pointCloudRef.current.geometry.dispose();
      (pointCloudRef.current.material as THREE.Material).dispose();
    }
    if (iotGroupRef.current) scene.remove(iotGroupRef.current);

    let points: THREE.Points | null = null;
    let layerBox = box && !box.isEmpty() ? box.clone() : new THREE.Box3();

    if (useLas) {
      try {
        points = await loadLasPreview();
      } catch (error) {
        console.warn("LAS preview yüklenemedi:", error);
      }
      if (points?.geometry.boundingBox && !points.geometry.boundingBox.isEmpty()) {
        layerBox.copy(points.geometry.boundingBox);
      }
    }
    if (!points) {
      if (layerBox.isEmpty()) return;
      points = createSamplePointCloud(layerBox);
    }

    modelBoxRef.current = layerBox;
    remapIotRef.current = useLas;
    iotRadiusRef.current = iotMarkerRadius(layerBox);
    points.visible = false;
    scene.add(points);
    pointCloudRef.current = points;

    if (useLas && !layerBox.isEmpty()) {
      const center = layerBox.getCenter(new THREE.Vector3());
      const size = layerBox.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z, 20) * 0.55;
      const controls = currentWorld.camera?.controls;
      tuneScanNavigation(currentWorld.camera);
      if (controls?.fitToSphere) {
        controls.fitToSphere(new THREE.Sphere(center, radius), true);
      }
      onFragmentsUpdate?.();
    }

    const view = new IoTDataView();
    await view.init();
    iotViewRef.current = view;
    setIotView(view);
    const firstChannel = view.channels.has(iotChannel)
      ? iotChannel
      : view.channels.has("alignment_r")
        ? "alignment_r"
        : [...view.channels.keys()][0] || "cant";
    if (firstChannel !== iotChannel) setIotChannel(firstChannel);
    if (!useLas || trackPathRef.current.length >= 2) {
      const nextSensors = view.toSceneSensors(layerBox, firstChannel, iotYear, useLas, trackPathRef.current);
      const iot = createIotLayer(nextSensors, iotRadiusRef.current);
      iot.visible = false;
      scene.add(iot);
      iotGroupRef.current = iot;
      setSensors(nextSensors);
    }
  };

  const loadScanIfcModels = async (
    currentWorld: ScanLayerHost["world"],
    options?: {
      loadFragment?: (route: string) => Promise<void>;
      onFragmentsUpdate?: () => void;
    },
  ) => {
    const scene = currentWorld?.scene?.three;
    if (!scene) return;
    setScanIfcStatus("loading");
    ifcModelsRef.current = [];
    ensureScanLights(scene);

    try {
      const mesh = await loadGuzergahMesh();
      if (mesh) {
        mesh.visible = false;
        scene.add(mesh);
        ifcModelsRef.current.push(mesh);
        const cam = currentWorld!.camera;
        tuneScanNavigation(cam);
        try {
          await cam?.projection?.set?.("Perspective");
          cam?.set?.("Orbit");
        } catch {
          /* ignore */
        }
        const focus = railFocusBox(mesh);
        fitCameraToRail(cam?.controls, focus);
        if (typeof cam?.controls?.fitToSphere === "function") {
          // The framing of camera.fit([36 × 6 × 36 box], 2.2), without its transition (the animated
          // fit's "rest" event sometimes never came and the loading overlay stayed up for good).
          await cam.controls.fitToSphere(thatOpenFitSphere(focus.getCenter(new THREE.Vector3()), new THREE.Vector3(36, 6, 36), 2.2), false);
        }
        captureCameraPose(cam?.controls, true);
        setScanIfcStatus("ready");
        const path = extractTrackPath(mesh);
        trackPathRef.current = path;
        setIotTrackReady(path.length >= 2);
        if (path.length >= 2 && iotViewRef.current && modelBoxRef.current) {
          iotRadiusRef.current = 0.55;
          const nextSensors = iotViewRef.current.toSceneSensors(
            modelBoxRef.current,
            iotChannel,
            iotYear,
            true,
            path,
          );
          rebuildIotSprites(nextSensors, scene);
        }
        return;
      }
    } catch (error) {
      console.warn("Güzergah mesh yüklenemedi:", error);
    }

    const routes = fragmentRoutes.filter((route) => route.toLowerCase().endsWith(".frag"));
    if (!routes.length) {
      setScanIfcStatus("error");
      return;
    }

    for (const route of routes) {
      try {
        if (options?.loadFragment) await options.loadFragment(route);
        options?.onFragmentsUpdate?.();
        onFragmentsUpdate?.();
      } catch (error) {
        console.warn("Scan frag atlandı", route, error);
      }
    }

    setScanIfcStatus(ifcModelsRef.current.length ? "ready" : "error");
  };

  return { rebuildIotSprites, attachSceneLayers, loadScanIfcModels, revealScanLayers };
}
