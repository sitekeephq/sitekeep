import { useEffect, useState } from "react";
import type { FolderDto } from "@sitekeep/shared";
import { documentsApi } from "../api";
import { Icon } from "../../../shared/ui/Icon";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";

interface Props {
  projectId: string;
  rootId: string;
  activeId: string;
  /** Bump to reload expanded nodes. */
  version: number;
  onSelect(id: string): void;
}

/** Lazily loaded folder tree; the path to the active folder opens automatically. */
export function FolderTree({ projectId, rootId, activeId, version, onSelect }: Props) {
  const [children, setChildren] = useState<Record<string, FolderDto[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set([rootId]));
  const [root, setRoot] = useState<FolderDto | null>(null);

  async function load(id: string) {
    const c = await documentsApi.contents(projectId, id);
    setChildren((m) => ({ ...m, [id]: c.folders }));
    if (id === rootId) setRoot(c.folder);
  }

  useEffect(() => {
    setChildren({});
    void load(rootId);
    // Expand the path to the active folder.
    documentsApi.folder(projectId, activeId).then((f) => {
      const ids = f.path.map((p) => p.id);
      setOpen((s) => new Set([...s, ...ids]));
      for (const id of ids) void load(id);
    }, () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, rootId, version]);

  useEffect(() => {
    documentsApi.folder(projectId, activeId).then((f) => {
      const ids = f.path.map((p) => p.id);
      setOpen((s) => new Set([...s, ...ids]));
      for (const id of ids) if (!children[id]) void load(id);
    }, () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  function toggle(id: string) {
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

  function render(f: FolderDto, depth: number) {
    const kids = children[f.id];
    const isOpen = open.has(f.id);
    return (
      <div key={f.id}>
        <div
          className={`tree-node${f.id === activeId ? " active" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          data-tour-folder={f.name}
          onClick={() => onSelect(f.id)}
        >
          <span
            className="tree-toggle"
            onClick={(e) => {
              e.stopPropagation();
              toggle(f.id);
            }}
          >
            {(kids ? kids.length > 0 : !!f.hasChildren) ? (isOpen ? "▾" : "▸") : ""}
          </span>
          <span className="row-icon"><Icon name="folder" /></span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</span>
        </div>
        {isOpen && kids?.map((k) => render(k, depth + 1))}
      </div>
    );
  }

  return root ? render(root, 0) : <LoadingIndicator compact />;
}
