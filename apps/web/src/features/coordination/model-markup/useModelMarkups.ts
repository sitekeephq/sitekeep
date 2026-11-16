/**
 * State of model markups in the IFC viewer (docs/features/MODEL_MARKUP.md): the list for the loaded
 * versions, the selected markup and whether its viewpoint is applied, and the pin / drawing modes.
 * The Viewer page owns one controller and hands it to MarkupLayer (canvas) and MarkupPanel (side).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewerEngine } from "@7dimensions-project/bim-viewer";
import {
  MODEL_MARKUP_COLORS,
  type MarkupShape,
  type ModelMarkupAnchor,
  type ModelMarkupDetailDto,
  type ModelMarkupKind,
  type ModelMarkupListDto,
  type Vec3,
  type IssueViewpoint,
} from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { modelMarkupApi } from "./api";

/** A markup captured in the viewer, waiting for its title and visibility. */
export interface PendingMarkup {
  kind: ModelMarkupKind;
  versionId: string;
  viewpoint: IssueViewpoint;
  anchor?: ModelMarkupAnchor;
  shapes?: MarkupShape[];
  color: string;
}

export type MarkupMode = null | "pin" | "draw";

export interface ModelMarkups {
  projectId: string;
  engine: ViewerEngine | null;
  loaded: string[];
  list: ModelMarkupListDto | null;
  error: string | null;
  setError(e: string | null): void;
  reload(): void;
  active: ModelMarkupDetailDto | null;
  /** Id of the markup whose viewpoint is applied and whose drawing is on the view. */
  shownId: string | null;
  hideOverlay(): void;
  select(id: string | null): void;
  refreshActive(): void;
  mode: MarkupMode;
  setMode(m: MarkupMode): void;
  pending: PendingMarkup | null;
  setPending(p: PendingMarkup | null): void;
  color: string;
  setColor(c: string): void;
  /** Loaded versions the caller may mark up. */
  markupVersions: string[];
  /** Loaded version → its file. */
  versionFiles: Record<string, string>;
  /** Scene frame of the loaded models (pins are moved into it). */
  frame: Vec3 | null;
  isOlder(id: string): boolean;
}

export function useModelMarkups(o: {
  projectId: string;
  engine: ViewerEngine | null;
  loaded: string[];
  /** All requested models are loaded. */
  ready: boolean;
  enabled: boolean;
  selectedId: string | null;
  onSelect(id: string | null): void;
  /** Adds model versions to the view (a markup of a federated view). */
  requestVersions(ids: string[]): void;
}): ModelMarkups {
  const { projectId, engine, loaded, ready, enabled, selectedId, onSelect, requestVersions } = o;
  const [list, setList] = useState<ModelMarkupListDto | null>(null);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<ModelMarkupDetailDto | null>(null);
  const [activeTick, setActiveTick] = useState(0);
  const [shownId, setShownId] = useState<string | null>(null);
  const [mode, setMode] = useState<MarkupMode>(null);
  const [pending, setPending] = useState<PendingMarkup | null>(null);
  const [color, setColor] = useState<string>(MODEL_MARKUP_COLORS[0]);
  const [versionInfo, setVersionInfo] = useState<{ markup: string[]; files: Record<string, string> }>({ markup: [], files: {} });
  const [frame, setFrame] = useState<Vec3 | null>(null);
  const loadedKey = loaded.join(",");

  useEffect(() => {
    if (!enabled || !loaded.length) {
      setList(null);
      return;
    }
    let alive = true;
    modelMarkupApi.list(projectId, loaded).then(
      (l) => alive && setList(l),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [enabled, projectId, loadedKey, tick]);

  useEffect(() => {
    if (!enabled || !loaded.length) return setVersionInfo({ markup: [], files: {} });
    let alive = true;
    void Promise.all(loaded.map((v) => api.versionInfo(projectId, v).catch(() => null))).then((infos) => {
      if (!alive) return;
      const ok = infos.filter((i): i is NonNullable<typeof i> => !!i);
      setVersionInfo({ markup: ok.filter((i) => i.canMarkup).map((i) => i.id), files: Object.fromEntries(ok.map((i) => [i.id, i.fileId])) });
    });
    return () => {
      alive = false;
    };
  }, [enabled, projectId, loadedKey]);

  useEffect(() => {
    if (!engine || !loaded.length) return setFrame(null);
    let alive = true;
    void engine.frameOffset().then((f) => alive && setFrame(f));
    return () => {
      alive = false;
    };
  }, [engine, loadedKey]);

  // The selected markup in full (snapshot, comments).
  useEffect(() => {
    if (!selectedId) {
      setActive(null);
      setShownId(null);
      return;
    }
    let alive = true;
    modelMarkupApi.get(projectId, selectedId).then(
      (m) => alive && setActive(m),
      (e: Error) => {
        if (!alive) return;
        setError(e.message);
        onSelect(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [projectId, selectedId, activeTick]);

  const isOlder = useCallback((id: string) => !!list?.older.some((m) => m.id === id), [list]);

  // Restore the viewpoint of the selected markup once its models are loaded.
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!engine || !active || !list || applied.current === active.id) return;
    if (!list.current.some((m) => m.id === active.id)) return;
    const missing = active.versionIds.filter((v) => !loaded.includes(v));
    if (missing.length) {
      requestVersions(missing);
      return;
    }
    if (!ready) return;
    applied.current = active.id;
    engine
      .applyViewpoint(active.viewpoint)
      .then(() => setShownId(active.id))
      .catch((e: Error) => setError(e.message));
  }, [engine, active, list, loadedKey, ready]);

  useEffect(() => {
    if (!selectedId) applied.current = null;
  }, [selectedId]);

  const select = useCallback(
    (id: string | null) => {
      applied.current = null;
      setShownId(null);
      if (id === selectedId) setActiveTick((n) => n + 1);
      onSelect(id);
    },
    [selectedId, onSelect],
  );

  return useMemo(
    () => ({
      projectId,
      engine,
      loaded,
      list,
      error,
      setError,
      reload: () => setTick((n) => n + 1),
      active,
      shownId,
      hideOverlay: () => setShownId(null),
      select,
      refreshActive: () => setActiveTick((n) => n + 1),
      mode,
      setMode,
      pending,
      setPending,
      color,
      setColor,
      markupVersions: versionInfo.markup,
      versionFiles: versionInfo.files,
      frame,
      isOlder,
    }),
    [projectId, engine, loaded, list, error, active, shownId, select, mode, pending, color, versionInfo, frame, isOlder],
  );
}
