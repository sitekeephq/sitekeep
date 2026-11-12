import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  REPORT_SHARING,
  reportHtmlWarnings,
  reportQueryDatasets,
  reportValueLabels,
  type DashboardDto,
  type ReportCatalogDto,
  type ReportDataResult,
  type ReportDraft,
  type ReportQueryRef,
  type ReportSharing,
} from "@sitekeep/shared";
import { api, formatDate, intlLocale } from "../../../shared/api/api";
import { useAsk } from "../../../shared/ui/Ask";
import { Dialog } from "../../../shared/ui/Dialog";
import { ReportFrame, type ReportFrameHandle } from "../components/ReportFrame";
import { useLoad, useProject } from "../../../app/context/project";
import { AiTaskButton } from "../../../shared/ai/AiTaskButton";
import { PromptBox } from "./Reports";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";
import { useLabel } from "../../../i18n";

interface Working extends ReportDraft {
  sharing: ReportSharing;
}

/** How often an open dashboard asks whether its data changed (a cheap stamp read). */
export const LIVE_POLL_MS = 25_000;

const hhmm = (d: Date) => d.toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit" });

export function ReportViewPage() {
  const { t, i18n } = useTranslation(["reports", "common"]);
  const label = useLabel();
  const { confirm } = useAsk();
  const project = useProject();
  const { rid } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const { data: dash, error, setData: setDash } = useLoad(() => api.report(project.id, rid!), [project.id, rid]);
  const { data: catalog, error: catalogError } = useLoad(() => api.reportCatalog(project.id), [project.id]);
  const [data, setData] = useState<ReportDataResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [working, setWorking] = useState<Working | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [refreshed, setRefreshed] = useState(false);
  const frame = useRef<ReportFrameHandle>(null);
  const editing = search.get("edit") === "1" && !!dash?.canEdit;
  const dataRef = useRef<ReportDataResult | null>(null);
  dataRef.current = data;
  const busy = useRef(false);
  const flashTimer = useRef<number>(0);

  /**
   * Loads the dashboard's data. "auto" is a live refresh: no spinner, errors are ignored (the next
   * poll retries), and a short "Yenilendi" shows. The frame gets the new rows by postMessage.
   */
  async function refresh(mode: "manual" | "auto" = "manual") {
    if (busy.current) return;
    busy.current = true;
    if (mode === "manual") {
      setLoading(true);
      setMsg(null);
    }
    try {
      const r = await api.reportData(project.id, rid!);
      setData(r);
      setLoadedAt(new Date());
      if (mode === "auto") {
        setRefreshed(true);
        window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setRefreshed(false), 4000);
      }
    } catch (e) {
      if (mode === "manual") setMsg((e as Error).message);
    } finally {
      busy.current = false;
      if (mode === "manual") setLoading(false);
    }
  }

  useEffect(() => {
    setData(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, rid]);

  // Live refresh: poll the change stamp while the tab is visible (paused while hidden and while
  // editing), check at once when the window gets focus, re-run the queries only when it changed.
  useEffect(() => {
    if (editing) return;
    let stopped = false;
    const check = async () => {
      if (stopped || document.hidden || busy.current || !dataRef.current) return;
      try {
        const s = await api.reportStamp(project.id, rid!);
        if (!stopped && s.stamp !== dataRef.current?.stamp) await refresh("auto");
      } catch {
        /* offline or the dashboard was deleted: the next poll tries again */
      }
    };
    const timer = window.setInterval(() => void check(), LIVE_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void check();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, rid, editing]);

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  useEffect(() => {
    if (editing && dash && !working)
      setWorking({ name: dash.name, description: dash.description, queries: dash.queries, html: dash.html, sharing: dash.sharing });
    if (!editing) setWorking(null);
  }, [editing, dash, working]);

  const shownQueries = (working ?? dash)?.queries;
  const labels = useMemo(
    () =>
      catalog && shownQueries
        ? reportValueLabels([...catalog.datasets, ...(catalog.labelDatasets ?? [])], reportQueryDatasets(shownQueries))
        : undefined,
    [catalog, shownQueries],
  );

  if (error) return <div className="page error">{error}</div>;
  if (!dash) return <LoadingIndicator className="page" />;

  const setEdit = (on: boolean) => {
    const next = new URLSearchParams(search);
    if (on) next.set("edit", "1");
    else next.delete("edit");
    setSearch(next, { replace: true });
  };

  const shown = working ?? dash;
  const warnings = !dash.isMine || working ? reportHtmlWarnings(shown.html, i18n.language) : [];

  return (
    <div className={`split${editing ? " with-detail" : ""}`}>
      <div className="page" style={{ maxWidth: "none", width: "100%", overflow: "auto" }}>
        <div className="row wrap no-print" style={{ marginBottom: 12 }}>
          <Link to={`/projects/${project.id}/reports`} className="muted">
            {t("view.actions.back")}
          </Link>
          <h1 style={{ margin: 0 }}>{shown.name}</h1>
          <span className={`badge${shown.sharing === "private" ? "" : " info"}`}>{label("reportSharing", shown.sharing)}</span>
          <span className="muted small">
            v{dash.version} · {dash.ownerName} · {formatDate(dash.updatedAt)}
          </span>
          <div className="spacer" />
          {loadedAt && (
            <span className="muted small live-stamp" title={t("view.liveHint")}>
              {t("view.lastUpdated", { time: hhmm(loadedAt) })}
              {refreshed && <span className="badge ok live-flash">{t("view.status.refreshed")}</span>}
            </span>
          )}
          <button onClick={() => void refresh()} disabled={loading}>
            ⟳ {t("common:actions.refresh")}
          </button>
          <button
            onClick={() => frame.current?.print()}
            disabled={!data}
            title={t("view.snapshotHint")}
          >
            {t("view.actions.snapshot")}
          </button>
          <button onClick={() => setShowVersions(true)}>{t("view.actions.versions")}</button>
          {dash.canEdit && !editing && <button onClick={() => setEdit(true)}>{t("common:actions.edit")}</button>}
          {dash.canEdit && !editing && (
            <button
              className="danger"
              onClick={async () => {
                if (
                  !(await confirm({
                    title: t("view.delete.title"),
                    message: t("view.delete.confirm", { name: dash.name }),
                    confirmLabel: t("common:actions.delete"),
                    danger: true,
                  }))
                )
                  return;
                try {
                  await api.deleteReport(project.id, dash.id);
                  navigate(`/projects/${project.id}/reports`);
                } catch (e) {
                  setMsg((e as Error).message);
                }
              }}
            >
              {t("common:actions.delete")}
            </button>
          )}
        </div>
        {shown.description && <p className="muted" style={{ marginTop: 0 }}>{shown.description}</p>}
        {msg && <p className="error">{msg}</p>}
        {data && Object.keys(data.errors).length > 0 && (
          <BrokenQueries
            dash={dash}
            data={data}
            catalog={catalog ?? null}
            editing={!!working}
            onRepaired={(d) => {
              setDash(d);
              void refresh();
            }}
          />
        )}
        {warnings.length > 0 && (
          <div className="notice small">
            {warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        )}
        {frameError && <p className="error small">{frameError}</p>}
        <div className="report-stage">
          {data && (catalog || catalogError) ? (
            <ReportFrame
              ref={frame}
              html={shown.html}
              data={data.results}
              errors={data.errors}
              generatedAt={data.generatedAt}
              project={project}
              labels={labels}
              onError={setFrameError}
            />
          ) : (
            <p className="muted">{t("view.loadingData")}</p>
          )}
        </div>
        {data && (
          <p className="muted small">
            {t("view.dataTime", { time: formatDate(data.generatedAt) })}
          </p>
        )}
      </div>

      {editing && working && (
        <EditPanel
          dash={dash}
          working={working}
          aiAvailable={!!catalog?.aiAvailable}
          onChange={(w, preview) => {
            setWorking(w);
            setFrameError(null);
            if (preview) setData(preview);
          }}
          onSaved={(d) => {
            setDash(d);
            setWorking(null);
            setEdit(false);
            void refresh();
          }}
          onCancel={() => {
            setWorking(null);
            setEdit(false);
            void refresh();
          }}
        />
      )}
      {showVersions && (
        <VersionsDialog
          dash={dash}
          onClose={() => setShowVersions(false)}
          onRestored={(d) => {
            setDash(d);
            setWorking(null);
            setShowVersions(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * Queries that did not run, with a Turkish reason. A query whose field was renamed or removed can
 * be fixed by the AI ("Yapay zekâ ile onar"): only that query, its error and the dataset's fields
 * are sent; the fix is shown and saved as a new version after confirmation.
 */
function BrokenQueries({
  dash,
  data,
  catalog,
  editing,
  onRepaired,
}: {
  dash: DashboardDto;
  data: ReportDataResult;
  catalog: ReportCatalogDto | null;
  editing: boolean;
  onRepaired(d: DashboardDto): void;
}) {
  const { t } = useTranslation(["reports", "common"]);
  const project = useProject();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{ queryId: string; spec: ReportQueryRef["spec"]; note: string } | null>(null);
  const kinds = data.errorKinds ?? {};
  const canRepair = dash.canEdit && !!catalog?.aiAvailable && !editing;

  async function repair(queryId: string) {
    setBusy(queryId);
    setMsg(null);
    try {
      setProposal(await api.repairReportQuery(project.id, dash.id, queryId));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!proposal) return;
    setBusy(proposal.queryId);
    setMsg(null);
    try {
      const queries = dash.queries.map((q) => (q.id === proposal.queryId ? { id: q.id, spec: proposal.spec } : q));
      const d = await api.updateReport(project.id, dash.id, { queries, baseVersion: dash.version });
      setProposal(null);
      onRepaired(d);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="notice small broken-queries">
      {Object.entries(data.errors).map(([id, m]) => (
        <div key={id} className="row wrap" style={{ gap: 8, alignItems: "baseline" }}>
          <span style={{ flex: 1, minWidth: 240 }}>
            <strong>{id}:</strong> {m}
          </span>
          {kinds[id] === "invalid" && canRepair && (
            <button className="small" onClick={() => void repair(id)} disabled={!!busy}>
              {busy === id ? t("broken.messages.aiWorking") : t("broken.actions.aiRepair")}
            </button>
          )}
          {kinds[id] === "invalid" && dash.canEdit && !editing && (
            <AiTaskButton
              projectId={project.id}
              kind="report_repair"
              input={{ dashboardId: dash.id, queryId: id }}
              small
              disabled={!!busy}
              onResult={(r) => setProposal(r as { queryId: string; spec: ReportQueryRef["spec"]; note: string })}
            />
          )}
          {kinds[id] === "invalid" && dash.canEdit && !catalog?.aiAvailable && (
            <span className="muted">{t("broken.manualFix")}</span>
          )}
        </div>
      ))}
      {msg && <p className="error">{msg}</p>}
      {proposal && (
        <Dialog title={t("broken.proposal.title")} onClose={() => setProposal(null)}>
          {proposal.note && <p>{proposal.note}</p>}
          <label>{t("broken.proposal.fields.newQuery", { id: proposal.queryId })}</label>
          <pre className="mono small" style={{ whiteSpace: "pre-wrap", maxHeight: 280, overflow: "auto" }}>
            {JSON.stringify(proposal.spec, null, 2)}
          </pre>
          <p className="muted small">{t("broken.proposal.hint")}</p>
          <div className="dialog-actions">
            <button onClick={() => setProposal(null)} disabled={!!busy}>
              {t("common:actions.cancel")}
            </button>
            <button className="primary" onClick={() => void apply()} disabled={!!busy}>
              {t("broken.proposal.actions.applyAndSave")}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function EditPanel({
  dash,
  working,
  aiAvailable,
  onChange,
  onSaved,
  onCancel,
}: {
  dash: DashboardDto;
  working: Working;
  aiAvailable: boolean;
  onChange(w: Working, preview?: ReportDataResult): void;
  onSaved(d: DashboardDto): void;
  onCancel(): void;
}) {
  const { t } = useTranslation(["reports", "common"]);
  const label = useLabel();
  const project = useProject();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [html, setHtml] = useState(working.html);
  const [queriesText, setQueriesText] = useState(JSON.stringify(working.queries, null, 2));

  // Keep the advanced editors in sync when the AI changes the draft.
  useEffect(() => {
    setHtml(working.html);
    setQueriesText(JSON.stringify(working.queries, null, 2));
  }, [working.html, working.queries]);

  async function aiEdit(prompt: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.generateReport(project.id, {
        prompt,
        current: { name: working.name, description: working.description, queries: working.queries, html: working.html },
      });
      onChange({ ...working, ...r.draft }, r);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function parseQueries(): ReportQueryRef[] | null {
    try {
      const q = JSON.parse(queriesText) as unknown;
      if (!Array.isArray(q)) throw new Error(t("edit.errors.queriesNotArray"));
      return q as ReportQueryRef[];
    } catch (e) {
      setMsg(t("edit.errors.queries", { message: (e as Error).message }));
      return null;
    }
  }

  async function preview() {
    setMsg(null);
    const queries = parseQueries();
    if (!queries) return;
    setBusy(true);
    try {
      const r = await api.runReportQueries(project.id, queries);
      onChange({ ...working, html, queries }, r);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setMsg(null);
    const queries = parseQueries();
    if (!queries) return;
    setBusy(true);
    try {
      const d = await api.updateReport(project.id, dash.id, {
        name: working.name,
        description: working.description || null,
        html,
        queries,
        sharing: dash.isMine ? working.sharing : undefined,
        baseVersion: dash.version,
      });
      onSaved(d);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="panel right">
      <h2>{t("edit.title")}</h2>
      {aiAvailable ? (
        <>
          <label>{t("edit.promptHint")}</label>
          <PromptBox
            busy={busy}
            examples={[t("aiCreate.examples.monthly"), t("edit.examples.showHill"), t("edit.examples.addSummary")]}
            placeholder={t("edit.placeholder")}
            submitLabel={t("common:actions.apply")}
            onSubmit={(p) => void aiEdit(p)}
          />
        </>
      ) : (
        <p className="notice small">{t("edit.noAi")}</p>
      )}

      <label>{t("common:fields.name")}</label>
      <input value={working.name} onChange={(e) => onChange({ ...working, name: e.target.value })} />
      <label>{t("common:fields.description")}</label>
      <input value={working.description ?? ""} onChange={(e) => onChange({ ...working, description: e.target.value })} />
      <label>{t("edit.fields.sharing")}</label>
      <select
        value={working.sharing}
        disabled={!dash.isMine}
        onChange={(e) => onChange({ ...working, sharing: e.target.value as ReportSharing })}
      >
        {REPORT_SHARING.map((s) => (
          <option key={s} value={s}>
            {label("reportSharing", s)}
          </option>
        ))}
      </select>
      {!dash.isMine && <p className="muted small">{t("edit.ownerOnly")}</p>}

      <details style={{ marginTop: 16 }}>
        <summary>{t("edit.advanced.title")}</summary>
        <label>{t("edit.fields.html")}</label>
        <textarea className="mono code-editor" spellCheck={false} value={html} onChange={(e) => setHtml(e.target.value)} />
        <label>{t("edit.fields.queries")}</label>
        <textarea
          className="mono code-editor"
          spellCheck={false}
          value={queriesText}
          onChange={(e) => setQueriesText(e.target.value)}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={() => void preview()} disabled={busy}>
            {t("edit.actions.preview")}
          </button>
        </div>
      </details>

      {msg && <p className="error">{msg}</p>}
      <div className="dialog-actions">
        <button onClick={onCancel} disabled={busy}>
          {t("common:actions.cancel")}
        </button>
        <button className="primary" onClick={() => void save()} disabled={busy}>
          {t("common:actions.save")}
        </button>
      </div>
    </aside>
  );
}

function VersionsDialog({ dash, onClose, onRestored }: { dash: DashboardDto; onClose(): void; onRestored(d: DashboardDto): void }) {
  const { t } = useTranslation(["reports", "common"]);
  const project = useProject();
  const { data: versions, error } = useLoad(() => api.reportVersions(project.id, dash.id), [project.id, dash.id, dash.version]);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Dialog title={t("versions.title")} onClose={onClose}>
      {error && <p className="error">{error}</p>}
      {msg && <p className="error">{msg}</p>}
      <table>
        <thead>
          <tr>
            <th style={{ width: 50 }}>{t("versions.columns.version")}</th>
            <th>{t("versions.columns.name")}</th>
            <th>{t("versions.columns.savedBy")}</th>
            <th>{t("versions.columns.date")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {versions?.map((v) => (
            <tr key={v.version}>
              <td>v{v.version}</td>
              <td>{v.name}</td>
              <td className="muted">{v.createdByName ?? "—"}</td>
              <td className="muted small">{formatDate(v.createdAt)}</td>
              <td style={{ textAlign: "right" }}>
                {v.version === dash.version ? (
                  <span className="badge ok">{t("versions.status.current")}</span>
                ) : (
                  dash.canEdit && (
                    <button
                      className="small"
                      onClick={async () => {
                        try {
                          onRestored(await api.restoreReportVersion(project.id, dash.id, v.version));
                        } catch (e) {
                          setMsg((e as Error).message);
                        }
                      }}
                    >
                      {t("versions.actions.restore")}
                    </button>
                  )
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}
