import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  SCAN_CLOSE_DISTANCE,
  SCAN_MAX_DISTANCE,
  applyScanClipPlanes,
  displayZoomRatio,
  distanceFromZoomProgress,
  flyScanCamera,
  readCameraPose,
  zoomProgressFromDistance,
} from "../src/scan/navigation/scanNavigation";

describe("scan zoom mapping", () => {
  it("is 0 at the start distance and 1 when close", () => {
    expect(zoomProgressFromDistance(40, 40, 0.4)).toBe(0);
    expect(zoomProgressFromDistance(0.4, 40, 0.4)).toBe(1);
    const mid = zoomProgressFromDistance(8, 40, 0.4);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(distanceFromZoomProgress(0, 40, 0.4)).toBeCloseTo(40);
    expect(distanceFromZoomProgress(1, 40, 0.4)).toBeCloseTo(0.4);
  });

  it("maps the HUD percent onto 1×–10×", () => {
    expect(displayZoomRatio(0)).toBe(1);
    expect(displayZoomRatio(100)).toBe(10);
    expect(displayZoomRatio(50)).toBe(5.5);
  });
});

describe("scan camera helpers", () => {
  it("reads pose from getPosition / getTarget", () => {
    const controls = {
      getPosition: (out: THREE.Vector3) => out.set(1, 2, 3),
      getTarget: (out: THREE.Vector3) => out.set(4, 5, 6),
    };
    const pose = readCameraPose(controls);
    expect(pose.eye.toArray()).toEqual([1, 2, 3]);
    expect(pose.target.toArray()).toEqual([4, 5, 6]);
  });

  it("dollies in toward the hit and does not pass the close distance", () => {
    const setLookAt = vi.fn();
    const controls = {
      getPosition: (out: THREE.Vector3) => out.set(0, 0, 40),
      getTarget: (out: THREE.Vector3) => out.set(0, 0, 0),
      setLookAt,
    };
    flyScanCamera(controls, true, new THREE.Vector3(0, 0, 0));
    expect(setLookAt).toHaveBeenCalledOnce();
    const [, , z, , , tz] = setLookAt.mock.calls[0] as number[];
    expect(tz).toBe(0);
    expect(z).toBeGreaterThan(SCAN_CLOSE_DISTANCE - 1e-6);
    expect(z).toBeLessThan(40);
  });

  it("stops dollying out at the max orbit distance", () => {
    const setLookAt = vi.fn();
    flyScanCamera(
      {
        getPosition: (out: THREE.Vector3) => out.set(0, 0, SCAN_MAX_DISTANCE),
        getTarget: (out: THREE.Vector3) => out.set(0, 0, 0),
        setLookAt,
      },
      false,
      new THREE.Vector3(0, 0, 0),
    );
    expect(setLookAt).not.toHaveBeenCalled();
  });

  it("tightens near/far from the orbit distance", () => {
    const three = {
      near: 1,
      far: 1,
      updateProjectionMatrix: vi.fn(),
    };
    applyScanClipPlanes({
      three,
      controls: { getDistance: () => 20 },
    });
    expect(three.near).toBeGreaterThan(0);
    expect(three.far).toBeGreaterThan(three.near);
    expect(three.updateProjectionMatrix).toHaveBeenCalledOnce();
  });
});
