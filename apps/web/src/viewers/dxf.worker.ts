/**
 * Web worker for dxf-viewer: fetches, parses and prepares the DXF scene off the main thread.
 * dxf-viewer's own worker, except that frozen layers are built too and the scene's layer list
 * carries each layer's state (frozen, off, locked; @sitekeep/shared cad-layers.ts): the viewer
 * lists every layer and hides frozen and off layers itself, as the server-built scene does.
 */
import { DxfWorker } from "dxf-viewer/src/DxfWorker.js";
import DxfParser from "dxf-viewer/src/parser/DxfParser.js";
import { DxfScene } from "dxf-viewer/src/DxfScene.js";
import { dxfLayerStates, unfreezeLayers, withLayerStates } from "@sitekeep/shared";

type Progress = ((phase: string, size: number, totalSize: number | null) => void) | null;
type Scene = { layers: { name: string }[] };
interface WorkerBase {
  _CreateFontFetchers(urls: string[], progressCbk: Progress): (() => Promise<unknown>)[];
}
const Base = DxfWorker as new (worker: unknown, isWorker: boolean) => WorkerBase;
const Parser = DxfParser as new () => { parseSync(text: string): Parameters<typeof unfreezeLayers>[0] };
const Scene = DxfScene as new (options: unknown) => { Build(dxf: unknown, fonts: (() => Promise<unknown>)[]): Promise<void>; scene: Scene };

/** Same steps as DxfFetcher.Fetch, keeping the text for the layer table. */
async function fetchText(url: string, encoding: string, progressCbk: Progress): Promise<string> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Failed to fetch DXF file: HTTP ${response.status} ${response.statusText}`); // i18n-ok: dxf-viewer's own message, shown in cad.errors.openFailed
  const totalSize = Number(response.headers.get("Content-Length")) || null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder(encoding);
  const parts: string[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(decoder.decode(value, { stream: true }));
    received += value.length;
    progressCbk?.("fetch", received, totalSize);
  }
  parts.push(decoder.decode());
  return parts.join("");
}

class LayerStateWorker extends Base {
  async _Load(url: string, fonts: string[] | null, options: { fileEncoding?: string }, progressCbk: Progress): Promise<{ scene: Scene; dxf: undefined }> {
    const fontFetchers = fonts ? this._CreateFontFetchers(fonts, progressCbk) : [];
    let text: string | null = await fetchText(url, options.fileEncoding ?? "utf-8", progressCbk);
    progressCbk?.("parse", 0, null);
    const dxf = new Parser().parseSync(text);
    const states = dxfLayerStates(text);
    text = null;
    unfreezeLayers(dxf);
    progressCbk?.("prepare", 0, null);
    const dxfScene = new Scene(options);
    await dxfScene.Build(dxf, fontFetchers);
    dxfScene.scene.layers = withLayerStates(dxfScene.scene.layers, states);
    return { scene: dxfScene.scene, dxf: undefined };
  }
}

new LayerStateWorker(self, true);
