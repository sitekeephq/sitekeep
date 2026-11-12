/**
 * Loading path of the CAD viewer.
 *
 * The server builds dxf-viewer's scene of every drawing once ("2B sahne", preview kind "scene",
 * see apps/server/src/previews/scene-worker.ts and docs/features/VIEWERS.md). When it is ready the
 * viewer loads it through dxf-viewer's own `workerFactory` option: a stand-in worker answers the
 * DxfWorker message protocol (LOAD → PROGRESS … → LOAD reply, DESTROY) with the downloaded scene,
 * so nothing is parsed in the browser and the viewer ends up with exactly the scene object it
 * would have built itself (no fork, no patch). Until then the DXF is parsed as before, except
 * very large ones on phones (planCad).
 */
import type { CadCheck, PreviewDto, VersionPreviewDto } from "@sitekeep/shared";
import { i18n } from "../../i18n";
import { viewersApi } from "../../shared/api/api-viewers";

/** DXF size above which a phone does not try to parse the drawing itself. */
export const PHONE_DXF_LIMIT = 60 * 1024 * 1024;
/** Scene container: magic and format version (scene-worker.ts writes the same). */
export const SCENE_MAGIC = "7DSCENE1";
export const SCENE_FORMAT = 1;

const MSG_SIGNATURE = "DxfWorkerMsg";

export type CadSource = "scene" | "dxf";

export type CadPlan =
  | { show: "viewer"; source: CadSource; notice: string | null }
  | { show: "civil3d"; cad: CadCheck }
  | { show: "empty"; cad: CadCheck }
  /** The scene is being built: phones always wait for it; desktops wait for very large drawings. */
  | { show: "preparing"; dxfBytes: number; scene?: PreviewDto; canOpenDxf: boolean }
  /** Phone, very large DXF and no scene (failed or unavailable). */
  | { show: "too-big"; dxfBytes: number; scene?: PreviewDto };

/** Phone or small tablet: touch-first and a small screen (or a mobile user agent). */
export function isPhone(): boolean {
  if (typeof window === "undefined") return false;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return coarse && Math.min(window.screen.width, window.screen.height) < 820;
}

const busy = (p?: PreviewDto) => p?.status === "pending" || p?.status === "processing";

/** Warning for drawings shown although part of them could not be read. */
export function partialNotice(cad: CadCheck | undefined): string | null {
  if (cad?.status !== "partial") return null;
  if (cad.aeccClasses > 0) return i18n.t("viewers:cad.notices.civil3dPartial");
  return i18n.t("viewers:cad.notices.converterPartial", { count: cad.converterErrors });
}

/** What to show for a drawing whose DXF preview is ready. */
export function planCad(info: Pick<VersionPreviewDto, "previews" | "size">, opts: { phone: boolean; openDxf?: boolean }): CadPlan {
  const dxf = info.previews.find((p) => p.kind === "dxf");
  const scene = info.previews.find((p) => p.kind === "scene");
  const cad = dxf?.meta.cad;
  if (cad?.status === "civil3d") return { show: "civil3d", cad };
  if (cad?.status === "empty") return { show: "empty", cad };
  const notice = partialNotice(cad);
  if (scene?.status === "ready" && scene.meta.scene?.format === SCENE_FORMAT && !opts.openDxf) return { show: "viewer", source: "scene", notice };
  const dxfBytes = dxf?.meta.dxfBytes ?? info.size;
  if (dxfBytes <= PHONE_DXF_LIMIT || opts.openDxf) return { show: "viewer", source: "dxf", notice };
  // A scene is coming when it is queued or building (or about to be queued for older versions).
  const coming = busy(scene) || !scene;
  if (opts.phone) return coming ? { show: "preparing", dxfBytes, scene, canOpenDxf: false } : { show: "too-big", dxfBytes, scene };
  if (coming) return { show: "preparing", dxfBytes, scene, canOpenDxf: true };
  return { show: "viewer", source: "dxf", notice };
}

/** URL of the scene (model space only when asked and the drawing has paper-space entities). */
export function sceneUrl(projectId: string, info: Pick<VersionPreviewDto, "versionId" | "previews">, modelOnly: boolean): string {
  const scene = info.previews.find((p) => p.kind === "scene");
  const url = viewersApi.previewUrl(projectId, info.versionId, "scene");
  return modelOnly && scene?.meta.scene?.model ? `${url}?space=model` : url;
}

// ---------------------------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------------------------

const BUFFERS = ["vertices", "indices", "transforms"] as const;
const WIDTH = { vertices: 4, indices: 2, transforms: 4 } as const;

