import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import type { WorkSummaryDto } from "@sitekeep/shared";
import { formatDate, formatDay } from "../../../shared/api/api";
import { GroupBar, GroupButton } from "../../../shared/ui/GroupToggle";
import { useGroupOpen } from "../../../shared/ui/useGroupOpen";
import { dueClass, WorkStatusBadge } from "./work-status";

interface WorkGroup {
  key: string;
  label: string;
  rows: WorkSummaryDto[];
}

export function WorksTable({
  groups,
  works,
  selectedId,
  companyNames,
  emptyText,
  onOpen,
}: {
  groups: WorkGroup[];
  works: WorkSummaryDto[] | null | undefined;
  selectedId: string | undefined;
  companyNames: Map<string, string>;
  emptyText: string;
  onOpen(id: string): void;
}) {
  const { t } = useTranslation(["works", "common"]);
  const labeled = groups.filter((g) => g.label);
  const selectedKey = labeled.find((g) => g.rows.some((w) => w.id === selectedId))?.key ?? null;
  const openGroups = useGroupOpen(labeled.map((g) => g.key), selectedKey);
  return (
    <div className="card table-scroll" style={{ padding: 0 }}>
      {labeled.length > 0 && (
        <GroupBar
          expandLabel={t("list.groups.expandAll")}
          collapseLabel={t("list.groups.collapseAll")}
          onExpand={openGroups.expandAll}
          onCollapse={openGroups.collapseAll}
        />
      )}
      <table className="works-table">
        <thead>
          <tr>
            <th style={{ width: 180 }}>{t("common:fields.number")}</th>
            <th>{t("common:fields.title")}</th>
            <th className="col-type" style={{ width: 96 }}>{t("list.columns.type")}</th>
            <th style={{ width: 104 }}>{t("common:fields.status")}</th>
            <th className="col-party" style={{ width: 150 }}>{t("list.columns.party")}</th>
            <th style={{ width: 90 }}>{t("common:fields.dueDate")}</th>
            <th className="col-date" style={{ width: 96 }}>{t("common:fields.date")}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const grouped = !!g.label;
            const open = !grouped || openGroups.isOpen(g.key);
            return (
              <Fragment key={g.key || "all"}>
                {grouped && (
                  <tr className="work-group">
                    <th colSpan={7}>
                      <GroupButton
                        open={open}
                        label={g.label}
                        count={g.rows.length}
                        expandLabel={t("list.groups.expand", { name: g.label })}
                        collapseLabel={t("list.groups.collapse", { name: g.label })}
                        onToggle={() => openGroups.toggle(g.key)}
                      />
                    </th>
                  </tr>
                )}
                {open &&
                  g.rows.map((w) => (
                    <tr key={w.id} className={`clickable${w.id === selectedId ? " selected" : ""}`} onClick={() => onOpen(w.id)}>
                      <td className="mono">{w.number}</td>
                      <td>
                        {w.title}
                        {w.replyRequired && !w.closed && (
                          <span className="badge warn" style={{ marginLeft: 6 }}>
                            {t("list.badges.replyAwaited")}
                          </span>
                        )}
                      </td>
                      <td className="muted small col-type">{w.typeName}</td>
                      <td>
                        <WorkStatusBadge w={w} />
                      </td>
                      <td className="muted small col-party">
                        {(w.fromCompanyId && companyNames.get(w.fromCompanyId)) || "—"} →{" "}
                        {w.toCompanyIds.map((c) => companyNames.get(c) ?? "?").join(", ") || "—"}
                      </td>
                      <td className={`small${dueClass(w)}`}>{w.dueDate ? formatDay(w.dueDate) : "—"}</td>
                      <td className="muted small col-date">{formatDate(w.createdAt)}</td>
                    </tr>
                  ))}
              </Fragment>
            );
          })}
          {works?.length === 0 && (
            <tr>
              <td colSpan={7} className="muted" style={{ textAlign: "center", padding: 32 }}>
                {emptyText}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
