/**
 * View cube (top-right): a small CSS 3D cube turned with the camera. Clicking a face looks at the
 * model from that side around the current orbit point. It follows the camera only when the camera
 * moves (controls "update"), so it costs nothing while the view is still.
 */
import * as THREE from "three";
import type { ViewerEngine } from "../core/ViewerEngine.js";

export type CubeFace = "front" | "back" | "right" | "left" | "top" | "bottom";

/** Face labels and the direction the camera looks from (scene axes, Y up; front = +Z = IFC south). */
export const CUBE_FACES: { face: CubeFace; label: string; dir: [number, number, number]; rot: [number, number, number] }[] = [
  { face: "front", label: "Ön", dir: [0, 0, 1], rot: [0, 0, 0] },
  { face: "back", label: "Arka", dir: [0, 0, -1], rot: [0, Math.PI, 0] },
  { face: "right", label: "Sağ", dir: [1, 0, 0], rot: [0, Math.PI / 2, 0] },
  { face: "left", label: "Sol", dir: [-1, 0, 0], rot: [0, -Math.PI / 2, 0] },
  { face: "top", label: "Üst", dir: [0, 1, 0], rot: [-Math.PI / 2, 0, 0] },
  { face: "bottom", label: "Alt", dir: [0, -1, 0], rot: [Math.PI / 2, 0, 0] },
];

const eps = (v: number) => (Math.abs(v) < 1e-10 ? 0 : v);

/** three.js matrix → CSS matrix3d for an object (CSS y points down). Same as CSS3DRenderer. */
function objectCss(m: THREE.Matrix4): string {
  const e = m.elements;
  return `matrix3d(${[e[0], e[1], e[2], e[3], -e[4], -e[5], -e[6], -e[7], e[8], e[9], e[10], e[11], e[12], e[13], e[14], e[15]].map(eps).join(",")})`;
}

/** View (camera inverse) matrix → CSS matrix3d. Same as CSS3DRenderer. */
function cameraCss(m: THREE.Matrix4): string {
  const e = m.elements;
  return `matrix3d(${[e[0], -e[1], e[2], e[3], e[4], -e[5], e[6], e[7], e[8], -e[9], e[10], e[11], e[12], -e[13], e[14], e[15]].map(eps).join(",")})`;
}

export class ViewCube {
  private readonly root: HTMLDivElement;
  private readonly cube: HTMLDivElement;
  private readonly view = new THREE.Matrix4();
  private raf = 0;

  constructor(
    private readonly engine: ViewerEngine,
    host: HTMLElement,
    private readonly size = 72,
    /** Runs before turning the camera (the walk mode hands the camera back first). */
    private readonly beforeLook: () => Promise<void> | void = () => undefined,
  ) {
    this.root = document.createElement("div");
    this.root.className = "vt-cube";
    this.root.style.width = this.root.style.height = `${size * 1.5}px`;
    this.root.setAttribute("role", "group");
    this.root.setAttribute("aria-label", "Görünüm küpü");
    this.cube = document.createElement("div");
    this.cube.className = "vt-cube-body";
    const half = size / 2;
    for (const f of CUBE_FACES) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `vt-cube-face vt-cube-${f.face}`;
      el.textContent = f.label;
      el.title = `${f.label} görünüş`;
      const o = new THREE.Object3D();
      o.rotation.set(...f.rot);
      o.position.set(f.dir[0] * half, f.dir[1] * half, f.dir[2] * half);
      o.updateMatrix();
      el.style.width = el.style.height = `${size}px`;
      el.style.transform = `translate(-50%, -50%) ${objectCss(o.matrix)}`;
      el.addEventListener("click", () => void this.lookFrom(f.dir));
      this.cube.appendChild(el);
    }
    this.root.appendChild(this.cube);
    host.appendChild(this.root);
    engine.world.camera.controls.addEventListener("update", this.schedule);
    this.update();
  }

  /** Camera to the given side of the orbit point, keeping the distance. */
  async lookFrom(dir: [number, number, number]) {
    await this.beforeLook();
    const controls = this.engine.world.camera.controls;
    const target = controls.getTarget(new THREE.Vector3());
    const pos = controls.getPosition(new THREE.Vector3());
    const dist = Math.max(pos.distanceTo(target), 1);
    // Straight up / down leaves the azimuth undefined: nudge towards the front.
    const d = new THREE.Vector3(...dir);
    if (Math.abs(d.y) > 0.99) d.z += 0.001;
    d.normalize().multiplyScalar(dist).add(target);
    await controls.setLookAt(d.x, d.y, d.z, target.x, target.y, target.z, true);
    this.engine.fragments.core.update(true);
  }

  private schedule = () => {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.update();
    });
  };

  private update() {
    const cam = this.engine.world.camera.three;
    // Rotation only: the cube sits still in its corner.
    this.view.makeRotationFromQuaternion(cam.quaternion).invert();
    this.cube.style.transform = `translate(${this.size * 0.75}px, ${this.size * 0.75}px) ${cameraCss(this.view)}`;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    try {
      this.engine.world.camera.controls.removeEventListener("update", this.schedule);
    } catch {
      // Camera already disposed.
    }
    this.root.remove();
  }
}
