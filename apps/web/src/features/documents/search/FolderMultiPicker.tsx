import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FolderDto } from "@sitekeep/shared";
import { documentsApi } from "../api";
import { Dialog } from "../../../shared/ui/Dialog";

/** Picks folders for "Search in selected folders": a lazily loaded tree with check boxes. */
export function FolderMultiPicker({
  projectId,
  rootId,
  value,
  onClose,
  onPick,
}: {
  projectId: string;
  rootId: string;
  /** Selected folder ids → names. */
  value: Record<string, string>;
  onClose(): void;
  onPick(next: Record<string, string>): void;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const [children, setChildren] = useState<Record<string, FolderDto[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set([rootId]));
  const [picked, setPicked] = useState<Record<string, string>>(value);
  const [error, setError] = useState<string | null>(null);

  async function load(id: string) {
    try {
      const c = await documentsApi.contents(projectId, id);
      setChildren((m) => ({ ...m, [id]: c.folders }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void load(rootId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, rootId]);

  function toggleOpen(id: string) {
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else {
        n.add(id);
        if (!children[id]) void load(id);
      }
      return n;
    });
  }

  function render(list: FolderDto[] | undefined, depth: number) {
    return list?.map((f) => (
      <div key={f.id}>
        <div className="row" style={{ paddingLeft: depth * 16, gap: 6, minHeight: 30 }}>
          <button
            type="button"
            className="ghost small"
            style={{ width: 24, padding: 0, visibility: f.hasChildren ? "visible" : "hidden" }}
            aria-label={open.has(f.id) ? t("searchPanel.pickFolders.collapse") : t("searchPanel.pickFolders.expand")}
            onClick={() => toggleOpen(f.id)}
          >
            {open.has(f.id) ? "▾" : "▸"}
          </button>
          <label className="row" style={{ gap: 6, margin: 0, fontWeight: 400, cursor: "pointer" }}>
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={!!picked[f.id]}
              onChange={() =>
                setPicked((p) => {
                  const n = { ...p };
                  if (n[f.id]) delete n[f.id];
                  else n[f.id] = f.name;
                  return n;
                })
              }
            />
            {f.name}
          </label>
        </div>
        {open.has(f.id) && render(children[f.id], depth + 1)}
      </div>
    ));
  }

  return (
    <Dialog title={t("searchPanel.pickFolders.title")} onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("searchPanel.pickFolders.hint")}
      </p>
      {error && <p className="error">{error}</p>}
      <div style={{ maxHeight: 360, overflow: "auto" }}>{render(children[rootId], 0)}</div>
      <div className="dialog-actions">
        <button onClick={onClose}>{t("common:actions.cancel")}</button>
        <button className="primary" onClick={() => onPick(picked)}>
          {t("searchPanel.pickFolders.apply", { count: Object.keys(picked).length })}
        </button>
      </div>
    </Dialog>
  );
}
