/**
 * Model viewer tools around the ViewerEngine: navigation modes (Yörünge / Yürüme / Plan with a
 * storey picker), sections, measurements, show / hide / isolate, X-ray, the view cube and PNG
 * screenshots. The React HUD (components/viewer-tools) only renders `state` and calls `run` / the
 * methods; everything that touches three.js or That Open lives here and in the sub-tools.
 */
import * as OBC from "@thatopen/components";
import CameraControls from "camera-controls";
import * as THREE from "three";
import type { ViewpointMeasurement, ViewpointSections } from "../core/types.js";
import type { ViewerEngine, ViewpointExtrasSource } from "../core/ViewerEngine.js";
import { MeasureTool, type MeasureEntry } from "./measure.js";
import { SectionTool, type EdgeMode, type SectionPlaneInfo } from "./sections.js";
import { isTypingTarget, shortcutCommand, type MeasureTool as MeasureKindTool, type NavMode, type ToolCommand } from "./shortcuts.js";
import { fitStoreyScale, planCutY, sortStoreys, storeyIndexAt, storeyLevels, type StoreyInfo } from "./storeys.js";
import { readViewpointExtras, toViewpointExtras } from "./viewpoint-extras.js";
import { ViewCube } from "./view-cube.js";
import { WalkController } from "./walk.js";
import { EYE_HEIGHT, type MoveInput } from "./walk-math.js";

export interface StoreyRow {
  name: string;
  /** Scene height of the storey level, null when unknown. */
  level: number | null;
  /** IFC elevation in metres (for the list), null when unknown. */
  elevation: number | null;
}

export interface ToolsState {
  nav: NavMode;
  walkSpeed: number;
  pointerLocked: boolean;
  storeys: StoreyRow[] | null;
  storeysLoading: boolean;
  storeyIndex: number | null;
  sectionPlacing: boolean;
  planes: SectionPlaneInfo[];
  box: boolean;
  edgesOn: boolean;
  edgeMode: EdgeMode | null;
  measureTool: MeasureKindTool | null;
  measurements: MeasureEntry[];
  tapPending: boolean;
  xray: boolean;
  hasSelection: boolean;
  hidden: boolean;
  helpOpen: boolean;
  /** Short status line ("Bir yüze çift tıklayın"…), null when idle. */
  hint: string | null;
}

export interface ViewerToolsOptions {
  /** Storeys from the server's element index (name + IFC elevation); null when not available. */
  serverStoreys?: (versionId: string) => Promise<StoreyInfo[] | null>;
  /** "F" / Sığdır. */
  onFit?: () => void;
}

const XRAY_OPACITY = 0.12;

export class ViewerTools implements ViewpointExtrasSource {
  readonly sections: SectionTool;
  readonly measure: MeasureTool;
  readonly walk: WalkController;
  private cube: ViewCube | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: ToolsState;
  private nav: NavMode = "orbit";
  private storeys: { list: StoreyRow[]; key: string } | null = null;
  private storeysLoading = false;
  private storeyIndex: number | null = null;
  private xray = false;
  private hidden = false;
  private helpOpen = false;
  private hint: string | null = null;
  private down: { x: number; y: number; type: string } | null = null;
  private walkAwaitingStart = false;
  private planSaved: { azimuth: number; polar: number; left: number; one: number } | null = null;
  private disposed = false;

  constructor(
    private readonly engine: ViewerEngine,
    private readonly options: ViewerToolsOptions = {},
  ) {
    this.sections = new SectionTool(engine);
    this.measure = new MeasureTool(engine);
    this.walk = new WalkController(engine);
    this.sections.onChange = this.emit;
    this.measure.onChange = this.emit;
    this.walk.onChange = this.emit;
    const canvas = this.canvas;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("click", this.onClick);
    canvas.addEventListener("dblclick", this.onDblClick);
    window.addEventListener("keydown", this.onKeyDown);
    engine.highlighter.events.select!.onHighlight.add(this.onSelection);
    engine.highlighter.events.select!.onClear.add(this.onSelection);
    this.snapshot = this.buildState();
  }

