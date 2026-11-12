import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as THREE from "three";
import { vi } from "vitest";
import { ViewerEngine } from "../../src/core/ViewerEngine";

type Listener = (...args: unknown[]) => void;

export function eventBag() {
  const fns = new Set<Listener>();
  return {
    add: (fn: Listener) => fns.add(fn),
    remove: (fn: Listener) => fns.delete(fn),
    fire: (...args: unknown[]) => {
      for (const fn of fns) fn(...args);
    },
  };
}

export function dataSet<T>() {
  const items = new Set<T>();
  const onItemAdded = eventBag();
  const onItemDeleted = eventBag();
  const onCleared = eventBag();
  return {
    add(item: T) {
      items.add(item);
      onItemAdded.fire(item);
    },
    delete(item: T) {
      items.delete(item);
      onItemDeleted.fire(item);
    },
    clear() {
      items.clear();
      onCleared.fire();
    },
    [Symbol.iterator]() {
      return items[Symbol.iterator]();
    },
    get size() {
      return items.size;
    },
    onItemAdded,
    onItemDeleted,
    onCleared,
  };
}

export function fakeMeasurement() {
  return {
    world: null as unknown,
    color: new THREE.Color("#d97706"),
    rounding: 2,
    pickMode: 0,
    enabled: false,
    units: "",
    list: dataSet<unknown>(),
    cancelCreation: () => undefined,
    create: async () => undefined,
    endCreation: () => undefined,
  };
}

export function fakeClipper() {
  const planes = new Map<
    string,
    {
      size: number;
      enabled: boolean;
      visible: boolean;
      autoScale: boolean;
      normal: THREE.Vector3;
      helper: { position: THREE.Vector3 };
      controls: { addEventListener: () => void; removeEventListener: () => void };
      setFromNormalAndCoplanarPoint(normal: THREE.Vector3, point: THREE.Vector3): void;
    }
  >();
  let n = 0;
  return {
    enabled: false,
    material: null as THREE.Material | null,
    size: 10,
    onAfterDrag: eventBag(),
    list: {
      get: (id: string) => planes.get(id),
      has: (id: string) => planes.has(id),
      delete: (id: string) => planes.delete(id),
    },
    createFromNormalAndCoplanarPoint(_world: unknown, normal: THREE.Vector3, origin: THREE.Vector3) {
      const id = `clip-${++n}`;
      const plane = {
        size: 10,
        enabled: true,
        visible: true,
        autoScale: true,
        normal: normal.clone(),
        helper: { position: origin.clone() },
        controls: { addEventListener: () => undefined, removeEventListener: () => undefined },
        setFromNormalAndCoplanarPoint(n: THREE.Vector3, p: THREE.Vector3) {
          plane.normal.copy(n);
          plane.helper.position.copy(p);
        },
      };
      planes.set(id, plane);
      return id;
    },
  };
}

export function fakeModel(opts: {
  id: string;
  offset?: [number, number, number];
  box?: THREE.Box3;
  guids?: Record<string, number>;
  classes?: Record<string, number[]>;
  localIds?: number[];
}) {
  const object = new THREE.Object3D();
  object.name = opts.id;
  const guidToLocal = opts.guids ?? { [`${opts.id}-a`]: 1, [`${opts.id}-b`]: 2 };
  const localToGuid = new Map<number, string>(Object.entries(guidToLocal).map(([g, id]) => [id, g]));
  const localIds = opts.localIds ?? [...new Set(Object.values(guidToLocal))];
  return {
    id: opts.id,
    object,
    box: opts.box ?? new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 4, 5)),
    getCoordinates: async () => opts.offset ?? [0, 0, 0],
    getLocalIdsByGuids: async (guids: string[]) => guids.map((g) => guidToLocal[g] ?? null),
    getGuidsByLocalIds: async (ids: number[]) => ids.map((id) => localToGuid.get(id) ?? null),
    getLocalIds: async () => [...localIds],
    getItemsOfCategories: async () => opts.classes ?? { IfcWall: [1] },
    getMergedBox: async () => new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1)),
    getSection: async () => {
      throw new Error("no section");
    },
    setVisible: async (_ids?: Iterable<number>, _visible?: boolean): Promise<void> => {},
    resetVisible: async () => undefined,
    setColor: async () => undefined,
    resetColor: async () => undefined,
    setOpacity: async () => undefined,
    resetOpacity: async () => undefined,
    setLodMode: vi.fn(async () => undefined),
  };
}

