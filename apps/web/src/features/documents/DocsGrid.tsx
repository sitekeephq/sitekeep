import { useEffect, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { FileDto, FolderDto } from "@sitekeep/shared";
import { intlLocale } from "../../shared/lib/format";
import { Icon } from "../../shared/ui/Icon";

export type SortKey = "name" | "description" | "version" | "size" | "user" | "date" | `attr:${string}`;
export interface DocsSort {
  key: SortKey;
  dir: "asc" | "desc";
}

const WIDTHS_KEY = "docs.columnWidths";
const MIN_WIDTH = 60;
const DEFAULT_WIDTHS: Record<string, number> = {
  check: 40,
  name: 320,
  description: 240,
  version: 112,
  size: 100,
  user: 160,
  date: 150,
  approval: 130,
  status: 150,
};
const ATTRIBUTE_WIDTH = 140;

/** Column widths the user dragged, remembered per browser. */
export function useColumnWidths() {
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "{}") as Record<string, number>;
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths));
    } catch {
      // Private mode: widths just stop persisting.
    }
  }, [widths]);
  const width = (key: string) => widths[key] ?? DEFAULT_WIDTHS[key] ?? ATTRIBUTE_WIDTH;
  const resize = (key: string, w: number | null) =>
    setWidths((prev) => {
      const next = { ...prev };
      if (w === null) delete next[key];
      else next[key] = Math.max(MIN_WIDTH, Math.round(w));
      return next;
    });
  return { width, resize };
}

let collatorCache: { locale: string; collator: Intl.Collator } | null = null;

/** Sorting follows the interface language. */
function collator(): Intl.Collator {
  const locale = intlLocale();
  if (collatorCache?.locale !== locale) collatorCache = { locale, collator: new Intl.Collator(locale, { numeric: true, sensitivity: "base" }) };
  return collatorCache.collator;
}

function fileValue(f: FileDto, key: SortKey): string | number {
  switch (key) {
    case "name":
      return f.name;
    case "description":
      return f.description ?? "";
    case "version":
      return f.currentVersion;
    case "size":
      return f.latest.size;
    case "user":
      return f.latest.uploadedByName ?? "";
    case "date":
      return Date.parse(f.latest.uploadedAt) || 0;
    default:
      return f.attributes[key.slice(5)] ?? "";
  }
}

function compare(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator().compare(String(a), String(b));
}

export function sortFiles(files: FileDto[], sort: DocsSort): FileDto[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...files].sort((a, b) => {
    const va = fileValue(a, sort.key);
    const vb = fileValue(b, sort.key);
    // Empty values stay at the bottom whichever way the column is sorted.
    const empty = (v: string | number) => v === "";
    if (empty(va) !== empty(vb)) return empty(va) ? 1 : -1;
    return sign * compare(va, vb) || collator().compare(a.name, b.name);
  });
}

/** Folders only sort by name or description; for other columns they keep name order. */
export function sortFolders(folders: FolderDto[], sort: DocsSort): FolderDto[] {
  if (sort.key !== "name" && sort.key !== "description") return folders;
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...folders].sort((a, b) => {
    const va = sort.key === "name" ? a.name : (a.description ?? "");
    const vb = sort.key === "name" ? b.name : (b.description ?? "");
    if (!va !== !vb) return va ? -1 : 1;
    return sign * collator().compare(va, vb) || collator().compare(a.name, b.name);
  });
}

export function nextSort(current: DocsSort, key: SortKey): DocsSort {
  return current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
}

/** Header cell with an optional sort toggle and a drag handle on its right edge. */
export function ColumnHeader({
  label,
  title,
  sortKey,
  sort,
  onSort,
  width,
  onResize,
  className,
  dataTour,
  children,
}: {
  label: ReactNode;
  title?: string;
  sortKey?: SortKey;
  sort: DocsSort;
  onSort(key: SortKey): void;
  width: number;
  onResize(width: number | null): void;
  className?: string;
  dataTour?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const active = !!sortKey && sort.key === sortKey;
  const startResize = (e: ReactPointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const move = (ev: PointerEvent) => onResize(width + ev.clientX - startX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("col-resizing");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.classList.add("col-resizing");
  };
  return (
    <th
      className={`col-head${active ? " sorted" : ""}${className ? ` ${className}` : ""}`}
      title={title}
      data-tour={dataTour}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
    >
      {sortKey ? (
        <button type="button" className="col-sort" onClick={() => onSort(sortKey)} title={typeof label === "string" ? t("grid.sortBy", { column: label }) : t("grid.actions.sort")}>
          <span className="col-label">{label}</span>
          <span className="col-sort-icon">
            <Icon name={active ? (sort.dir === "asc" ? "sortUp" : "sortDown") : "sort"} size={14} />
          </span>
        </button>
      ) : (
        <span className="col-label">{label}</span>
      )}
      {children}
      <span
        className="col-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("grid.columnWidth")}
        title={t("grid.resizeHint")}
        onPointerDown={startResize}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={() => onResize(null)}
      />
    </th>
  );
}
