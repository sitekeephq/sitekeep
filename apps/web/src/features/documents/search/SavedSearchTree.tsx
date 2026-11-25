import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SavedSearchDto } from "@sitekeep/shared";
import { Icon } from "../../../shared/ui/Icon";

/** "Kayıtlı aramalar" under the folder tree: the caller's and shared saved searches, one click runs one. */
export function SavedSearchTree({
  saved,
  activeId,
  onRun,
}: {
  saved: SavedSearchDto[] | null;
  activeId: string | null;
  onRun(s: SavedSearchDto): void;
}) {
  const { t } = useTranslation("documents");
  const [open, setOpen] = useState(true);
  if (!saved?.length) return null;
  return (
    <div className="saved-search-tree" data-testid="saved-search-tree">
      <div className="tree-node" style={{ paddingLeft: 8 }} onClick={() => setOpen((o) => !o)} role="button" aria-expanded={open}>
        <span className="tree-toggle">{open ? "▾" : "▸"}</span>
        <span className="row-icon">
          <Icon name="filter" />
        </span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t("searchPanel.tabs.saved")}</span>
        <span className="muted small" style={{ marginLeft: 4 }}>
          {saved.length}
        </span>
      </div>
      {open &&
        saved.map((s) => (
          <div
            key={s.id}
            className={`tree-node${activeId === s.id ? " active" : ""}`}
            style={{ paddingLeft: 30 }}
            title={s.mine ? s.name : t("searchPanel.saved.sharedBy", { name: s.ownerName ?? "—" })}
            onClick={() => onRun(s)}
          >
            <span className="row-icon">
              <Icon name="search" />
            </span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</span>
          </div>
        ))}
    </div>
  );
}
