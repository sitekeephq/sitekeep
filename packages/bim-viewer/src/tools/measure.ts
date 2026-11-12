/**
 * Measurements (Ölçü) with That Open components-front: length, area and angle with vertex / edge /
 * face snapping, and the volume of the selected elements. Labels use the Turkish number format.
 * On touch screens a length is two taps (no hover preview there).
 */
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as FRAGS from "@thatopen/fragments";
import * as THREE from "three";
import type { Vec3, ViewpointMeasurement } from "../core/types.js";
import { cssColor, type ViewerEngine } from "../core/ViewerEngine.js";
import { formatNumberTr, type MeasureKind } from "./units.js";

export interface MeasureEntry {
  key: string;
  kind: MeasureKind;
  /** m, m², ° or m³; null while a volume is still being computed. */
  value: number | null;
}

type AnyMeasurement = OBF.LengthMeasurement | OBF.AreaMeasurement | OBF.AngleMeasurement | OBF.VolumeMeasurement;

/** Shorter lengths / smaller areas are two clicks on one point (no hover in between), not measurements. */
export const MIN_LENGTH = 1e-3;
export const MIN_AREA = 1e-6;

const v3 = (v: Vec3) => new THREE.Vector3(v[0], v[1], v[2]);
const arr = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

export class MeasureTool {
  readonly length: OBF.LengthMeasurement;
  readonly area: OBF.AreaMeasurement;
  readonly angle: OBF.AngleMeasurement;
  readonly volume: OBF.VolumeMeasurement;
  /** Tool waiting for clicks (null: none). Volume is not interactive: it measures the selection. */
  active: Exclude<MeasureKind, "volume"> | null = null;
  private readonly keys = new WeakMap<object, string>();
  private readonly volumes = new Map<OBF.Volume, number | null>();
  private next = 0;
  private tapStart: THREE.Vector3 | null = null;
  private tapMarker: THREE.Mesh | null = null;
  onChange: () => void = () => undefined;

  constructor(private readonly engine: ViewerEngine) {
    const { components, world } = engine;
    OBF.Measurement.valueFormatter = (v: number) => formatNumberTr(v, 2);
    this.length = components.get(OBF.LengthMeasurement);
    this.area = components.get(OBF.AreaMeasurement);
    this.angle = components.get(OBF.AngleMeasurement);
    this.volume = components.get(OBF.VolumeMeasurement);
    const color = new THREE.Color(cssColor("--vt-measure", "#d97706"));
    for (const m of this.all) {
      m.world = world;
      m.color = color;
      m.rounding = 2;
      // Snap picks are coalesced to one per frame and run only while a tool is on. (MOUSE_STOP
      // would be lighter but places a point at the last stop when one clicks right after moving.)
      m.pickMode = OBF.MeasurementPickMode.MOUSE_MOVE;
      m.enabled = false;
      m.list.onItemAdded.add(this.changed);
      m.list.onItemDeleted.add(this.changed);
      m.list.onCleared.add(this.changed);
    }
    this.length.list.onItemAdded.add(this.dropEmptyLength);
    this.area.list.onItemAdded.add(this.dropEmptyArea);
    this.length.units = "m";
    this.area.units = "m2";
    this.angle.units = "deg";
    this.volume.units = "m3";
  }

  private get all(): AnyMeasurement[] {
    return [this.length, this.area, this.angle, this.volume];
  }

  private changed = () => this.onChange();

  // Removed after the add event: the measurement components finish their own handlers first.
  private dropEmptyLength = (line: OBF.Line) => {
    if (line.distance() < MIN_LENGTH) queueMicrotask(() => this.length.list.delete(line));
  };

  private dropEmptyArea = (area: OBF.Area) => {
    if (!(area.rawValue >= MIN_AREA)) queueMicrotask(() => this.area.list.delete(area));
  };

  setActive(kind: Exclude<MeasureKind, "volume"> | null) {
    this.clearTap();
    for (const [k, m] of [
      ["length", this.length],
      ["area", this.area],
      ["angle", this.angle],
    ] as const) {
      if (m.enabled && k !== kind) m.cancelCreation();
      m.enabled = k === kind;
    }
    this.active = kind;
    this.onChange();
  }

  /** A click on the model while a tool is active (mouse / pen). */
  async click() {
    if (this.active === "length") await this.length.create();
    else if (this.active === "area") await this.area.create();
    else if (this.active === "angle") await this.angle.create();
  }

  /** Double-click or Enter closes an area. */
  finishArea() {
    if (this.active === "area") this.area.endCreation();
  }

  get tapPending(): boolean {
    return !!this.tapStart;
  }

