/**
 * Proje Ayarları → Kapanış Arşivi (docs/features/CLOSEOUT_ARCHIVE.md, ISO 19650-2 §5.8.1): builds the
 * close-out archive of the Published and Archived information in the job queue, shows its progress,
 * offers the ZIP for download until it expires, and closes the project (read-only) afterwards.
 * Reopening a closed project is for system administrators.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CloseoutArchiveDto, CloseoutOptions, CloseoutStateDto } from "@sitekeep/shared";
import { formatDate, formatSize } from "../../../shared/api/api";
import { closeoutApi } from "../../../shared/api/api-closeout";
import { useAuth } from "../../../app/context/auth";
import { useProject } from "../../../app/context/project";
import { useAsk } from "../../../shared/ui/Ask";

const POLL_MS = 2000;

export function CloseoutArchive() {
  const { t } = useTranslation("projectSettings");
  const project = useProject();
  const { user } = useAuth();
  const { confirm, prompt } = useAsk();
  const [state, setState] = useState<CloseoutStateDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<CloseoutOptions>({ includeShared: false, versions: "latest", closeProject: false });

  async function load() {
    try {
      setState(await closeoutApi.state(project.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // Progress: poll while an archive is being built.
  const active = state?.archives.find((a) => a.status === "queued" || a.status === "running");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      closeoutApi.archive(project.id, active.id).then(
        (a) => {
          if (a.status === "queued" || a.status === "running") setState((s) => (s ? { ...s, archives: s.archives.map((x) => (x.id === a.id ? a : x)) } : s));
          else {
            void load();
            // The project may have been closed with it.
            window.dispatchEvent(new Event("cde:project-changed"));
          }
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
      window.dispatchEvent(new Event("cde:project-changed"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const create = () => run(() => closeoutApi.create(project.id, options));
  async function close() {
    if (!(await confirm({ title: t("closeout.close.title"), message: t("closeout.close.confirm"), confirmLabel: t("closeout.close.action"), danger: true }))) return;
    await run(() => closeoutApi.close(project.id));
  }
  async function reopen() {
    const reason = await prompt({ title: t("closeout.reopen.title"), message: t("closeout.reopen.reason"), confirmLabel: t("closeout.reopen.action") });
    if (reason === null) return;
    await run(() => closeoutApi.reopen(project.id, reason.trim() || undefined));
  }
  async function remove(a: CloseoutArchiveDto) {
    if (!(await confirm({ title: t("closeout.remove.title"), message: t("closeout.remove.confirm"), confirmLabel: t("closeout.remove.action"), danger: true }))) return;
    await run(() => closeoutApi.remove(project.id, a.id));
  }

  if (!state) return error ? <p className="error">{error}</p> : null;
  const est = options.includeShared ? (options.versions === "all" ? state.estimate.sharedAll : state.estimate.sharedLatest) : options.versions === "all" ? state.estimate.all : state.estimate.latest;
  const complete = state.archives.some((a) => (a.status === "done" || a.status === "expired") && a.problems === 0);

  return (
    <div className="stack" data-testid="closeout">
      {state.closed && (
        <div className="notice row wrap" data-testid="closeout-closed" style={{ gap: 8, alignItems: "center" }}>
          <span>
            {t("closeout.closedSince", { date: formatDate(state.closedAt!), name: state.closedBy?.name ?? "—" })}
          </span>
          <div className="spacer" />
          {user?.isAdmin && (
            <button disabled={busy} onClick={() => void reopen()}>
              {t("closeout.reopen.action")}
            </button>
          )}
        </div>
      )}
      <div className="card stack">
        <h3 style={{ margin: 0 }}>{t("closeout.heading")}</h3>
        <p className="muted small" style={{ margin: 0 }}>
          {t("closeout.description", { days: state.limits.retentionDays })}
        </p>
        <label className="check">
          <input type="checkbox" checked={options.includeShared} onChange={(e) => setOptions({ ...options, includeShared: e.target.checked })} /> {t("closeout.options.includeShared")}
        </label>
        <div className="row wrap" style={{ gap: 12 }} role="radiogroup" aria-label={t("closeout.options.versions")}>
          <label className="check">
            <input type="radio" name="closeout-versions" checked={options.versions === "latest"} onChange={() => setOptions({ ...options, versions: "latest" })} /> {t("closeout.options.latest")}
          </label>
          <label className="check">
            <input type="radio" name="closeout-versions" checked={options.versions === "all"} onChange={() => setOptions({ ...options, versions: "all" })} /> {t("closeout.options.all")}
          </label>
        </div>
        {!state.closed && (
          <label className="check">
            <input type="checkbox" checked={options.closeProject} onChange={(e) => setOptions({ ...options, closeProject: e.target.checked })} /> {t("closeout.options.closeProject")}
          </label>
        )}
        <p className="small" style={{ margin: 0 }} data-testid="closeout-estimate">
          {t("closeout.estimate", { files: est.files, versions: est.versions, size: formatSize(est.bytes) })}
          {state.limits.maxBytes !== null && ` ${t("closeout.limit", { size: formatSize(state.limits.maxBytes) })}`}
        </p>
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="primary" disabled={busy || !!active || !est.versions} onClick={() => void create()}>
            {t("closeout.create")}
          </button>
          {!state.closed && complete && (
            <button disabled={busy} onClick={() => void close()}>
              {t("closeout.close.action")}
            </button>
          )}
        </div>
        {error && <p className="error">{error}</p>}
      </div>
      {state.archives.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-scroll">
            <table className="phone-cards">
              <thead>
                <tr>
                  <th style={{ width: 150 }}>{t("closeout.columns.created")}</th>
                  <th>{t("closeout.columns.contents")}</th>
                  <th style={{ width: 220 }}>{t("closeout.columns.status")}</th>
                  <th style={{ width: 200 }}>{t("closeout.columns.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {state.archives.map((a) => (
                  <tr key={a.id} data-testid="closeout-archive" data-status={a.status}>
                    <td className="muted small" data-label={t("closeout.columns.created")}>
                      {formatDate(a.createdAt)}
                      <br />
                      {a.requestedBy.name ?? "—"}
                    </td>
                    <td className="small" data-label={t("closeout.columns.contents")}>
                      {a.options.includeShared ? t("closeout.scopeWithShared") : t("closeout.scope")} ·{" "}
                      {a.options.versions === "all" ? t("closeout.options.all") : t("closeout.options.latest")}
                      <br />
                      <span className="muted">{t("closeout.counts", { files: a.filesTotal, size: formatSize(a.bytesTotal) })}</span>
                      {a.sha256 && (
                        <>
                          <br />
                          <span className="muted mono" title={a.sha256}>
                            ZIP {formatSize(a.size ?? 0)} · SHA-256 {a.sha256.slice(0, 16)}…
                          </span>
                        </>
                      )}
                      {a.auditChain?.head && (
                        <>
                          <br />
                          <span className="muted mono" title={a.auditChain.head.hash}>
                            {t("closeout.auditHead", { id: a.auditChain.head.id, hash: a.auditChain.head.hash.slice(0, 16) })}
                          </span>
                        </>
                      )}
                    </td>
                    <td data-label={t("closeout.columns.status")}>
                      <Status a={a} />
                    </td>
                    <td data-label={t("closeout.columns.actions")}>
                      <div className="row wrap" style={{ gap: 6 }}>
                        {a.status === "done" && (
                          <a className="btn" href={closeoutApi.downloadUrl(project.id, a.id)} download>
                            {t("closeout.download")}
                          </a>
                        )}
                        {(a.status === "done" || a.status === "failed") && (
                          <button className="link-button" disabled={busy} onClick={() => void remove(a)}>
                            {t("closeout.remove.action")}
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

function Status({ a }: { a: CloseoutArchiveDto }) {
  const { t } = useTranslation("projectSettings");
  if (a.status === "queued") return <span className="badge">{t("closeout.status.queued")}</span>;
  if (a.status === "running") {
    const pct = a.bytesTotal ? Math.min(100, Math.round((a.bytesDone / a.bytesTotal) * 100)) : 0;
    return (
      <div className="stack" style={{ gap: 4 }}>
        <span className="badge">{t("closeout.status.running", { done: a.filesDone, total: a.filesTotal })}</span>
        <progress max={100} value={pct} aria-label={t("closeout.status.progress")} />
      </div>
    );
  }
  if (a.status === "failed")
    return (
      <span className="badge danger" title={a.error ?? undefined}>
        {t("closeout.status.failed")}
        {a.error ? `: ${a.error}` : ""}
      </span>
    );
  if (a.status === "expired") return <span className="badge muted">{t("closeout.status.expired")}</span>;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <span className={`badge ${a.problems ? "danger" : "ok"}`}>{a.problems ? t("closeout.status.problems", { count: a.problems }) : t("closeout.status.done")}</span>
      {a.expiresAt && <span className="muted small">{t("closeout.expires", { date: formatDate(a.expiresAt) })}</span>}
    </div>
  );
}
