import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { TodayWorkDto } from "@sitekeep/shared";
import { useLabel } from "../../../i18n";
import { intlLocale } from "../../../shared/lib/format";
import { worksApi } from "../../../shared/api/api-works";
import { useLoad } from "../../../app/context/project";
import { WorkStatusBadge, dueClass } from "../components/work-status";

/** "Bugün": my review steps and open works across projects, grouped. */
export function TodayPage() {
  const { t } = useTranslation(["works", "common"]);
  const label = useLabel();
  const navigate = useNavigate();
  const { data, error } = useLoad(() => worksApi.today(), []);
  const groups: [keyof Omit<NonNullable<typeof data>, "tasks" | "counts" | "newVersions">, string, string][] = [
    ["overdue", t("myTasks.groups.overdue"), "danger"],
    ["dueSoon", t("myTasks.groups.dueSoon"), "warn"],
    ["awaitingReply", t("myTasks.groups.awaitingReply"), "warn"],
    ["toReceive", t("myTasks.groups.toReceive"), "info"],
    ["assigned", t("myTasks.groups.assigned"), "info"],
  ];
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{t("myTasks.title")}</h1>
          <p>{t("myTasks.description")}</p>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      {data && (
        <div className="metric-grid">
          <div className={`metric${data.counts.tasks ? " info" : ""}`}>
            <span>{t("myTasks.metrics.tasks")}</span>
            <strong>{data.counts.tasks}</strong>
          </div>
          {groups.map(([k, label, tone]) => (
            <div key={k} className={`metric${data.counts[k] ? ` ${tone}` : ""}`}>
              <span>{label}</span>
              <strong>{data.counts[k]}</strong>
            </div>
          ))}
        </div>
      )}
      <div className="stack">
        <section className="card" style={{ padding: 0 }}>
          <h2 style={{ padding: "12px 12px 0" }}>{t("myTasks.tasks.title")}</h2>
          <table className="phone-cards">
            <thead>
              <tr>
                <th style={{ width: 100 }}>{t("common:fields.project")}</th>
                <th style={{ width: 130 }}>{t("common:fields.type")}</th>
                <th>{t("myTasks.columns.record")}</th>
                <th style={{ width: 220 }}>{t("myTasks.columns.step")}</th>
                <th style={{ width: 110 }}>{t("common:fields.dueDate")}</th>
              </tr>
            </thead>
            <tbody>
              {data?.tasks.map((task) => (
                <tr key={`${task.subjectId}:${task.stepIndex}`} className="clickable" onClick={() => navigate(task.link)}>
                  <td>
                    <span className="badge info" title={task.projectName}>
                      {task.projectCode}
                    </span>
                  </td>
                  <td className="muted">{label("workflowKind", task.kind)}</td>
                  <td>
                    {task.code ?? `#${task.number}`} {task.name}
                  </td>
                  <td>
                    {task.stepIndex + 1}. {task.stepName}
                  </td>
                  <td>
                    {task.stepDueAt ? (
                      <span className={`badge ${task.overdue ? "danger" : ""}`}>{new Date(task.stepDueAt).toLocaleDateString(intlLocale())}</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {data?.tasks.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted" style={{ textAlign: "center", padding: 20 }}>
                    {t("myTasks.tasks.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
        {data &&
          groups
            .filter(([k]) => data[k].length)
            .map(([k, label]) => <WorkGroup key={k} title={label} items={data[k]} />)}
        {data && !data.counts.total && <p className="muted">{t("myTasks.empty")}</p>}
        <p className="muted small">{t("myTasks.followedNote")}</p>
      </div>
    </div>
  );
}

function WorkGroup({ title, items }: { title: string; items: TodayWorkDto[] }) {
  const navigate = useNavigate();
  return (
    <section className="card" style={{ padding: 0 }}>
      <h2 style={{ padding: "12px 12px 0" }}>
        {title} <span className="badge">{items.length}</span>
      </h2>
      <table className="phone-cards">
        <tbody>
          {items.map((w) => (
            <tr key={w.id} className="clickable" onClick={() => navigate(w.link)}>
              <td style={{ width: 100 }}>
                <span className="badge info" title={w.projectName}>
                  {w.projectCode}
                </span>
              </td>
              <td style={{ width: 120 }} className="muted small">
                {w.typeName}
              </td>
              <td className="mono" style={{ width: 230 }}>
                {w.number}
              </td>
              <td>{w.title}</td>
              <td style={{ width: 110 }}>
                <WorkStatusBadge w={w} />
              </td>
              <td style={{ width: 100 }} className={`small${dueClass(w)}`}>
                {w.dueDate ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
