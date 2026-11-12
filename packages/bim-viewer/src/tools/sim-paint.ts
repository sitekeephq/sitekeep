/**
 * 4D / 5D painting on top of the viewer engine (kept out of engine.ts): playback states with
 * activity colours, hidden or ghosted not-started elements, the cost heat map and canvas video
 * recording. Uses only the engine's public That Open objects (highlighter, hider, fragments).
 */
import * as OBC from "@thatopen/components";
import * as THREE from "three";
import type { ViewerEngine } from "../core/ViewerEngine.js";

/** In-progress activities get these colours (by activity order); late is always red. */
export const SIM_PALETTE = ["#f79009", "#2e90fa", "#7a5af8", "#ee46bc", "#15b79e", "#ca8504", "#6172f3", "#dd2590"];
export const SIM_LATE = "#d92d20";
export const SIM_GHOST = "#9aa5b1";
/** Sequential cost ramp, low → high. */
export const COST_RAMP = ["#fff3bf", "#ffd8a8", "#ffa94d", "#fd7e14", "#e8590c", "#c92a2a"];

const S = {
  ghost: "sim-ghost",
  fade: "sim-fade",
  late: "sim-late",
  act: (i: number) => `sim-a${i}`,
  cost: (i: number) => `sim-c${i}`,
};
const ALL_STYLES = [S.ghost, S.fade, S.late, ...SIM_PALETTE.map((_, i) => S.act(i)), ...COST_RAMP.map((_, i) => S.cost(i))];

type Model = { getLocalIdsByGuids(g: string[]): Promise<(number | null)[]>; getLocalIds(): Promise<number[]> };

/** GlobalId → local id per model, resolved once (playback repaints many times). */
export class GuidCache {
  private readonly maps = new Map<string, Map<string, number | null>>();
  private readonly all = new Map<string, number[]>();

  async ids(modelId: string, model: Model, guids: string[]): Promise<number[]> {
    let m = this.maps.get(modelId);
    if (!m) this.maps.set(modelId, (m = new Map()));
    const missing = guids.filter((g) => !m!.has(g));
    if (missing.length) {
      const res = await model.getLocalIdsByGuids(missing);
      missing.forEach((g, i) => m!.set(g, res[i] ?? null));
    }
    const out: number[] = [];
    for (const g of guids) {
      const id = m.get(g);
      if (id !== null && id !== undefined) out.push(id);
    }
    return out;
  }

  async allIds(modelId: string, model: Model): Promise<number[]> {
    let ids = this.all.get(modelId);
    if (!ids) this.all.set(modelId, (ids = await model.getLocalIds()));
    return ids;
  }
}

function ensureStyles(engine: ViewerEngine) {
  const styles = engine.highlighter.styles;
  if (styles.has(S.late)) return;
  const def = (hex: string, opacity: number, priority: number) => ({
    color: new THREE.Color(hex),
    opacity,
    transparent: opacity < 1,
    renderedFaces: 0 as const,
    priority,
  });
  styles.set(S.fade, def(SIM_GHOST, 0.06, -4));
  styles.set(S.ghost, def(SIM_GHOST, 0.18, -3));
  styles.set(S.late, def(SIM_LATE, 1, 3));
  SIM_PALETTE.forEach((c, i) => styles.set(S.act(i), def(c, 1, 2)));
  COST_RAMP.forEach((c, i) => styles.set(S.cost(i), def(c, 1, 1)));
}

async function clearStyles(engine: ViewerEngine) {
  for (const style of ALL_STYLES) {
    if (engine.highlighter.styles.has(style) && engine.highlighter.selection[style]) await engine.highlighter.clear(style);
  }
}

/** Local ids hidden by the last "Başlamayanları Gizle" frame, per model. */
const hiddenNotStarted = new WeakMap<ViewerEngine, Map<string, Set<number>>>();

/**
 * Hide elements that have not started, and show only the ones that just started.
 * A full `hider.set(true)` first reveals every element and the scene reloads, then the
 * hide deletes them again — playback looks like it jumps instead of stepping.
 */
async function stepHidden(engine: ViewerEngine, cache: GuidCache, notStarted: string[]): Promise<void> {
  const prev = hiddenNotStarted.get(engine) ?? new Map<string, Set<number>>();
  const next = new Map<string, Set<number>>();
  const jobs: Promise<void>[] = [];
  for (const [modelId, model] of engine.fragments.list) {
    const want = new Set(await cache.ids(modelId, model, notStarted));
    const had = prev.get(modelId) ?? new Set<number>();
    const hide: number[] = [];
    const show: number[] = [];
    for (const id of want) if (!had.has(id)) hide.push(id);
    for (const id of had) if (!want.has(id)) show.push(id);
    if (hide.length) jobs.push(model.setVisible(hide, false));
    if (show.length) jobs.push(model.setVisible(show, true));
    next.set(modelId, want);
  }
  await Promise.all(jobs);
  hiddenNotStarted.set(engine, next);
}

