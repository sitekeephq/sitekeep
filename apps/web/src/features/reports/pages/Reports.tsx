/**
 * "Raporlar" (docs/features/REPORTS.md). Community: a fixed list per report dataset the user may use
 * (the rows the module's own page would show them), grouped by area, with CSV export. With the
 * Platform module the dashboards (builder, templates, AI, sharing, versions) come first and the lists
 * are the second tab; the module serves its own pages (`reports/:rid`).
 *
 * Deep links: ?module=<family> (a module page's "Rapor" shortcut; with the builder ?new=ai too),
 * ?dataset=<name>, ?view=lists. Without the Platform module ?new and ?template are ignored, so the
 * builder's links never end on a dead page.
 */
import { useMemo, useState } from "react";
import { NavLink, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { REPORT_MAX_ROWS, isReportModule, type ReportDatasetDto, type ReportFieldDto, type ReportScalar } from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { formatDate, formatNumber } from "../../../shared/lib/format";
import { useLoad, useProject } from "../../../app/context/project";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";
import { webCapability } from "../../../sdk/capabilities";

/** Rows shown on the page; the CSV file has all of them (up to REPORT_MAX_ROWS). */
const SHOWN_ROWS = 500;

export function ReportsPage() {
  const { t } = useTranslation(["reports", "common"]);
  const project = useProject();
  const [search] = useSearchParams();
  const platform = webCapability("platform.reports");
  const lists = !platform || search.get("view") === "lists";
  const base = `/projects/${project.id}/reports`;
  return (
    <div className="page">
      {platform && (
        <div className="row wrap" style={{ borderBottom: "1px solid var(--border)", marginBottom: 14 }}>
          <nav className="tabs">
            <NavLink to={base} end className={() => (lists ? "" : "active")}>
              {t("lists.tabs.dashboards")}
            </NavLink>
            <NavLink to={`${base}?view=lists`} className={() => (lists ? "active" : "")}>
              {t("lists.tabs.lists")}
            </NavLink>
          </nav>
        </div>
      )}
      {lists || !platform ? <ReportLists /> : <platform.Dashboards />}
    </div>
  );
}

/** Fixed lists: one per dataset, grouped by area, CSV per list. */
export function ReportLists() {
  const { t } = useTranslation(["reports", "common"]);
  const project = useProject();
  const [search, setSearch] = useSearchParams();
  const { data: catalog, error } = useLoad(() => api.reportCatalog(project.id), [project.id]);
  const moduleParam = search.get("module");
  const area = isReportModule(moduleParam) ? moduleParam : "";
  const datasets = useMemo(() => (catalog?.datasets ?? []).filter((d) => !d.scoped && (!area || d.module === area)), [catalog, area]);
  const wanted = search.get("dataset");
  const current = datasets.find((d) => d.name === wanted) ?? datasets[0];

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) if (v) next.set(k, v);
      else next.delete(k);
    // Builder deep links have no meaning on the lists.
    next.delete("new");
    next.delete("template");
    setSearch(next, { replace: true });
  };

  return (
    <>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>{t("lists.title")}</h1>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("lists.intro")}
      </p>
      {error && <p className="error">{error}</p>}
      {!catalog && !error && <LoadingIndicator />}
      {catalog && !catalog.datasets.some((d) => !d.scoped) && <p className="muted">{t("lists.none")}</p>}
      {catalog && catalog.datasets.some((d) => !d.scoped) && (
        <>
          <div className="row wrap" style={{ marginBottom: 12 }}>
            <label className="row" style={{ gap: 6 }}>
              <span className="muted small">{t("lists.module")}</span>
              <select aria-label={t("lists.module")} value={area} onChange={(e) => set({ module: e.target.value || null, dataset: null })}>
                <option value="">{t("lists.allModules")}</option>
                {(catalog.modules ?? []).map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="row" style={{ gap: 6 }}>
              <span className="muted small">{t("lists.dataset")}</span>
              <select aria-label={t("lists.dataset")} value={current?.name ?? ""} onChange={(e) => set({ dataset: e.target.value })}>
                {datasets.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {current ? <DatasetList key={current.name} dataset={current} /> : <p className="muted">{t("lists.choose")}</p>}
        </>
      )}
      {!webCapability("platform.reports") && (
        <p className="muted small" style={{ marginTop: 24 }}>
          {t("lists.enterprise")}
        </p>
      )}
    </>
  );
}

function DatasetList({ dataset }: { dataset: ReportDatasetDto }) {
  const { t } = useTranslation(["reports", "common"]);
  const project = useProject();
  const { data, error, reload } = useLoad(
    () => api.runReportQueries(project.id, [{ id: "rows", spec: { dataset: dataset.name, limit: REPORT_MAX_ROWS } }]),
    [project.id, dataset.name],
  );
  const [busy, setBusy] = useState(false);
  const rows = data?.results.rows ?? [];
  const failure = error ?? data?.errors.rows;
  return (
    <section>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{dataset.label}</h2>
        {data && !failure && <span className="muted small">{t("lists.rows", { count: rows.length })}</span>}
        <div className="spacer" />
        <button
          className="small"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            reload();
            setTimeout(() => setBusy(false), 300);
          }}
        >
          {t("lists.actions.refresh")}
        </button>
        <a className="btn small" href={api.reportListCsvUrl(project.id, dataset.name)} download>
          {t("lists.actions.csv")}
        </a>
      </div>
      {dataset.description && <p className="muted small">{dataset.description}</p>}
      {failure && <p className="error">{failure}</p>}
      {!data && !failure && <LoadingIndicator />}
      {data && !failure && !rows.length && <p className="muted">{t("lists.empty")}</p>}
      {data && !failure && rows.length > 0 && (
        <>
          {rows.length > SHOWN_ROWS && (
            <p className="muted small">{t("lists.shown", { shown: SHOWN_ROWS, count: rows.length, max: REPORT_MAX_ROWS })}</p>
          )}
          {rows.length === REPORT_MAX_ROWS && <p className="muted small">{t("lists.capped", { max: REPORT_MAX_ROWS })}</p>}
          <div className="table-wrap" style={{ overflowX: "auto" }}>
            <table className="report-list" data-dataset={dataset.name}>
              <thead>
                <tr>
                  {dataset.fields.map((f) => (
                    <th key={f.name} title={f.description}>
                      {f.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, SHOWN_ROWS).map((r, i) => (
                  <tr key={i}>
                    {dataset.fields.map((f) => (
                      <td key={f.name}>{cellText(r[f.name], f, t)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function cellText(v: ReportScalar | undefined, f: ReportFieldDto, t: (key: "lists.yes" | "lists.no") => string): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "boolean") return v ? t("lists.yes") : t("lists.no");
  if (typeof v === "number") return formatNumber(v);
  if (f.type === "date" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.length > 10 ? formatDate(v) : v;
  return f.values?.[v] ?? v;
}