  private get canvas(): HTMLCanvasElement {
    return this.engine.world.renderer!.three.domElement;
  }

  // ------------------------------------------------------------------ state

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get state(): ToolsState {
    return this.snapshot;
  }

  private emit = () => {
    if (this.disposed) return;
    this.snapshot = this.buildState();
    for (const fn of this.listeners) fn();
  };

  private buildState(): ToolsState {
    return {
      nav: this.nav,
      walkSpeed: this.walk.speed,
      pointerLocked: this.walk.pointerLocked,
      storeys: this.storeys?.list ?? null,
      storeysLoading: this.storeysLoading,
      storeyIndex: this.storeyIndex,
      sectionPlacing: this.sections.placing,
      planes: this.sections.planes.filter((p) => p.kind !== "box"),
      box: !!this.sections.box,
      edgesOn: this.sections.edgesOn,
      edgeMode: this.sections.edgeMode,
      measureTool: this.measure.active,
      measurements: this.measure.entries(),
      tapPending: this.measure.tapPending,
      xray: this.xray,
      hasSelection: this.selectionCount() > 0,
      hidden: this.hidden,
      helpOpen: this.helpOpen,
      hint: this.hint,
    };
  }

  private selectionCount(): number {
    let n = 0;
    for (const ids of Object.values(this.engine.highlighter.selection.select ?? {})) n += ids.size;
    return n;
  }

  private selectionMap(): OBC.ModelIdMap {
    const out: OBC.ModelIdMap = {};
    for (const [modelId, ids] of Object.entries(this.engine.highlighter.selection.select ?? {})) if (ids.size) out[modelId] = new Set(ids);
    return out;
  }

  // ------------------------------------------------------------------ commands

  /** Keyboard shortcut / menu command. */
  async run(cmd: ToolCommand): Promise<void> {
    switch (cmd) {
      case "nav:orbit":
        return this.setNav("orbit");
      case "nav:walk":
        return this.setNav("walk");
      case "nav:plan":
        return this.setNav("plan");
      case "fit":
        this.options.onFit?.();
        return;
      case "section:plane":
        return this.toggleSectionPlacing();
      case "section:box":
        return this.toggleBox();
      case "measure:length":
        return this.setMeasureTool(this.measure.active === "length" ? null : "length");
      case "hide":
        return this.hideSelection();
      case "isolate":
        return this.isolateSelection();
      case "show_all":
        return this.showAll();
      case "xray":
        return this.setXray(!this.xray);
      case "screenshot":
        return this.screenshot();
      case "help":
        this.helpOpen = !this.helpOpen;
        return this.emit();
      case "escape":
        return this.escape();
    }
  }

  setHelp(open: boolean) {
    this.helpOpen = open;
    this.emit();
  }

  /** Esc: closes help, then the active tool, then walking. */
  private async escape() {
    if (this.helpOpen) this.helpOpen = false;
    else if (this.measure.active || this.measure.tapPending) this.setMeasureTool(null);
    else if (this.sections.placing) this.toggleSectionPlacing();
    else if (this.nav === "walk") await this.setNav("orbit");
    this.emit();
  }

