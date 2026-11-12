/**
 * Playground host for the e2e suite. It wires the package the way a product does (7D CDE's
 * Viewer page): load buttons, "Sığdır", the properties panel, the phone "⋯ Diğer" menu built from
 * toolMoreItems, a remount button and an optional extension (?ext=1). window.__pg holds small
 * read-only probes for the specs (screen position of an IFC point, a canvas pixel).
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import type { SelectedItem, ViewerEngine, ViewerExtension } from "../src/index";
import { PropertiesPanel, ViewerCanvas, ViewerToolsHud, useViewerTools } from "../src/react";
import { toolMoreItems } from "../src/tools";
import type { ViewerTools } from "../src/tools/tools";
import "../styles.css";
import "../tools.css";
import "./playground.css";

type Vec3 = [number, number, number];

interface PlaygroundProbe {
  load(set: keyof typeof MODEL_SETS): Promise<string[]>;
  screenOf(modelId: string, ifcPoint: Vec3): Promise<{ x: number; y: number } | null>;
  pixel(x: number, y: number): Promise<[number, number, number, number]>;
  extensionLog: string[];
}

declare global {
  interface Window {
    __viewer?: ViewerEngine;
    __tools?: ViewerTools | null;
    __pg?: PlaygroundProbe;
  }
}

const MODEL_SETS = {
  wall: [{ id: "wall", url: "/models/sample-wall.frag" }],
  federation: [
    { id: "arch", url: "/models/coord-arch.frag" },
    { id: "mep", url: "/models/coord-mep.frag" },
  ],
  /** One building in three discipline models (scripts/build-discipline-frags.mjs). */
  disciplines: [
    { id: "mimari", url: "/models/disc-mimari.frag" },
    { id: "statik", url: "/models/disc-statik.frag" },
    { id: "mekanik", url: "/models/disc-mekanik.frag" },
  ],
} as const;

const extensionLog: string[] = [];

const PLAYGROUND_EXTENSION: ViewerExtension = {
  id: "pg-marker",
  activate({ container }) {
    container.dataset.pgExtension = "on";
    extensionLog.push("activate");
    return () => {
      delete container.dataset.pgExtension;
      extensionLog.push("cleanup");
    };
  },
};

const NO_EXTENSIONS: readonly ViewerExtension[] = [];
const WITH_EXTENSION: readonly ViewerExtension[] = [PLAYGROUND_EXTENSION];
const extensions = new URLSearchParams(location.search).has("ext") ? WITH_EXTENSION : NO_EXTENSIONS;

async function loadSet(engine: ViewerEngine, set: keyof typeof MODEL_SETS): Promise<string[]> {
  for (const { id, url } of MODEL_SETS[set]) {
    await engine.load(id, url);
    await engine.align(id);
  }
  engine.fragments.core.update(true);
  return engine.loadedIds;
}

function nextFrames(n = 2): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve());
    step(n);
  });
}

function probe(engine: ViewerEngine, onLoaded: (ids: string[]) => void): PlaygroundProbe {
  const canvas = () => engine.world.renderer!.three.domElement;
  return {
    async load(set) {
      const ids = await loadSet(engine, set);
      onLoaded(ids);
      return ids;
    },
    async screenOf(modelId, ifcPoint) {
      const p = await engine.ifcToScene(ifcPoint, modelId);
      if (!p) return null;
      // setLookAt(…, false) reaches the three.js camera on the next controls update.
      engine.world.camera.controls.update(0);
      const camera = engine.world.camera.three as THREE.Camera;
      camera.updateMatrixWorld();
      const ndc = p.clone().project(camera);
      const rect = canvas().getBoundingClientRect();
      return { x: rect.left + ((ndc.x + 1) / 2) * rect.width, y: rect.top + ((1 - ndc.y) / 2) * rect.height };
    },
    async pixel(x, y) {
      engine.fragments.core.update(true);
      await nextFrames();
      const source = canvas();
      const rect = source.getBoundingClientRect();
      const sx = Math.round(((x - rect.left) / rect.width) * source.width);
      const sy = Math.round(((y - rect.top) / rect.height) * source.height);
      const copy = document.createElement("canvas");
      copy.width = 1;
      copy.height = 1;
      const ctx = copy.getContext("2d")!;
      ctx.drawImage(source, sx, sy, 1, 1, 0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a];
    },
    extensionLog,
  };
}

