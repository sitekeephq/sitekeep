/** IFC model versions to pick from and their vocabulary (classes, storeys, properties) for rule editors (4D, 5D). */
import { useEffect, useMemo, useState } from "react";
import type { ModelVocabDto } from "@sitekeep/shared";
import { ApiError, api } from "../api/api";
import { useLoad, useProject } from "../../app/context/project";

export interface ModelChoice {
  versionId: string;
  fileId: string;
  label: string;
}

/** IFC model versions to choose from (the given ones first, else the newest of every IFC file). */
export function useModelChoices(versionIds: string[]): ModelChoice[] | null {
  const project = useProject();
  const { data } = useLoad(() => api.models(project.id), [project.id]);
  return useMemo(() => {
    if (!data) return null;
    const out = new Map<string, ModelChoice>();
    for (const id of versionIds) {
      const m = data.find((x) => x.id === id);
      if (m) out.set(m.id, { versionId: m.id, fileId: m.fileId, label: `${m.fileName} · V${m.version}` });
    }
    for (const m of data.filter((x) => x.isLatest)) if (![...out.values()].some((c) => c.fileId === m.fileId)) out.set(m.id, { versionId: m.id, fileId: m.fileId, label: `${m.fileName} · V${m.version}` });
    return [...out.values()];
  }, [data, versionIds]);
}

export function useVocab(versionId: string | null): { vocab: ModelVocabDto | null; error: string | null } {
  const project = useProject();
  const [vocab, setVocab] = useState<ModelVocabDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    setVocab(null);
    setError(null);
    const load = () => {
      if (!versionId) return;
      api.modelVocab(project.id, versionId).then(
        (v) => alive && setVocab(v),
        (e: Error) => {
          if (!alive) return;
          setError(e.message);
          if (e instanceof ApiError && e.status === 409) timer = setTimeout(load, 4000);
        },
      );
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [project.id, versionId]);
  return { vocab, error };
}