  async setNav(mode: NavMode, opts: { walkAt?: THREE.Vector3 } = {}) {
    if (this.disposed) return;
    const camera = this.engine.world.camera;
    if (mode === this.nav && !opts.walkAt) {
      if (mode === "plan") return this.emit();
      return;
    }
    // Leave the current mode.
    if (this.nav === "walk" && mode !== "walk") {
      this.walkAwaitingStart = false;
      this.walk.stop();
    }
    if (this.nav === "plan" && mode !== "plan") await this.leavePlan();
    this.nav = mode;
    this.setMeasureTool(null);
    if (this.sections.placing) this.sections.placing = false;
    this.syncHighlighter();
    if (mode === "walk") {
      if (camera.projection.current !== "Perspective") await camera.projection.set("Perspective");
      if (opts.walkAt) {
        await this.walk.start(opts.walkAt);
        this.walkAwaitingStart = false;
        this.hint = matchMedia("(pointer: coarse)").matches ? "Sol alttaki kolla yürüyün, ekranı sürükleyerek bakın." : "Bakmak için tıklayın · W A S D ile yürüyün · Esc";
      } else {
        this.walkAwaitingStart = true;
        this.hint = "Yürümeye başlamak istediğiniz zemine tıklayın · Esc: vazgeç";
      }
    } else this.hint = null;
    if (mode === "plan") await this.enterPlan();
    this.emit();
  }

  setWalkSpeed(speed: number) {
    this.walk.setSpeed(speed);
  }

  setJoystick(input: MoveInput) {
    this.walk.setJoystick(input);
  }

  // ---- Plan

  private async enterPlan() {
    const camera = this.engine.world.camera;
    const controls = camera.controls;
    // Like OBC's PlanMode, without its target jump: no rotation, left drag pans.
    if (!this.planSaved) {
      this.planSaved = {
        azimuth: controls.azimuthRotateSpeed,
        polar: controls.polarRotateSpeed,
        left: controls.mouseButtons.left,
        one: controls.touches.one,
      };
      controls.azimuthRotateSpeed = 0;
      controls.polarRotateSpeed = 0;
      controls.mouseButtons.left = CameraControls.ACTION.TRUCK;
      controls.touches.one = CameraControls.ACTION.TOUCH_TRUCK;
    }
    await this.loadStoreys();
    if (this.nav !== "plan") return;
    const levels = this.storeys?.list.map((s) => s.level) ?? [];
    const target = controls.getTarget(new THREE.Vector3());
    const index = levels.some((l) => l !== null) ? (this.storeyIndex ?? storeyIndexAt(levels, target.y)) : null;
    await this.selectStorey(index);
  }

  /** Plan view of a storey: everything above its cut is clipped; null shows the whole model from the top. */
  async selectStorey(index: number | null) {
    if (this.nav !== "plan") {
      this.storeyIndex = index;
      return this.setNav("plan");
    }
    const levels = this.storeys?.list.map((s) => s.level) ?? [];
    this.storeyIndex = index;
    const cut = index === null ? null : planCutY(levels, index);
    this.sections.setPlanCut(cut);
    const camera = this.engine.world.camera;
    const box = this.sections.modelBox();
    if (box.isEmpty()) return this.emit();
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const floor = index === null ? box.min.y : (levels[index] ?? box.min.y);
    const height = Math.max(size.x, size.z, 10) * 1.5;
    await camera.controls.setLookAt(center.x, floor + height, center.z + 0.001, center.x, floor, center.z, false);
    if (camera.projection.current !== "Orthographic") await camera.projection.set("Orthographic");
    await camera.fitToItems();
    this.engine.fragments.core.update(true);
    this.emit();
  }

  private async leavePlan() {
    const camera = this.engine.world.camera;
    const controls = camera.controls;
    if (this.planSaved) {
      controls.azimuthRotateSpeed = this.planSaved.azimuth;
      controls.polarRotateSpeed = this.planSaved.polar;
      controls.mouseButtons.left = this.planSaved.left as typeof controls.mouseButtons.left;
      controls.touches.one = this.planSaved.one as typeof controls.touches.one;
      this.planSaved = null;
    }
    this.sections.setPlanCut(null);
    if (camera.projection.current !== "Perspective") await camera.projection.set("Perspective");
  }

