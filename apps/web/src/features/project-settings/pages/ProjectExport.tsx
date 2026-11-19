/**
 * Proje Ayarları → Dışa Aktarma (docs/features/PROJECT_EXPORT.md): builds the full project export
 * (every file and version, issues as BCF 3.0, reviews, transmittals, members, permissions, the audit
 * log, manifest and checksums) in the job queue, shows its progress and offers the ZIP for download
 * until it expires. A project administrator's export holds what they can see; a system
 * administrator's holds everything.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectExportDto, ProjectExportStateDto } from "@sitekeep/shared";
import { formatDate, formatSize } from "../../../shared/api/api";
import { portabilityApi } from "../../../shared/api/api-portability";
import { useProject } from "../../../app/context/project";
import { useAsk } from "../../../shared/ui/Ask";

const POLL_MS = 2000;

export function ProjectExport() {
  const { t } = useTranslation("projectSettings");
  const project = useProject();
  const { confirm } = useAsk();
  const [state, setState] = useState<ProjectExportStateDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setState(await portabilityApi.state(project.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // Progress: poll while an export is being built.
  const active = state?.exports.find((x) => x.status === "queued" || x.status === "running");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      portabilityApi.get(project.id, active.id).then(
        (x) => {
          if (x.status === "queued" || x.status === "running") setState((s) => (s ? { ...s, exports: s.exports.map((y) => (y.id === x.id ? x : y)) } : s));
          else void load();
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, project.id]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(x: ProjectExportDto) {
    if (!(await confirm({ title: t("export.remove.title"), message: t("export.remove.confirm"), confirmLabel: t("export.remove.action"), danger: true }))) return;
    await run(() => portabilityApi.remove(project.id, x.id));
  }

  if (!state) return error ? <p className="error">{error}</p> : null;
  const est = state.estimate;

  return (
    <div className="stack" data-testid="project-export">
      <div className="card stack">
        <h3 style={{ margin: 0 }}>{t("export.heading")}</h3>
        <p className="muted small" style={{ margin: 0 }}>
          {t("export.description", { days: state.limits.retentionDays })}
        </p>
        <p className="small" style={{ margin: 0 }} data-testid="project-export-scope" data-scope={state.scope}>
          {state.scope === "full" ? t("export.scope.full") : t("export.scope.visible")}
        </p>
        <p className="small" style={{ margin: 0 }} data-testid="project-export-estimate">
          {t("export.estimate", { files: est.files, versions: est.versions, size: formatSize(est.bytes) })}
          {state.limits.maxBytes !== null && ` ${t("export.limit", { size: formatSize(state.limits.maxBytes) })}`}
        </p>
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="primary" disabled={busy || !!active} onClick={() => void run(() => portabilityApi.create(project.id))}>
            {t("export.create")}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
      {state.exports.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-scroll">
            <table className="phone-cards">
              <thead>
                <tr>
                  <th style={{ width: 150 }}>{t("export.columns.created")}</th>
                  <th>{t("export.columns.contents")}</th>
                  <th style={{ width: 220 }}>{t("export.columns.status")}</th>
                  <th style={{ width: 200 }}>{t("export.columns.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {state.exports.map((x) => (
                  <tr key={x.id} data-testid="project-export-row" data-status={x.status}>
                    <td className="muted small" data-label={t("export.columns.created")}>
                      {formatDate(x.createdAt)}
                      <br />
                      {x.requestedBy.name ?? "—"}
                    </td>
                    <td className="small" data-label={t("export.columns.contents")}>
                      {x.scope === "full" ? t("export.scope.fullShort") : t("export.scope.visibleShort")}
                      <br />
                      <span className="muted">
                        {x.counts
                          ? t("export.counts", { files: x.counts.files, versions: x.counts.versions, topics: x.counts.issues, size: formatSize(x.counts.bytes) })
                          : t("export.countsPending", { versions: x.filesTotal, size: formatSize(x.bytesTotal) })}
                      </span>
                      {x.sha256 && (
                        <>
                          <br />
                          <span className="muted mono" title={x.sha256}>
                            ZIP {formatSize(x.size ?? 0)} · SHA-256 {x.sha256.slice(0, 16)}…
                          </span>
                        </>
                      )}
                    </td>
                    <td data-label={t("export.columns.status")}>
                      <Status x={x} />
                    </td>
                    <td data-label={t("export.columns.actions")}>
                      <div className="row wrap" style={{ gap: 6 }}>
                        {x.status === "done" && (state.scope === "full" || x.scope !== "full") && (
                          <a className="btn" href={portabilityApi.downloadUrl(project.id, x.id)} download data-testid="project-export-download">
                            {t("export.download")}
                          </a>
                        )}
                        {(x.status === "done" || x.status === "failed") && (state.scope === "full" || x.scope !== "full") && (
                          <button className="link-button" disabled={busy} onClick={() => void remove(x)}>
                            {t("export.remove.action")}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Status({ x }: { x: ProjectExportDto }) {
  const { t } = useTranslation("projectSettings");
  if (x.status === "queued") return <span className="badge">{t("export.status.queued")}</span>;
  if (x.status === "running") {
    const pct = x.bytesTotal ? Math.min(100, Math.round((x.bytesDone / x.bytesTotal) * 100)) : 0;
    return (
      <div className="stack" style={{ gap: 4 }}>
        <span className="badge">{t("export.status.running", { done: x.filesDone, total: x.filesTotal })}</span>
        <progress max={100} value={pct} aria-label={t("export.status.progress")} />
      </div>
    );
  }
  if (x.status === "failed")
    return (
      <span className="badge danger" title={x.error ?? undefined}>
        {t("export.status.failed")}
        {x.error ? `: ${x.error}` : ""}
      </span>
    );
  if (x.status === "expired") return <span className="badge muted">{t("export.status.expired")}</span>;
  const problems = x.counts?.problems ?? 0;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <span className={`badge ${problems ? "danger" : "ok"}`}>{problems ? t("export.status.problems", { count: problems }) : t("export.status.done")}</span>
      {x.expiresAt && <span className="muted small">{t("export.expires", { date: formatDate(x.expiresAt) })}</span>}
    </div>
  );
}