  /** Touch: first tap is the start, the second the end of a length. Returns false when nothing was hit. */
  async tap(clientX: number, clientY: number): Promise<boolean> {
    const canvas = this.engine.world.renderer!.three.domElement;
    const hit = await this.engine.fragments.raycast({
      camera: this.engine.world.camera.three,
      mouse: new THREE.Vector2(clientX, clientY),
      dom: canvas,
      snappingClasses: [FRAGS.SnappingClass.POINT, FRAGS.SnappingClass.LINE, FRAGS.SnappingClass.FACE],
    });
    if (!hit) return false;
    const point = hit.point.clone();
    if (!this.tapStart) {
      this.tapStart = point;
      this.tapMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 12, 8),
        new THREE.MeshBasicMaterial({ color: this.length.color, depthTest: false, transparent: true }),
      );
      this.tapMarker.renderOrder = 12;
      this.tapMarker.position.copy(point);
      this.engine.world.scene.three.add(this.tapMarker);
    } else if (point.distanceTo(this.tapStart) >= MIN_LENGTH) {
      this.length.list.add(new OBF.Line(this.tapStart, point));
      this.clearTap();
    }
    this.onChange();
    return true;
  }

  clearTap() {
    this.tapStart = null;
    if (this.tapMarker) {
      this.tapMarker.removeFromParent();
      this.tapMarker.geometry.dispose();
      (this.tapMarker.material as THREE.Material).dispose();
    }
    this.tapMarker = null;
  }

  /** Volume of the selected elements, as a measurement with its own label. False without a selection. */
  measureSelectionVolume(): boolean {
    const sel = this.engine.highlighter.selection.select ?? {};
    const items: OBC.ModelIdMap = {};
    for (const [modelId, ids] of Object.entries(sel)) if (ids.size) items[modelId] = new Set(ids);
    if (!Object.keys(items).length) return false;
    const volume = new OBF.Volume(this.engine.components);
    volume.items = items;
    this.addVolume(volume);
    return true;
  }

  entries(): MeasureEntry[] {
    const out: MeasureEntry[] = [];
    for (const line of this.length.list) out.push({ key: this.key(line), kind: "length", value: line.distance() });
    for (const area of this.area.list) out.push({ key: this.key(area), kind: "area", value: area.rawValue });
    for (const angle of this.angle.list) out.push({ key: this.key(angle), kind: "angle", value: THREE.MathUtils.radToDeg(angle.rawValue) });
    for (const volume of this.volume.list) out.push({ key: this.key(volume), kind: "volume", value: this.volumes.get(volume) ?? null });
    return out;
  }

  delete(key: string) {
    const drop = <T extends object>(list: FRAGS.DataSet<T>): boolean => {
      for (const item of list) {
        if (this.keys.get(item) !== key) continue;
        list.delete(item);
        if (item instanceof OBF.Volume) this.volumes.delete(item);
        return true;
      }
      return false;
    };
    void (drop(this.length.list) || drop(this.area.list) || drop(this.angle.list) || drop(this.volume.list));
  }

  clear() {
    this.clearTap();
    for (const m of this.all) m.list.clear();
    this.volumes.clear();
  }

  /** Measurements for a viewpoint (volumes by GlobalId so they survive a reload). */
  async state(): Promise<ViewpointMeasurement[]> {
    const out: ViewpointMeasurement[] = [];
    for (const l of this.length.list) out.push({ kind: "length", points: [arr(l.start), arr(l.end)], value: l.distance() });
    for (const a of this.area.list) out.push({ kind: "area", points: [...a.points].map(arr), value: a.rawValue });
    for (const a of this.angle.list)
      out.push({ kind: "angle", points: [arr(a.start), arr(a.vertex), arr(a.end)], value: THREE.MathUtils.radToDeg(a.rawValue) });
    for (const v of this.volume.list) {
      const guids: string[] = [];
      for (const [modelId, ids] of Object.entries(v.items)) {
        const model = this.engine.fragments.list.get(modelId);
        if (model) guids.push(...(await model.getGuidsByLocalIds([...ids])).filter((g): g is string => !!g));
      }
      if (guids.length) out.push({ kind: "volume", guids, value: this.volumes.get(v) ?? 0 });
    }
    return out;
  }

  async apply(list: ViewpointMeasurement[]) {
    this.clear();
    for (const m of list) {
      if (m.kind === "length") this.length.list.add(new OBF.Line(v3(m.points[0]), v3(m.points[1])));
      else if (m.kind === "area") this.area.list.add(new OBF.Area(m.points.map(v3)));
      else if (m.kind === "angle") this.angle.list.add(new OBF.Angle(v3(m.points[0]), v3(m.points[1]), v3(m.points[2])));
      else {
        const items: OBC.ModelIdMap = {};
        for (const [modelId, model] of this.engine.fragments.list) {
          const ids = (await model.getLocalIdsByGuids(m.guids)).filter((x): x is number => x !== null && x !== undefined);
          if (ids.length) items[modelId] = new Set(ids);
        }
        if (!Object.keys(items).length) continue;
        const volume = new OBF.Volume(this.engine.components);
        volume.items = items;
        this.addVolume(volume);
      }
    }
  }

  dispose() {
    this.clearTap();
    try {
      for (const m of this.all) {
        m.list.onItemAdded.remove(this.changed);
        m.list.onItemDeleted.remove(this.changed);
        m.list.onCleared.remove(this.changed);
        m.enabled = false;
      }
      this.length.list.onItemAdded.remove(this.dropEmptyLength);
      this.area.list.onItemAdded.remove(this.dropEmptyArea);
    } catch {
      // Already disposed with the viewer's components.
    }
  }

  private addVolume(volume: OBF.Volume) {
    this.volumes.set(volume, null);
    this.volume.list.add(volume);
    void volume.getRawValue().then(
      (v) => {
        this.volumes.set(volume, v);
        this.onChange();
      },
      () => undefined,
    );
  }

  private key(item: object): string {
    let k = this.keys.get(item);
    if (!k) this.keys.set(item, (k = `m${++this.next}`));
    return k;
  }
}