  /** Storeys of all loaded models: the server indexes first, each model's own data otherwise. */
  private async loadStoreys() {
    const modelIds = this.engine.loadedIds;
    const key = modelIds.join(",");
    const firstId = modelIds[0];
    const firstModel = firstId ? this.engine.fragments.list.get(firstId) : undefined;
    if (!firstId || !firstModel) {
      this.storeys = null;
      this.storeysLoading = false;
      return;
    }
    if (this.storeys?.key === key) return;
    this.storeysLoading = true;
    this.emit();
    const list: StoreyInfo[] = [];
    for (const modelId of modelIds) {
      const model = this.engine.fragments.list.get(modelId);
      if (!model) continue;
      let rows: StoreyInfo[] | null = null;
      try {
        rows = (await this.options.serverStoreys?.(modelId)) ?? null;
      } catch {
        rows = null;
      }
      if (!rows?.length) rows = await storeysFromModel(model).catch(() => []);
      list.push(...rows);
    }
    const sorted = sortStoreys(list);
    const origin = await this.engine.ifcToScene([0, 0, 0], firstId);
    const box = this.sections.modelBox();
    const fit = fitStoreyScale(
      sorted.filter((s) => s.elevation !== null).map((s) => s.elevation!),
      { offsetY: origin?.y ?? 0, minY: box.min.y, maxY: box.max.y },
    );
    const levels = storeyLevels(sorted, fit);
    this.storeys = {
      key,
      list: sorted.map((s, i) => ({ name: s.name, level: levels[i] ?? null, elevation: s.elevation === null ? null : s.elevation * fit.scale })),
    };
    this.storeysLoading = false;
    this.emit();
  }

  /** Forget cached storeys (the loaded models changed). */
  modelsChanged() {
    if (this.storeys && this.storeys.key !== this.engine.loadedIds.join(",")) {
      this.storeys = null;
      this.storeyIndex = null;
    }
    if (this.xray) void this.applyXray();
    this.emit();
  }

  // ---- Sections

  toggleSectionPlacing() {
    const on = !this.sections.placing;
    if (on) this.setMeasureTool(null);
    this.sections.placing = on;
    this.syncHighlighter();
    this.hint = on ? "Kesit için bir yüze çift tıklayın (Esc: bitir)." : null;
    this.emit();
  }

  /** Section box around the selection, or the whole model; a second call removes it. */
  async toggleBox() {
    if (this.sections.box) return this.sections.setBox(null);
    const sel = await this.sections.selectionBox();
    const box = sel.isEmpty() ? this.sections.modelBox() : sel.expandByScalar(0.25);
    if (!box.isEmpty()) this.sections.setBox(box);
  }

  // ---- Measurements

  setMeasureTool(tool: MeasureKindTool | null) {
    if (tool === "volume") {
      if (!this.measure.measureSelectionVolume()) {
        this.hint = "Hacim için önce bir veya birden fazla eleman seçin.";
        this.emit();
      }
      return;
    }
    if (tool && this.sections.placing) this.sections.placing = false;
    this.measure.setActive(tool);
    this.syncHighlighter();
    this.hint = !tool
      ? null
      : tool === "length"
        ? "İki noktaya tıklayın (telefonda dokunun). Köşe, kenar ve yüzeylere yapışır."
        : tool === "area"
          ? "Köşelere tıklayın; çift tık veya Enter alanı kapatır."
          : "Üç noktaya tıklayın: başlangıç, köşe, bitiş.";
    this.emit();
  }

  /** Clicks select elements only in Yörünge / Plan without a measuring or section tool. */
  private syncHighlighter() {
    this.engine.highlighter.enabled = this.nav !== "walk" && !this.measure.active && !this.sections.placing;
  }

  // ---- Visibility

  async hideSelection() {
    const map = this.selectionMap();
    if (!Object.keys(map).length) return;
    await this.engine.highlighter.clear("select");
    await this.engine.components.get(OBC.Hider).set(false, map);
    this.hidden = true;
    this.engine.fragments.core.update(true);
    this.emit();
  }

