/**
 * Creates the viewer tools for an engine, keeps their state in React and routes the phone
 * "⋯ Diğer" items. The tools are disposed with the page (and before the engine).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewerEngine } from "../core/ViewerEngine.js";
import { ViewerTools, type ToolsState, type ViewerToolsOptions } from "../tools/tools.js";
import { isToolMoreKey, type ToolPanel } from "../tools/tools-phone.js";
import type { ToolCommand } from "../tools/shortcuts.js";

export interface ViewerToolsHandle {
  tools: ViewerTools | null;
  state: ToolsState | null;
  panel: ToolPanel | null;
  setPanel(p: ToolPanel | null | ((p: ToolPanel | null) => ToolPanel | null)): void;
  /** A "t:…" key from the phone menu. */
  command(key: string): void;
}

export interface UseViewerToolsOptions {
  loaded: readonly string[];
  onFit?: () => void;
  storeyLoader?: ViewerToolsOptions["serverStoreys"];
}

export function useViewerTools(engine: ViewerEngine | null, opts: UseViewerToolsOptions): ViewerToolsHandle {
  const [tools, setTools] = useState<ViewerTools | null>(null);
  const [state, setState] = useState<ToolsState | null>(null);
  const [panel, setPanel] = useState<ToolPanel | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!engine) return;
    const t = new ViewerTools(engine, {
      serverStoreys: (versionId) => optsRef.current.storeyLoader?.(versionId) ?? Promise.resolve(null),
      onFit: () => optsRef.current.onFit?.(),
    });
    engine.extras = t;
    setTools(t);
    setState(t.state);
    const off = t.subscribe(() => setState(t.state));
    return () => {
      off();
      if (engine.extras === t) engine.extras = null;
      t.dispose();
      setTools(null);
      setState(null);
    };
  }, [engine]);

  const loadedKey = opts.loaded.join(",");
  useEffect(() => {
    tools?.modelsChanged();
  }, [tools, loadedKey]);

  // Panels follow the tools: Plan shows the storeys, a measuring tool its list, sections theirs.
  const nav = state?.nav;
  const measuring = !!state?.measureTool;
  const sectioning = !!state?.sectionPlacing;
  useEffect(() => {
    if (nav === "plan") setPanel("plan");
    else setPanel((p) => (p === "plan" ? null : p));
  }, [nav]);
  useEffect(() => {
    if (measuring) setPanel("measure");
  }, [measuring]);
  useEffect(() => {
    if (sectioning) setPanel("sections");
  }, [sectioning]);

  const command = useCallback(
    (key: string) => {
      if (!tools || !isToolMoreKey(key)) return;
      const rest = key.slice(2);
      if (rest.startsWith("panel:")) return setPanel(rest.slice(6) as ToolPanel);
      if (rest === "measure:volume") {
        tools.setMeasureTool("volume");
        return setPanel("measure");
      }
      void tools.run(rest as ToolCommand);
    },
    [tools],
  );

  return { tools, state, panel, setPanel, command };
}