export function makeEngineStub(models: ReturnType<typeof fakeModel>[] = []) {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "toDataURL", { value: () => "data:image/png;base64,xx" });
  const list = new Map(models.map((model) => [model.id, model]));
  const clipper = fakeClipper();
  const length = fakeMeasurement();
  const area = fakeMeasurement();
  const angle = fakeMeasurement();
  const volume = fakeMeasurement();
  const hider = {
    set: async (_visible?: boolean, _map?: unknown): Promise<void> => {},
    isolate: async () => undefined,
  };
  const styler = {
    world: null as unknown,
    styles: new Map(),
    list: new Map<string, { dispose?: () => void }>(),
    createFromClipping: () => {
      throw new Error("no edges");
    },
  };
  const highlighter = {
    enabled: true,
    styles: new Map<string, unknown>(),
    selection: { select: {} as Record<string, Set<number>> } as Record<string, Record<string, Set<number>> | undefined>,
    events: { select: { onHighlight: eventBag(), onClear: eventBag() } },
    highlightByID: async (style: string, map: Record<string, Set<number>>) => {
      highlighter.selection[style] = map;
    },
    clear: async (style: string) => {
      delete highlighter.selection[style];
      if (style === "select") highlighter.selection.select = {};
    },
  };
  const camera = {
    three: new THREE.PerspectiveCamera(),
    controls: {
      getPosition: (out: THREE.Vector3) => out.set(0, 8, 16),
      getTarget: (out: THREE.Vector3) => out.set(0, 0, 0),
      getDistance: () => 16,
      fitToSphere: async () => undefined,
      setLookAt: async () => undefined,
      zoomTo: async () => undefined,
      enabled: true,
      azimuthRotateSpeed: 1,
      polarRotateSpeed: 1,
      mouseButtons: { left: 1, wheel: 2 },
      touches: { one: 1 },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    projection: {
      current: "Perspective" as "Perspective" | "Orthographic",
      set: async (mode: "Perspective" | "Orthographic") => {
        camera.projection.current = mode;
      },
      onChanged: { add: () => undefined },
    },
    fitToItems: async () => undefined,
  };
  const scene = new THREE.Scene();
  const components = {
    get: (ctor: unknown) => {
      if (ctor === OBC.Clipper) return clipper;
      if (ctor === OBF.ClipStyler) return styler;
      if (ctor === OBF.LengthMeasurement) return length;
      if (ctor === OBF.AreaMeasurement) return area;
      if (ctor === OBF.AngleMeasurement) return angle;
      if (ctor === OBF.VolumeMeasurement) return volume;
      if (ctor === OBC.Hider) return hider;
      throw new Error(`unstubbed component ${String(ctor)}`);
    },
    dispose: () => undefined,
  };
  const fragments = {
    list,
    core: {
      settings: { graphicsQuality: 0 },
      update: () => undefined,
      load: async (_buffer: ArrayBuffer, opts: { modelId: string }) => {
        const model = fakeModel({ id: opts.modelId });
        list.set(opts.modelId, model);
      },
      disposeModel: async (modelId: string) => {
        list.delete(modelId);
      },
    },
    raycast: async () => null,
  };
  const grid = { three: new THREE.Mesh() };
  const engine = Object.create(ViewerEngine.prototype) as ViewerEngine;
  Object.assign(engine, {
    components,
    world: {
      scene: { three: scene },
      camera,
      renderer: {
        three: { domElement: canvas, render: () => undefined, getSize: () => ({ x: 800, y: 600 }) },
        getSize: () => ({ x: 800, y: 600 }),
      },
    },
    fragments,
    highlighter,
    pins: new THREE.Group(),
    clashMarker: new THREE.Group(),
    bcfLines: new THREE.Group(),
    bcfStyles: new Set<string>(),
    grid,
    baseOffset: null,
    aligned: new Set<string>(),
    extras: null,
    onSelect: () => undefined,
  });
  return {
    engine,
    models: Object.fromEntries(models.map((model) => [model.id, model])),
    list,
    highlighter,
    clipper,
    hider,
    camera,
    canvas,
    length,
    scene,
    grid,
  };
}
