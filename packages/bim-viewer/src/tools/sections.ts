/**
 * Sections (Kesit) on top of OBC.Clipper: free planes (double-click a face), a section box with six
 * draggable faces and the horizontal cut of the "Plan" view. Cut edges and fills come from
 * OBF.ClipStyler when Fragments can compute sections (probed once, see `edgeMode`).
 */
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { Vec3, ViewpointSections } from "../core/types.js";
import { cssColor, type ViewerEngine } from "../core/ViewerEngine.js";
import { compactSectionMeshes } from "./section-meshes.js";

export type PlaneKind = "plane" | "box" | "plan";

export interface SectionPlaneInfo {
  id: string;
  kind: PlaneKind;
  /** Running number for the list ("Düzlem 2"). */
  no: number;
  enabled: boolean;
}

/** "fill": edges and coloured fills · "lines": edges only · "off": Fragments could not cut. */
export type EdgeMode = "fill" | "lines" | "off";

const STYLE_FILL = "kesit-dolgu";
const STYLE_LINES = "kesit-cizgi";
const AXES = ["x", "y", "z"] as const;

const v3 = (v: Vec3) => new THREE.Vector3(v[0], v[1], v[2]);
const arr = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

export class SectionTool {
  private readonly clipper: OBC.Clipper;
  private readonly styler: OBF.ClipStyler;
  private readonly entries = new Map<string, SectionPlaneInfo & { axis?: (typeof AXES)[number]; side?: "min" | "max" }>();
  private readonly edges = new Map<string, OBF.ClipEdges>();
  private counter = 0;
  private boxHelper: THREE.Box3Helper | null = null;
  private probing: Promise<void> | null = null;
  private disposed = false;
  /** Scene hook that compacts new cut lines / fills right before each frame (see section-meshes.ts). */
  private readonly sceneHook: { scene: THREE.Scene; previous: THREE.Scene["onBeforeRender"] } | null;
  /** Current section box (null: none). */
  box: THREE.Box3 | null = null;
  /** "Kesit Düzlemi" is waiting for a double-click on a face. */
  placing = false;
  /** Cut edges / fills ("Kesit Dolgusu" switch). */
  edgesOn = true;
  edgeMode: EdgeMode | null = null;
  onChange: () => void = () => undefined;

