import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ProjectDto } from "@sitekeep/shared";

export const ProjectContext = createContext<ProjectDto | null>(null);

export function useProject(): ProjectDto {
  const p = useContext(ProjectContext);
  if (!p) throw new Error("useProject outside a project");
  return p;
}

/** Loads data and exposes a reload function; errors are kept as text. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    load().then(
      (d) => alive && setData(d),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((t) => t + 1), setData };
}

/**
 * On narrow screens list + detail stack vertically, so a detail opened from the list would appear below it.
 * Returns a ref for the detail panel that scrolls it into view whenever `key` (the loaded record) changes.
 */
export function useRevealOnNarrow<T extends HTMLElement>(key: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (key && ref.current && window.matchMedia("(max-width: 1100px)").matches) ref.current.scrollIntoView({ block: "start" });
  }, [key]);
  return ref;
}
