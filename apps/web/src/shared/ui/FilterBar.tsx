import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { HUB_LABELS } from "../../app/navigation/nav";
import { NavIcon } from "./NavIcon";

export interface FilterChip {
  key: string;
  label: string;
  clear(): void;
}

/**
 * One filter row: a search box, a "Filtreler" popover (status, due, grouping…) and the active
 * filters as removable chips. `extra` holds the view's own buttons (list switch, Rapor…).
 */
export function FilterBar({
  search,
  onSearch,
  placeholder,
  popover,
  chips,
  onClearAll,
  extra,
}: {
  search?: string;
  onSearch?(v: string): void;
  placeholder?: string;
  popover?: ReactNode;
  chips: FilterChip[];
  onClearAll?(): void;
  extra?: ReactNode;
}) {
  const { t } = useTranslation("shell");
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const count = chips.filter((c) => c.key !== "q").length;

  return (
    <div className="filter-bar">
      {onSearch && (
        <input
          type="search"
          className="filter-search"
          placeholder={placeholder ?? t("filterBar.placeholder")}
          value={search ?? ""}
          onChange={(e) => onSearch(e.target.value)}
          aria-label={t("filterBar.search")}
        />
      )}
      {popover && (
        <div className="filter-pop-wrap" ref={wrap}>
          <button className={count ? "has-filters" : ""} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog">
            <NavIcon name="filter" size={15} /> {t(HUB_LABELS.filters)}
            {count > 0 && <span className="badge info">{count}</span>}
          </button>
          {open && (
            <div className="filter-pop" role="dialog" aria-label={t(HUB_LABELS.filters)}>
              {popover}
              {onClearAll && count > 0 && (
                <div className="dialog-actions" style={{ marginTop: 10 }}>
                  <button className="small" onClick={onClearAll}>
                    {t(HUB_LABELS.clearFilters)}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {chips.length > 0 && (
        <div className="filter-chips">
          {chips.map((c) => (
            <span key={c.key} className="filter-chip">
              {c.label}
              <button className="ghost small" onClick={c.clear} aria-label={t("filterBar.removeFilter", { filter: c.label })} title={t("filterBar.remove")}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="spacer" />
      {extra}
    </div>
  );
}
