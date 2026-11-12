/**
 * Scan (LAS + güzergah) kamera kontrolü.
 * Tekerlek zoom’u ray yüzeyine uçar; orbit-radius kilitlenmesin diye
 * That Open camera-controls wheel’i kapatılır.
 */
import * as THREE from "three";

export const SCAN_MIN_DISTANCE = 0.22;
export const SCAN_CLOSE_DISTANCE = 0.4;
export const SCAN_MAX_DISTANCE = 20000;
export const SCAN_ZOOM_DISPLAY_MAX = 10;

export const scanDollyPickRef: { current: (ndcX: number, ndcY: number) => THREE.Vector3 | null } = {
  current: () => null,
};
export const scanViewerDomRef: { current: HTMLElement | null } = { current: null };
export const scanZoomOutLimitRef: { current: number } = { current: SCAN_MAX_DISTANCE };

export function readCameraPose(controls: any) {
  const eye = new THREE.Vector3();
  const target = new THREE.Vector3();
  if (typeof controls.getPosition === "function") controls.getPosition(eye);
  else if (controls.camera?.position) eye.copy(controls.camera.position);
  if (typeof controls.getTarget === "function") controls.getTarget(target);
  else if (controls._target) target.copy(controls._target);
  return { eye, target };
}

export function flyScanCamera(
  controls: any,
  zoomIn: boolean,
  hit: THREE.Vector3 | null,
  maxDistance = SCAN_MAX_DISTANCE
) {
  if (!controls?.setLookAt) return;
  const { eye, target } = readCameraPose(controls);
  const aim = hit?.clone() || target.clone();
  const dir = new THREE.Vector3().subVectors(aim, eye);
  let remaining = dir.length();
  if (remaining < 0.05) {
    dir.subVectors(target, eye);
    remaining = dir.length();
  }
  if (remaining < 0.05) return;
  dir.multiplyScalar(1 / remaining);
  if (zoomIn) {
    const step = remaining > 10 ? Math.max(5, remaining * 0.32) : Math.max(0.28, remaining * 0.4);
    const next = Math.max(SCAN_CLOSE_DISTANCE, remaining - step);
    const nextEye = aim.clone().addScaledVector(dir, -next);
    controls.setLookAt(nextEye.x, nextEye.y, nextEye.z, aim.x, aim.y, aim.z, false);
    return;
  }
  const orbitDistance = eye.distanceTo(target);
  if (orbitDistance >= maxDistance * 0.999) return;
  const step = Math.max(4, remaining * 0.28);
  let nextEye = eye.clone().addScaledVector(dir, -step);
  const nextTarget = aim.clone().addScaledVector(dir, -step * 0.1);
  const nextDistance = nextEye.distanceTo(nextTarget);
  if (nextDistance > maxDistance) {
    const away = nextEye.clone().sub(nextTarget).normalize();
    nextEye = nextTarget.clone().addScaledVector(away, maxDistance);
  }
  controls.setLookAt(nextEye.x, nextEye.y, nextEye.z, nextTarget.x, nextTarget.y, nextTarget.z, false);
}

export function scanOrbitDistance(controls: any): number {
  if (typeof controls?.getDistance === "function") return controls.getDistance();
  return controls?._sphericalEnd?.radius ?? controls?._spherical?.radius ?? 40;
}

export function zoomProgressFromDistance(current: number, initial: number, closeDistance: number) {
  const start = Math.max(initial, closeDistance * 1.2);
  const close = Math.max(closeDistance, 0.2);
  if (current >= start) return 0;
  if (current <= close * 1.05) return 1;
  return THREE.MathUtils.clamp(
    (Math.log(start) - Math.log(current)) / (Math.log(start) - Math.log(close)),
    0,
    1
  );
}

export function distanceFromZoomProgress(progress: number, initial: number, closeDistance: number) {
  const start = Math.max(initial, closeDistance * 1.2);
  const close = Math.max(closeDistance, 0.2);
  return Math.exp(THREE.MathUtils.lerp(Math.log(start), Math.log(close), THREE.MathUtils.clamp(progress, 0, 1)));
}

export function displayZoomRatio(percent: number) {
  return 1 + (SCAN_ZOOM_DISPLAY_MAX - 1) * THREE.MathUtils.clamp(percent / 100, 0, 1);
}

export function applyScanClipPlanes(cam: any) {
  const three = cam?.three;
  if (!three) return;
  const dist = scanOrbitDistance(cam.controls);
  three.near = THREE.MathUtils.clamp(dist * 0.02, 0.025, 0.8);
  three.far = dist < 30 ? Math.max(500, dist * 140) : 50000;
  three.updateProjectionMatrix();
}

export function installScanWheelZoom(cam: any) {
  const controls = cam?.controls;
  const dom = scanViewerDomRef.current || controls?._domElement;
  if (!cam || !controls || !dom || dom._scanWheelBound) return;
  dom._scanWheelBound = true;
  if (controls.mouseButtons) controls.mouseButtons.wheel = 0;
  if (Array.isArray(controls.colliderMeshes)) controls.colliderMeshes = [];
  dom.addEventListener(
    "wheel",
    (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('[data-iot-panel="true"], [data-model-panel="true"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const rect = dom.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      const hit = scanDollyPickRef.current(ndcX, ndcY);
      flyScanCamera(controls, event.deltaY < 0, hit, scanZoomOutLimitRef.current);
      applyScanClipPlanes(cam);
    },
    { capture: true, passive: false }
  );
}

export function tuneScanNavigation(cam: any) {
  if (!cam) return;
  const controls = cam.controls;
  if (cam.three) applyScanClipPlanes(cam);
  if (!controls) return;
  controls.minDistance = SCAN_MIN_DISTANCE;
  controls.maxDistance = Math.min(SCAN_MAX_DISTANCE, scanZoomOutLimitRef.current);
  controls.dollySpeed = 4;
  controls.truckSpeed = 2.8;
  controls.azimuthRotateSpeed = 1.05;
  controls.polarRotateSpeed = 0.95;
  controls.dollyToCursor = false;
  controls.infinityDolly = false;
  if (controls.mouseButtons) controls.mouseButtons.wheel = 0;
  if (Array.isArray(controls.colliderMeshes)) controls.colliderMeshes = [];
  if ("smoothTime" in controls) controls.smoothTime = 0.02;
  if ("draggingSmoothTime" in controls) controls.draggingSmoothTime = 0.02;
  if ("maxSpeed" in controls) controls.maxSpeed = Infinity;
  installScanWheelZoom(cam);
  if (!controls._scanClipBound) {
    controls._scanClipBound = true;
    const updateClip = () => applyScanClipPlanes(cam);
    controls.addEventListener("update", updateClip);
    controls.addEventListener("control", updateClip);
  }
}
