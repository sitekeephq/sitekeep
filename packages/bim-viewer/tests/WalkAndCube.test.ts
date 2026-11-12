import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ViewCube } from "../src/tools/view-cube";
import { WalkController } from "../src/tools/walk";
import { WALK_SPEED } from "../src/tools/walk-math";
import { fakeModel, makeEngineStub } from "./helpers/engine-stub";

describe("WalkController", () => {
  it("starts at a dropped-in eye, clamps speed and stops", async () => {
    const { engine, camera } = makeEngineStub([fakeModel({ id: "arch" })]);
    const walk = new WalkController(engine);
    await walk.start(new THREE.Vector3(1, 1.7, 2));
    expect(walk.active).toBe(true);
    expect(camera.controls.enabled).toBe(false);
    walk.setSpeed(99);
    expect(walk.speed).toBe(WALK_SPEED.max);
    walk.setJoystick({ forward: 1, right: 0, up: 0, run: false });
    walk.stop();
    expect(walk.active).toBe(false);
    expect(camera.controls.enabled).toBe(true);
    walk.dispose();
  });
});

describe("ViewCube", () => {
  it("mounts face buttons into the host and removes them on dispose", () => {
    const { engine } = makeEngineStub([fakeModel({ id: "arch" })]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const cube = new ViewCube(engine, host, 48);
    expect(host.querySelector(".vt-cube")).toBeTruthy();
    expect(host.querySelectorAll(".vt-cube-face").length).toBe(6);
    cube.dispose();
    expect(host.querySelector(".vt-cube")).toBeNull();
    host.remove();
  });
});