  async isolateSelection() {
    const map = this.selectionMap();
    if (!Object.keys(map).length) return;
    await this.engine.components.get(OBC.Hider).isolate(map);
    this.hidden = true;
    this.engine.fragments.core.update(true);
    this.emit();
  }

  async showAll() {
    if (this.engine.fragments.list.size) await this.engine.components.get(OBC.Hider).set(true);
    this.hidden = false;
    this.engine.fragments.core.update(true);
    this.emit();
  }

  async setXray(on: boolean) {
    this.xray = on;
    await this.applyXray();
    this.emit();
  }

  /** X-ray: everything except the selection becomes see-through, keeping its colours. */
  private async applyXray() {
    const sel = this.engine.highlighter.selection.select ?? {};
    for (const [modelId, model] of this.engine.fragments.list) {
      await model.resetOpacity(undefined);
      if (!this.xray) continue;
      const keep = sel[modelId];
      const ids = keep?.size ? (await model.getLocalIds()).filter((id) => !keep.has(id)) : undefined;
      await model.setOpacity(ids, XRAY_OPACITY);
    }
    this.engine.fragments.core.update(true);
  }

  private onSelection = () => {
    if (this.xray) void this.applyXray();
    this.emit();
  };

  // ---- Screenshot

  async screenshot() {
    const renderer = this.engine.world.renderer!;
    renderer.three.render(this.engine.world.scene.three, this.engine.world.camera.three);
    const url = renderer.three.domElement.toDataURL("image/png");
    const a = document.createElement("a");
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    a.href = url;
    a.download = `model-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---- View cube

  mountCube(host: HTMLElement | null, size = 72) {
    this.cube?.dispose();
    this.cube = host ? new ViewCube(this.engine, host, size, () => (this.nav === "walk" ? this.setNav("orbit") : undefined)) : null;
  }

  // ------------------------------------------------------------------ viewpoints (ViewpointExtrasSource)

  async save(): Promise<{ sections?: ViewpointSections; measurements?: ViewpointMeasurement[] }> {
    return toViewpointExtras({ sections: this.sections.state(), measurements: await this.measure.state() });
  }

  async apply(state: { sections?: ViewpointSections; measurements?: ViewpointMeasurement[]; hidden?: boolean }): Promise<void> {
    const extras = readViewpointExtras(state);
    if (this.nav === "plan") await this.setNav("orbit");
    this.sections.apply(extras.sections);
    await this.measure.apply(extras.measurements);
    // A BCF viewpoint with visibility hides elements: offer "show all".
    if (state.hidden !== undefined) this.hidden = state.hidden;
    this.emit();
  }

  /** Elements hidden or isolated with the tools (saved as BCF visibility with a viewpoint). */
  visibilityChanged(): boolean {
    return this.hidden;
  }

  // ------------------------------------------------------------------ DOM events

  private onPointerDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY, type: e.pointerType };
  };

  private onClick = (e: MouseEvent) => {
    if (this.nav === "walk") {
      if (this.walkAwaitingStart) void this.startWalkAt(e.clientX, e.clientY);
      return;
    }
    const d = this.down;
    if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return; // a drag, not a click
    if (this.measure.active === "length" && d?.type === "touch") {
      void this.measure.tap(e.clientX, e.clientY);
      return;
    }
    if (this.measure.active) void this.measure.click();
  };

  private async startWalkAt(clientX: number, clientY: number) {
    const hit = await this.engine.fragments.raycast({
      camera: this.engine.world.camera.three,
      mouse: new THREE.Vector2(clientX, clientY),
      dom: this.canvas,
    });
    if (!hit || (hit.normal && Math.abs(hit.normal.y) < 0.6)) {
      this.hint = "Başlangıç için döşeme veya zemin yüzeyine tıklayın · Esc: vazgeç";
      return this.emit();
    }
    this.walkAwaitingStart = false;
    await this.walk.start(new THREE.Vector3(hit.point.x, hit.point.y + EYE_HEIGHT, hit.point.z));
    this.hint = matchMedia("(pointer: coarse)").matches ? "Sol alttaki kolla yürüyün, ekranı sürükleyerek bakın." : "Bakmak için tıklayın · W A S D ile yürüyün · Esc";
    this.emit();
  }

  private onDblClick = (e: MouseEvent) => {
    if (this.nav === "walk") return;
    if (this.sections.placing) {
      void this.sections.addPlaneAtPointer(e.clientX, e.clientY);
      return;
    }
    if (this.measure.active === "area") return this.measure.finishArea();
    if (this.measure.active) return;
    void this.dropIn(e.clientX, e.clientY);
  };

  /** Double-click on a floor in Yörünge / Plan: start walking there at eye height. */
  private async dropIn(clientX: number, clientY: number) {
    const hit = await this.engine.fragments.raycast({
      camera: this.engine.world.camera.three,
      mouse: new THREE.Vector2(clientX, clientY),
      dom: this.canvas,
    });
    if (!hit) return;
    if (hit.normal && Math.abs(hit.normal.y) < 0.6) return; // a wall, not a floor
    await this.setNav("walk", { walkAt: new THREE.Vector3(hit.point.x, hit.point.y + EYE_HEIGHT, hit.point.z) });
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target) || e.repeat) return;
    // Only when the viewer page is in front (no dialog open).
    if (document.querySelector("[role='dialog']")) return;
    if (e.key === "Enter" && this.measure.active === "area") {
      this.measure.finishArea();
      return;
    }
    const cmd = shortcutCommand(e);
    if (!cmd) return;
    // Without a model only the help is useful.
    if (!this.engine.fragments.list.size && cmd !== "help" && cmd !== "escape") return;
    if (cmd === "escape" && !this.helpOpen && !this.measure.active && !this.sections.placing && this.nav !== "walk") return;
    e.preventDefault();
    void this.run(cmd);
  };

  // ------------------------------------------------------------------ dispose

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.walk.dispose();
    this.listeners.clear();
    const canvas = this.engine.world.renderer?.three.domElement;
    canvas?.removeEventListener("pointerdown", this.onPointerDown);
    canvas?.removeEventListener("click", this.onClick);
    canvas?.removeEventListener("dblclick", this.onDblClick);
    window.removeEventListener("keydown", this.onKeyDown);
    try {
      this.engine.highlighter.events.select!.onHighlight.remove(this.onSelection);
      this.engine.highlighter.events.select!.onClear.remove(this.onSelection);
    } catch {
      // Highlighter already disposed.
    }
    this.cube?.dispose();
    this.cube = null;
    this.measure.dispose();
    this.sections.dispose();
  }
}

/** Storeys from the model data itself (IfcBuildingStorey Name / Elevation). */
async function storeysFromModel(model: {
  getItemsOfCategories(c: RegExp[]): Promise<Record<string, number[]>>;
  getItemsData(ids: number[], config?: object): Promise<Record<string, unknown>[]>;
}): Promise<StoreyInfo[]> {
  const ids = Object.values(await model.getItemsOfCategories([/^IFCBUILDINGSTOREY$/i])).flat();
  if (!ids.length) return [];
  const data = await model.getItemsData(ids, { attributesDefault: true, relationsDefault: { attributes: false, relations: false } });
  const val = (a: unknown) => (a && typeof a === "object" && "value" in a ? (a as { value: unknown }).value : null);
  return data.map((d, i) => {
    const name = val(d.Name) ?? val(d.LongName);
    const elev = Number(val(d.Elevation));
    return { name: typeof name === "string" && name ? name : `Kat #${ids[i]}`, elevation: val(d.Elevation) === null || !Number.isFinite(elev) ? null : elev };
  });
}