/** Phone "⋯ Diğer" menu, the same contract as the CDE MoreMenu (menuitem / menuitemcheckbox). */
function MoreMenu({ items, onSelect }: { items: ReturnType<typeof toolMoreItems>; onSelect(key: string): void }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <div className="pg-more">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        ⋯ Diğer
      </button>
      {open && (
        <ul role="menu" className="pg-more-list">
          {items.map((item) => (
            <li
              key={item.key}
              role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={item.checked}
              tabIndex={-1}
              onClick={() => {
                setOpen(false);
                onSelect(item.key);
              }}
            >
              {item.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Viewer({ onRemount }: { onRemount(): void }) {
  const [engine, setEngine] = useState<ViewerEngine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<SelectedItem | null>(null);
  const viewerTools = useViewerTools(engine, {
    loaded,
    onFit: () => void engine?.fit(),
  });

  useEffect(() => {
    window.__viewer = engine ?? undefined;
    window.__tools = viewerTools.tools;
    window.__pg = engine ? probe(engine, setLoaded) : undefined;
  }, [engine, viewerTools.tools]);

  const load = async (set: keyof typeof MODEL_SETS) => {
    if (!engine) return;
    setBusy(true);
    setError(null);
    try {
      setLoaded(await loadSet(engine, set));
      await engine.fit();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="viewer-shell" className="pg-shell">
      <div className="pg-bar" role="toolbar" aria-label="Playground">
        <button type="button" disabled={!engine || busy} onClick={() => void load("wall")}>
          Duvar Modeli
        </button>
        <button type="button" disabled={!engine || busy} onClick={() => void load("federation")}>
          Federasyon
        </button>
        <button type="button" disabled={!engine || busy} onClick={() => void load("disciplines")}>
          Disiplinler
        </button>
        <button type="button" disabled={!loaded.length} onClick={() => void engine?.fit()}>
          Sığdır
        </button>
        <button type="button" onClick={onRemount}>
          Yeniden Kur
        </button>
        <MoreMenu items={loaded.length ? toolMoreItems(viewerTools.state) : []} onSelect={viewerTools.command} />
      </div>
      <div data-testid="viewer-canvas" className="pg-canvas">
        <ViewerCanvas
          workerUrl="/fragments-worker.mjs"
          extensions={extensions}
          onReady={(next) => {
            setEngine(next);
            setError(null);
          }}
          onSelectionChange={setSelected}
          onError={(err) => {
            setError(err instanceof Error ? err.message : String(err));
          }}
        />
        <ViewerToolsHud {...viewerTools} loaded={loaded.length > 0} aboutText="7D BIM Viewer playground." />
      </div>
      {selected && (
        <aside className="pg-props" aria-label="Özellikler">
          <PropertiesPanel selected={selected} onClose={() => void engine?.highlighter.clear("select")} />
        </aside>
      )}
      {engine && (
        <div data-testid="viewer-ready" className="pg-flag">
          hazır · <span data-testid="loaded-models">{loaded.join(",") || "model yok"}</span>
        </div>
      )}
      {error && (
        <div data-testid="viewer-error" role="alert" className="pg-flag pg-error">
          {error}
        </div>
      )}
    </div>
  );
}

function App() {
  const [generation, setGeneration] = useState(0);
  return <Viewer key={generation} onRemount={() => setGeneration((n) => n + 1)} />;
}

createRoot(document.getElementById("root")!).render(<App />);
