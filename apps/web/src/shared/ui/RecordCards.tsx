import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NARROW_QUERY, PHONE_QUERY, type RecordCardData, type RecordCardGroup } from "../../features/works/record-cards";
import { GroupBar, GroupButton } from "./GroupToggle";
import { useGroupOpen } from "./useGroupOpen";

function useMediaQuery(query: string): boolean {
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** True at hamburger width (≤ 900px); follows window resizes and rotation. */
export function usePhoneWidth(): boolean {
  return useMediaQuery(PHONE_QUERY);
}

/** True when the project sidenav and document tree collapse (≤ 900px). */
export function useNarrowLayout(): boolean {
  return useMediaQuery(NARROW_QUERY);
}

function RecordCard({ r, selected, onOpen }: { r: RecordCardData; selected: boolean; onOpen(id: string): void }) {
  const { t } = useTranslation("shell");
  const meta = r.meta.filter((x): x is string => !!x);
  const chips = r.chips ?? [];
  return (
    <button type="button" className={`record-card${selected ? " selected" : ""}`} onClick={() => onOpen(r.id)} aria-current={selected || undefined}>
      <span className="record-card-top">
        <span className="mono record-card-no">{r.number}</span>
        <span className={`badge ${r.status.tone}`}>{r.status.label}</span>
      </span>
      <span className="record-card-title">{r.title}</span>
      {meta.length > 0 && <span className="record-card-meta muted small">{meta.join(" · ")}</span>}
      {(r.due || chips.length > 0) && (
        <span className="record-card-foot small">
          {r.due && <span className={`record-card-due${r.due.overdue ? " overdue" : ""}`}>{t("recordCard.due", { date: r.due.text })}</span>}
          {chips.map((c) => (
            <span key={c.label} className={`badge ${c.tone}`}>
              {c.label}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

/**
 * Phone view of a hub list: one card per record, under the same group headers as the table. A tap
 * opens the record exactly like a table row (`onOpen`).
 */
export function RecordCards({
  groups,
  selectedId,
  onOpen,
  emptyText,
  label,
}: {
  groups: RecordCardGroup[];
  selectedId?: string | null;
  onOpen(id: string): void;
  /** Shown when there is no row at all (null: nothing, e.g. while loading). */
  emptyText?: string | null;
  /** Accessible name of the list, e.g. "İşler". */
  label: string;
}) {
  const { t } = useTranslation("works");
  const count = groups.reduce((n, g) => n + g.rows.length, 0);
  const labeled = groups.filter((g) => g.label);
  const selectedKey = labeled.find((g) => selectedId && g.rows.some((r) => r.id === selectedId))?.key ?? null;
  const openGroups = useGroupOpen(labeled.map((g) => g.key), selectedKey);
  if (!count) return emptyText ? <div className="card muted record-cards-empty">{emptyText}</div> : null;
  return (
    <div className="record-cards-wrap">
      {labeled.length > 0 && (
        <GroupBar
          expandLabel={t("list.groups.expandAll")}
          collapseLabel={t("list.groups.collapseAll")}
          onExpand={openGroups.expandAll}
          onCollapse={openGroups.collapseAll}
        />
      )}
      <ul className="record-cards" aria-label={label}>
        {groups.flatMap((g) => {
          const grouped = !!g.label;
          const open = !grouped || openGroups.isOpen(g.key);
          return [
            ...(grouped
              ? [
                  <li key={`g:${g.key}`} className="record-cards-group">
                    <GroupButton
                      open={open}
                      label={g.label}
                      count={g.rows.length}
                      expandLabel={t("list.groups.expand", { name: g.label })}
                      collapseLabel={t("list.groups.collapse", { name: g.label })}
                      onToggle={() => openGroups.toggle(g.key)}
                    />
                  </li>,
                ]
              : []),
            ...(open
              ? g.rows.map((r) => (
                  <li key={r.id}>
                    <RecordCard r={r} selected={r.id === selectedId} onOpen={onOpen} />
                  </li>
                ))
              : []),
          ];
        })}
      </ul>
    </div>
  );
}
