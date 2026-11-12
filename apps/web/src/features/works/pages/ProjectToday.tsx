import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Link } from "react-router-dom";
import {
  TODAY_MINE_GROUPS,
  type ProjectTodayDto,
  type TodayChangeDayDto,
  type TodayRowDto,
  type TodaySummaryDto,
} from "@sitekeep/shared";
import { formatDay, intlLocale } from "../../../shared/api/api";
import { useLabel } from "../../../i18n";
import { hubApi } from "../../../shared/api/api-hub";
import { HUB_LABELS } from "../../../app/navigation/nav";
import { useLoad, useProject } from "../../../app/context/project";
import { NewRecordDialog } from "../components/NewRecordDialog";
import { useEmbedded } from "../../../app/context/embedded";
import { TodaySummary } from "../components/TodaySummary";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";

/**
 * Project home "Bugün": what waits for me, what is late, what is due soon and what changed in the
 * last days. The lists are fast and without AI; "Günün Özeti" on top shows the automatic summary
 * at once and the AI summary when it is ready (phase 2a).
 */
export function ProjectTodayPage() {
  const { t } = useTranslation("works");
  const { t: ts } = useTranslation("shell");
  const project = useProject();
  const { data, error, reload, setData } = useLoad(() => hubApi.today(project.id), [project.id]);
  const [creating, setCreating] = useState(false);
  const onSummary = useCallback((summary: TodaySummaryDto) => setData((d) => (d ? { ...d, summary } : d)), [setData]);

  return (
    <div className="page today-page" data-tour="today-page">
      <div className="row wrap page-head">
        <h1 style={{ margin: 0 }}>{t("today.title")}</h1>
        <span className="muted small">{new Date().toLocaleDateString(intlLocale(), { weekday: "long", day: "numeric", month: "long" })}</span>
        <div className="spacer" />
        <button className="primary" onClick={() => setCreating(true)}>
          {ts(HUB_LABELS.newRecord)}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {data && <TodaySummary projectId={project.id} summary={data.summary} onSummary={onSummary} />}
      {!data && !error && <LoadingIndicator />}
      {data && (
        <div className="today-grid" data-tour="today-grid">
          <section className="card today-card" aria-labelledby="t-mine">
            <h2 id="t-mine">
              {t("today.mine.title")} <span className={`badge${data.counts.mine ? " info" : ""}`}>{data.counts.mine}</span>
            </h2>
            <MineGroups data={data} />
          </section>
          <section className="card today-card" aria-labelledby="t-late">
            <h2 id="t-late">
              {t("today.overdue.title")} <span className={`badge${data.counts.overdue ? " danger" : ""}`}>{data.counts.overdue}</span>
            </h2>
            <RowList rows={data.overdue} empty={t("today.overdue.empty")} />
          </section>
          <section className="card today-card" aria-labelledby="t-soon">
            <h2 id="t-soon">
              {t("today.upcoming.title")} <span className={`badge${data.counts.upcoming ? " warn" : ""}`}>{data.counts.upcoming}</span>
            </h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              {t("today.upcoming.description", { count: data.upcomingDays })}
            </p>
            <RowList rows={data.upcoming} empty={t("today.upcoming.empty")} />
          </section>
          <section className="card today-card" aria-labelledby="t-changes">
            <h2 id="t-changes">{t("today.changes.title")}</h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              {t("today.changes.description", { count: data.changeDays })}
            </p>
            <Changes days={data.changes} />
          </section>
        </div>
      )}
      {creating && <NewRecordDialog onClose={() => setCreating(false)} onCreated={reload} />}
    </div>
  );
}

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

function MineGroups({ data, keepSearch }: { data: ProjectTodayDto; keepSearch?: string }) {
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

/** Rows shown before "Devamını Göster". The rest stays one click away so a full project does not stretch the page. */
const TODAY_PREVIEW = 10;

function RowList({ rows, empty, keepSearch }: { rows: TodayRowDto[]; empty?: string; keepSearch?: string }) {
  const { t } = useTranslation("works");
  const [open, setOpen] = useState(false);
  if (!rows.length) return empty ? <p className="muted small">{empty}</p> : null;
  const rest = rows.length - TODAY_PREVIEW;
  const shown = open || rest <= 0 ? rows : rows.slice(0, TODAY_PREVIEW);
  return (
    <div className="today-list">
      <ul className="today-rows">
        {shown.map((r) => (
          <li key={`${r.kind}:${r.id}:${r.note ?? ""}`}>
            <TodayRow row={r} keepSearch={keepSearch} />
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <button type="button" className="today-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span>{open ? t("today.showLess") : t("today.showMore")}</span>
          {!open && <span className="today-more-count">{rest}</span>}
          <svg className={`today-more-chevron${open ? " open" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 10 5 5 5-5" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** One line: number, title, type, status, due date — the whole line links to the record. */
function TodayRow({ row, keepSearch }: { row: TodayRowDto; keepSearch?: string }) {
  // In the hub's "Bana Düşenler" a work opens in the detail pane next to the list.
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

function dayLabel(day: string, t: TFunction<"works">): string {
  const today = new Date();
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (day === iso(today)) return t("today.days.today");
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  if (day === iso(y)) return t("today.days.yesterday");
  return new Date(`${day}T12:00:00`).toLocaleDateString(intlLocale(), { weekday: "long", day: "numeric", month: "long" });
}

function Changes({ days }: { days: TodayChangeDayDto[] }) {
  const { t } = useTranslation("works");
  if (!days.length) return <p className="muted small">{t("today.changes.empty")}</p>;
  return (
    <>
      {days.map((d) => (
        <div key={d.day} className="today-group">
          <h3>{dayLabel(d.day, t)}</h3>
          <ul className="today-changes">
            {d.changes.map((c, i) => (
              <li key={i}>
                <strong>{c.userName ?? t("today.changes.system")}</strong> {c.text}
                {c.items.length > 0 && (
                  <span className="small">
                    {": "}
                    {c.items.map((it, j) => (
                      <span key={j}>
                        {j > 0 && ", "}
                        {it.link ? <Link to={it.link}>{it.label}</Link> : it.label}
                      </span>
                    ))}
                    {c.count > c.items.length && <span className="muted"> {t("today.changes.more", { count: c.count - c.items.length })}</span>}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}