/** dxf-viewer's serialised scene (what DxfWorker hands the viewer). */
export interface DxfViewerScene {
  vertices: ArrayBuffer;
  indices: ArrayBuffer;
  transforms: ArrayBuffer;
  batches: unknown[];
  layers: { name: string; displayName: string; color: number }[];
  origin: { x: number; y: number } | null;
  bounds: { minX: number; maxX: number; minY: number; maxY: number } | null;
  hasMissingChars: boolean;
  [k: string]: unknown;
}

/** Drawing header kept with the scene ($INSUNITS, $MEASUREMENT, extents, $ACADVER). */
export interface SceneHeader {
  insunits: number | null;
  measurement: number | null;
  extMin: { x: number; y: number } | null;
  extMax: { x: number; y: number } | null;
  acadver: string | null;
}

function unshuffle(src: Uint8Array, width: number): ArrayBuffer {
  const out = new Uint8Array(src.length);
  const n = Math.floor(src.length / width);
  for (let b = 0; b < width; b++) {
    const base = b * n;
    for (let i = 0, j = b; i < n; i++, j += width) out[j] = src[base + i]!;
  }
  for (let k = n * width; k < src.length; k++) out[k] = src[k]!;
  return out.buffer;
}

/** Unpacks the scene container (format in scene-worker.ts). */
export function decodeScene(bytes: Uint8Array): { header: SceneHeader; scene: DxfViewerScene } {
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic !== SCENE_MAGIC) throw new Error(i18n.t("viewers:cad.errors.sceneUnknown"));
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + len))) as {
    v: number;
    header: SceneHeader;
    scene: Omit<DxfViewerScene, (typeof BUFFERS)[number]>;
    buffers: Record<(typeof BUFFERS)[number], [number, number]>;
    shuffled?: boolean;
  };
  if (json.v !== SCENE_FORMAT) throw new Error(i18n.t("viewers:cad.errors.sceneFormat", { version: json.v }));
  const scene = { ...json.scene } as DxfViewerScene;
  for (const k of BUFFERS) {
    const [o, l] = json.buffers[k];
    const part = bytes.subarray(o, o + l);
    scene[k] = json.shuffled ? unshuffle(part, WIDTH[k]) : (part.slice().buffer as ArrayBuffer);
  }
  return { header: json.header, scene };
}

/** Downloads the scene (the browser inflates the gzip); `onProgress` gets received/total bytes. */
export async function fetchScene(url: string, onProgress: (size: number, total: number | null) => void, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(url, { credentials: "same-origin", signal });
  if (!res.ok || !res.body) throw new Error(i18n.t("viewers:cad.errors.sceneDownload", { status: res.status }));
  const total = Number(res.headers.get("X-Scene-Bytes")) || null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    onProgress(size, total);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

type WorkerMsg = { seq: number; type: string; signature: string; data?: unknown; error?: string };

/**
 * Stand-in for dxf-viewer's web worker: answers LOAD with the prebuilt scene at the URL the viewer
 * was given (`DxfViewer.Load({ url: sceneUrl(…) })`), reporting the download as the "fetch" phase.
 */
class SceneWorker {
  private readonly listeners = new Set<(e: { data: WorkerMsg }) => void>();
  private readonly abort = new AbortController();

  addEventListener(type: string, fn: (e: { data: WorkerMsg }) => void): void {
    if (type === "message") this.listeners.add(fn);
  }

  removeEventListener(type: string, fn: (e: { data: WorkerMsg }) => void): void {
    if (type === "message") this.listeners.delete(fn);
  }

  terminate(): void {
    this.abort.abort();
    this.listeners.clear();
  }

  postMessage(msg: WorkerMsg): void {
    if (msg.signature !== MSG_SIGNATURE) return;
    if (msg.type === "LOAD") void this.load(msg.seq, (msg.data as { url: string }).url);
    else this.emit({ seq: msg.seq, type: msg.type, signature: MSG_SIGNATURE, data: null });
  }

  private emit(data: WorkerMsg): void {
    // Asynchronous, like a real worker.
    setTimeout(() => {
      for (const fn of this.listeners) fn({ data });
    }, 0);
  }

  private async load(seq: number, url: string): Promise<void> {
    const progress = (phase: string, size: number, totalSize: number | null) =>
      this.emit({ seq, type: "PROGRESS", signature: MSG_SIGNATURE, data: { phase, size, totalSize } });
    try {
      const bytes = await fetchScene(url, (size, total) => progress("fetch", size, total), this.abort.signal);
      progress("prepare", 0, null);
      const { scene } = decodeScene(bytes);
      this.emit({ seq, type: "LOAD", signature: MSG_SIGNATURE, data: { scene, dxf: undefined } });
    } catch (e) {
      if (!this.abort.signal.aborted) this.emit({ seq, type: "LOAD", signature: MSG_SIGNATURE, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** `workerFactory` for DxfViewer.Load that serves the prebuilt scene. */
export function sceneWorkerFactory(): () => Worker {
  return () => new SceneWorker() as unknown as Worker;
}