  constructor(private readonly engine: ViewerEngine) {
    const { components, world } = engine;
    this.clipper = components.get(OBC.Clipper);
    this.clipper.enabled = true;
    this.clipper.material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(cssColor("--primary", "#3b6fb5")),
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
    });
    this.clipper.onAfterDrag.add(this.afterDrag);
    this.styler = components.get(OBF.ClipStyler);
    this.styler.world = world;
    const ink = new THREE.Color(cssColor("--vt-section-line", "#1d2939"));
    const lines = new LineMaterial({ color: ink.getHex(), linewidth: 2 });
    const fill = new THREE.MeshBasicMaterial({ color: new THREE.Color(cssColor("--vt-section-fill", "#9aa5b1")), side: THREE.DoubleSide });
    this.styler.styles.set(STYLE_FILL, { linesMaterial: lines, fillsMaterial: fill });
    this.styler.styles.set(STYLE_LINES, { linesMaterial: lines.clone() });

    const scene = world.scene?.three as THREE.Scene | undefined;
    this.sceneHook = scene ? { scene, previous: scene.onBeforeRender } : null;
    if (scene) scene.onBeforeRender = this.beforeRender;
  }

  private beforeRender: THREE.Scene["onBeforeRender"] = (...args) => {
    if (!this.disposed && this.edges.size) compactSectionMeshes([...this.edges.values()].map((e) => e.three));
    this.sceneHook?.previous.apply(this.sceneHook.scene, args);
  };

  get planes(): SectionPlaneInfo[] {
    return [...this.entries.values()].map(({ id, kind, no, enabled }) => ({ id, kind, no, enabled }));
  }

  /** Adds a plane on the face at the given canvas coordinates (call from a double-click). */
  async addPlaneAtPointer(clientX: number, clientY: number): Promise<boolean> {
    const canvas = this.engine.world.renderer?.three.domElement;
    if (!canvas) return false;
    const hit = await this.engine.fragments.raycast({
      camera: this.engine.world.camera.three,
      mouse: new THREE.Vector2(clientX, clientY),
      dom: canvas,
    });
    if (!hit?.normal) return false;
    // Clipper keeps the side opposite the picked face normal, matching its native create().
    this.addPlane([hit.point.x, hit.point.y, hit.point.z], [-hit.normal.x, -hit.normal.y, -hit.normal.z]);
    return true;
  }

  /** Adds a plane through a point; the side the normal points to stays visible. */
  addPlane(origin: Vec3, normal: Vec3, kind: PlaneKind = "plane", enabled = true): string {
    const n = v3(normal).normalize();
    const id = this.clipper.createFromNormalAndCoplanarPoint(this.engine.world, n, v3(origin));
    const plane = this.clipper.list.get(id)!;
    plane.size = this.clipper.size;
    this.register(id, kind);
    if (!enabled) this.setEnabled(id, false);
    return id;
  }

  setEnabled(id: string, enabled: boolean) {
    const plane = this.clipper.list.get(id);
    const entry = this.entries.get(id);
    if (!plane || !entry) return;
    plane.enabled = enabled;
    // A plan cut stays invisible: its plane would tint the whole top view.
    if (entry.kind === "plan") plane.visible = false;
    entry.enabled = enabled;
    const e = this.edges.get(id);
    if (e) e.visible = enabled;
    this.engine.fragments.core.update(true);
    this.onChange();
  }

  delete(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.kind === "box") return this.setBox(null);
    this.remove(id);
    this.onChange();
  }

  /** Removes planes (all, or only the given kinds) and, with them, the box. */
  clear(kinds?: PlaneKind[]) {
    for (const [id, e] of [...this.entries]) if (!kinds || kinds.includes(e.kind)) this.remove(id);
    if (!kinds || kinds.includes("box")) this.dropBoxHelper();
    this.onChange();
  }

  /** Section box with six draggable faces (null removes it). */
  setBox(box: THREE.Box3 | null) {
    if (box && !box.isEmpty() && this.moveBox(box)) return;
    for (const [id, e] of [...this.entries]) if (e.kind === "box") this.remove(id);
    this.dropBoxHelper();
    if (box && !box.isEmpty()) {
      const b = box.clone();
      const center = b.getCenter(new THREE.Vector3());
      const size = b.getSize(new THREE.Vector3());
      const faceSize = Math.max(size.x, size.y, size.z, 1) * 1.6;
      for (const axis of AXES) {
        for (const side of ["min", "max"] as const) {
          const origin = center.clone();
          origin[axis] = b[side][axis];
          const normal = new THREE.Vector3();
          normal[axis] = side === "min" ? 1 : -1;
          const id = this.clipper.createFromNormalAndCoplanarPoint(this.engine.world, normal, origin);
          const plane = this.clipper.list.get(id)!;
          // Other faces clip each quad, so only the box faces themselves show.
          plane.autoScale = false;
          plane.size = faceSize;
          plane.controls.addEventListener("objectChange", this.syncBox);
          this.register(id, "box", { axis, side });
        }
      }
      this.box = b;
      this.boxHelper = new THREE.Box3Helper(b, new THREE.Color(cssColor("--primary", "#3b6fb5")));
      this.engine.world.scene.three.add(this.boxHelper);
    }
    this.engine.fragments.core.update(true);
    this.onChange();
  }

  /**
   * Moves the faces of the current box instead of rebuilding them. Rebuilding disposed the cut
   * materials, so three dropped their shader programs and the new faces compiled them again (a
   * visible hitch on every viewpoint with a box). Returns false when there is no complete box.
   */
  private moveBox(box: THREE.Box3): boolean {
    const faces = [...this.entries.values()].filter((e) => e.kind === "box");
    if (!this.box || faces.length !== AXES.length * 2) return false;
    const planes = faces.map((e) => ({ e, plane: this.clipper.list.get(e.id) }));
    if (planes.some(({ e, plane }) => !plane || !e.axis || !e.side)) return false;
    const b = box.clone();
    const center = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    const faceSize = Math.max(size.x, size.y, size.z, 1) * 1.6;
    for (const { e, plane } of planes) {
      const origin = center.clone();
      origin[e.axis!] = b[e.side!][e.axis!];
      plane!.setFromNormalAndCoplanarPoint(plane!.normal.clone(), origin);
      plane!.size = faceSize;
      void this.edges.get(e.id)?.update();
    }
    this.box = b;
    if (this.boxHelper) this.boxHelper.box = b;
    this.engine.fragments.core.update(true);
    this.onChange();
    return true;
  }

  /** Horizontal cut of the Plan view at a scene height: everything above it is clipped (null removes it). */
  setPlanCut(y: number | null) {
    for (const [id, e] of [...this.entries]) if (e.kind === "plan") this.remove(id);
    if (y !== null) {
      const center = this.modelBox().getCenter(new THREE.Vector3());
      const id = this.addPlane([center.x, y, center.z], [0, -1, 0], "plan");
      const plane = this.clipper.list.get(id);
      if (plane) plane.visible = false;
    }
    this.onChange();
  }

  get hasPlanCut(): boolean {
    return [...this.entries.values()].some((e) => e.kind === "plan");
  }

  setEdgesOn(on: boolean) {
    this.edgesOn = on;
    for (const [id, e] of this.edges) e.visible = on && !!this.entries.get(id)?.enabled;
    if (on) for (const id of this.entries.keys()) if (!this.edges.has(id)) void this.attachEdges(id);
    this.onChange();
  }

  /** Bounding box of every loaded model. */
  modelBox(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const model of this.engine.fragments.list.values()) box.union(model.box);
    return box;
  }

  /** Box around the selected elements (empty when nothing is selected). */
  async selectionBox(): Promise<THREE.Box3> {
    const box = new THREE.Box3();
    for (const [modelId, ids] of Object.entries(this.engine.highlighter.selection.select ?? {})) {
      const model = this.engine.fragments.list.get(modelId);
      if (model && ids.size) box.union(await model.getMergedBox([...ids]));
    }
    return box;
  }

  /** Planes (not the box faces) and the box, for viewpoints. */
  state(): ViewpointSections {
    const planes = [...this.entries.values()]
      .filter((e) => e.kind !== "box")
      .map((e) => {
        const p = this.clipper.list.get(e.id)!;
        return { origin: arr(p.helper.position), normal: arr(p.normal), ...(e.enabled ? {} : { enabled: false }) };
      });
    return { planes, box: this.box ? { min: arr(this.box.min), max: arr(this.box.max) } : null };
  }

  apply(state: ViewpointSections) {
    // A viewpoint with a box keeps the current box faces (moved, see moveBox).
    this.clear(state.box ? ["plane", "plan"] : undefined);
    for (const p of state.planes) this.addPlane(p.origin, p.normal, "plane", p.enabled !== false);
    this.setBox(state.box ? new THREE.Box3(v3(state.box.min), v3(state.box.max)) : null);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    // Hand the scene hook back unless something chained after us (then ours is a no-op).
    if (this.sceneHook && this.sceneHook.scene.onBeforeRender === this.beforeRender) {
      this.sceneHook.scene.onBeforeRender = this.sceneHook.previous;
    }
    try {
      this.clipper.onAfterDrag.remove(this.afterDrag);
      for (const id of [...this.entries.keys()]) this.remove(id);
      this.dropBoxHelper();
    } catch {
      // The components may already be disposed with the viewer.
    }
  }

  // ------------------------------------------------------------------ internals

  private register(id: string, kind: PlaneKind, extra: { axis?: (typeof AXES)[number]; side?: "min" | "max" } = {}) {
    this.entries.set(id, { id, kind, no: kind === "box" ? 0 : ++this.counter, enabled: true, ...extra });
    void this.attachEdges(id);
    this.engine.fragments.core.update(true);
    this.onChange();
  }

  private remove(id: string) {
    const edges = this.edges.get(id);
    this.edges.delete(id);
    if (edges && this.styler.list.has(id)) this.styler.list.delete(id);
    else edges?.dispose();
    const plane = this.clipper.list.get(id);
    plane?.controls.removeEventListener("objectChange", this.syncBox);
    if (plane) this.clipper.list.delete(id);
    this.entries.delete(id);
    this.engine.fragments.core.update(true);
  }

  private dropBoxHelper() {
    if (this.boxHelper) {
      this.boxHelper.removeFromParent();
      this.boxHelper.geometry.dispose();
      (this.boxHelper.material as THREE.Material).dispose();
    }
    this.boxHelper = null;
    this.box = null;
  }

  /** Box faces were dragged: read the new extents from the plane helpers. */
  private syncBox = () => {
    if (!this.box) return;
    for (const e of this.entries.values()) {
      if (e.kind !== "box" || !e.axis || !e.side) continue;
      const p = this.clipper.list.get(e.id);
      if (p) this.box[e.side][e.axis] = p.helper.position[e.axis];
    }
  };

  private afterDrag = () => {
    this.syncBox();
    this.engine.fragments.core.update(true);
    this.onChange();
  };

  /**
   * Fragments 3.4 computes cut edges and fills (model.getSection). Probed once on a horizontal
   * cut through the first model: an error means no edges ("off"), edges without fill indices
   * mean outline only ("lines").
   */
  private probe(): Promise<void> {
    if (this.edgeMode) return Promise.resolve();
    this.probing ??= (async () => {
      const model = this.engine.fragments.list.values().next().value;
      if (!model) {
        this.probing = null;
        return;
      }
      try {
        const local = model.box.clone().applyMatrix4(model.object.matrixWorld.clone().invert());
        const center = local.getCenter(new THREE.Vector3());
        const res = await model.getSection(new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0, -1, 0), center));
        this.edgeMode = res.index > 0 && !res.fillsIndices?.length ? "lines" : "fill";
      } catch {
        this.edgeMode = "off";
      }
      this.onChange();
    })();
    return this.probing;
  }

  private async attachEdges(id: string) {
    if (!this.edgesOn) return;
    await this.probe();
    if (this.disposed || !this.edgeMode || this.edgeMode === "off" || this.edges.has(id) || !this.clipper.list.has(id)) return;
    try {
      const edges = this.styler.createFromClipping(id, {
        id,
        world: this.engine.world,
        items: { kesit: { style: this.edgeMode === "fill" ? STYLE_FILL : STYLE_LINES } },
      });
      edges.visible = !!this.entries.get(id)?.enabled;
      this.edges.set(id, edges);
    } catch {
      this.edgeMode = "off";
      this.onChange();
    }
  }
}
