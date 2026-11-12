import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  TODAY_MINE_GROUPS,
  type ProjectTodayDto,
  type TodayRowDto,
} from "@sitekeep/shared";
import { useEmbedded } from "../../../app/context/embedded";
import { useLabel } from "../../../i18n";
import { useLoad, useProject } from "../../../app/context/project";
import { formatDay } from "../../../shared/lib/format";
import { hubApi } from "../../../shared/api/api-hub";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";

/** "Bana Düşenler" in the İşler hub (?bolum=bana): the same groups as on Bugün. */
export function MyItems({ keepSearch, refresh }: { keepSearch?: string; refresh?: number }) {
  const project = useProject();
  const embedded = useEmbedded();
  const { data, error } = useLoad(() => hubApi.today(project.id, { ai: false }), [project.id, refresh, embedded?.refreshKey]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <LoadingIndicator />;
  return (
    <div className="card today-card">
      <MineGroups data={data} keepSearch={keepSearch} />
    </div>
  );
}

export function MineGroups({ data, keepSearch }: { data: ProjectTodayDto; keepSearch?: string }) {
  const { t } = useTranslation("works");
  const label = useLabel();
  const groups = TODAY_MINE_GROUPS.filter((g) => data.mine[g].length);
  if (!groups.length) return <p className="muted">{t("today.mine.empty")}</p>;
  return (
    <>
      {groups.map((g) => (
        <div key={g} className="today-group">
          <h3>
            {label("todayMineGroup", g)} <span className="muted small">({data.mine[g].length})</span>
          </h3>
          <RowList rows={data.mine[g]} keepSearch={keepSearch} />
        </div>
      ))}
    </>
  );
}

export function RowList({ rows, empty, keepSearch }: { rows: TodayRowDto[]; empty?: string; keepSearch?: string }) {
  if (!rows.length) return empty ? <p className="muted small">{empty}</p> : null;
  return (
    <ul className="today-rows">
      {rows.map((r) => (
        <li key={`${r.kind}:${r.id}:${r.note ?? ""}`}>
          <TodayRow row={r} keepSearch={keepSearch} />
        </li>
      ))}
    </ul>
  );
}

/** One line: number, title, type, status, due date — the whole line links to the record. */
function TodayRow({ row, keepSearch }: { row: TodayRowDto; keepSearch?: string }) {
  const link = keepSearch && /\/works\/[^/?]+$/.test(row.link) ? `${row.link}${keepSearch}` : row.link;
  return (
    <Link to={link} className="today-row">
      <span className="today-row-main">
        <span className="today-row-title">{row.title}</span>
        <span className="muted small today-row-meta">
          <span className="mono">{row.number}</span> · {row.typeLabel}
          {row.note ? ` · ${row.note}` : ""}
        </span>
      </span>
      <span className="today-row-side">
        {row.statusLabel && <span className={`badge ${row.statusTone ?? ""}`}>{row.statusLabel}</span>}
        {row.dueDate && <span className={`small${row.overdue ? " error" : " muted"}`}>{formatDay(row.dueDate)}</span>}
      </span>
    </Link>
  );
}