export async function clearSim(engine: ViewerEngine): Promise<void> {
  hiddenNotStarted.delete(engine);
  await clearStyles(engine);
  if (engine.fragments.list.size) await engine.components.get(OBC.Hider).set(true);
  engine.fragments.core.update(true);
}

export interface SimPaint {
  /** Not started: hidden or ghosted. */
  notStarted: string[];
  hideNotStarted: boolean;
  late: string[];
  /** In progress, by palette index of their activity. */
  inProgress: Map<number, string[]>;
  /** Elements of no activity are faded. */
  fadeUnlinked: boolean;
  /** Every linked element (complete ones keep their own colours). */
  linked: Set<string>;
}

/** Paints one playback frame. */
export async function paintSim(engine: ViewerEngine, cache: GuidCache, p: SimPaint): Promise<void> {
  ensureStyles(engine);
  if (p.hideNotStarted) await stepHidden(engine, cache, p.notStarted);
  else {
    hiddenNotStarted.delete(engine);
    await engine.components.get(OBC.Hider).set(true);
  }
  await clearStyles(engine);
  for (const [modelId, model] of engine.fragments.list) {
    const paint = async (style: string, guids: string[]) => {
      const ids = await cache.ids(modelId, model, guids);
      if (ids.length) await engine.highlighter.highlightByID(style, { [modelId]: new Set(ids) }, true, false);
      return ids;
    };
    if (!p.hideNotStarted) await paint(S.ghost, p.notStarted);
    await paint(S.late, p.late);
    for (const [i, guids] of p.inProgress) await paint(S.act(i % SIM_PALETTE.length), guids);
    if (p.fadeUnlinked) {
      const linked = new Set(await cache.ids(modelId, model, [...p.linked]));
      const rest = (await cache.allIds(modelId, model)).filter((id) => !linked.has(id));
      if (rest.length) await engine.highlighter.highlightByID(S.fade, { [modelId]: new Set(rest) }, true, false);
    }
  }
  engine.fragments.core.update(true);
}

/** Bin (0…ramp-1) of an amount on a square-root scale (a few expensive elements do not flatten the rest). */
export function costBin(amount: number, max: number, bins = COST_RAMP.length): number {
  if (max <= 0 || amount <= 0) return 0;
  return Math.min(bins - 1, Math.floor(Math.sqrt(amount / max) * bins));
}

/** Cost heat map: elements by cost bin; elements without cost are faded. */
export async function paintCost(engine: ViewerEngine, cache: GuidCache, costs: Map<string, { elements: Record<string, number>; max: number }>): Promise<void> {
  ensureStyles(engine);
  await clearStyles(engine);
  await engine.components.get(OBC.Hider).set(true);
  const max = Math.max(0, ...[...costs.values()].map((c) => c.max));
  for (const [modelId, model] of engine.fragments.list) {
    const c = costs.get(modelId);
    const bins = COST_RAMP.map((): string[] => []);
    for (const [guid, amount] of Object.entries(c?.elements ?? {})) if (amount > 0) bins[costBin(amount, max)]!.push(guid);
    const painted = new Set<number>();
    for (let i = 0; i < bins.length; i++) {
      const ids = await cache.ids(modelId, model, bins[i]!);
      ids.forEach((id) => painted.add(id));
      if (ids.length) await engine.highlighter.highlightByID(S.cost(i), { [modelId]: new Set(ids) }, true, false);
    }
    const rest = (await cache.allIds(modelId, model)).filter((id) => !painted.has(id));
    if (rest.length) await engine.highlighter.highlightByID(S.fade, { [modelId]: new Set(rest) }, true, false);
  }
  engine.fragments.core.update(true);
}

/** Records the viewer canvas as WebM ("Video Kaydet"); null when the browser cannot. */
export function recordCanvas(engine: ViewerEngine): { stop(): Promise<Blob> } | null {
  const canvas = engine.world.renderer?.three.domElement as HTMLCanvasElement | undefined;
  if (!canvas || typeof MediaRecorder === "undefined" || !("captureStream" in canvas)) return null;
  const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) return null;
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start(500);
  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        rec.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          resolve(new Blob(chunks, { type: "video/webm" }));
        };
        rec.stop();
      }),
  };
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
