/**
 * Yönetim → Sistem Durumu → Başarısız arka plan işleri: failures grouped by kind and error, each group
 * expandable to its jobs (project, file, times, attempts), with Retry and Clear (confirmed, audited).
 */
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { FailedJobDto, FailedJobGroupDto, FailedJobSelector } from "@sitekeep/shared";
import { api, formatDate } from "../../../shared/api/api";
import { useLoad } from "../../../app/context/project";
import { ConfirmDialog } from "../../../shared/ui/Dialog";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";

const PAGE_SIZE = 25;
const keyOf = (g: { kind: string; error: string }) => `${g.kind}\u0000${g.error}`;

export function FailedJobsCard({ onChanged }: { onChanged?: () => void }) {
  const { t } = useTranslation(["admin", "common"]);
  const { data, error, reload } = useLoad(() => api.failedJobGroups(), []);
  const [open, setOpen] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [fail, setFail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<{ sel: FailedJobSelector; count: number } | null>(null);
  const kindLabel = (kind: string) => t(`systemStatus.failedJobs.kinds.${kind}`, { defaultValue: kind });

  const refresh = () => {
    reload();
    setVersion((v) => v + 1);
    onChanged?.();
  };
  async function retry(sel: FailedJobSelector) {
    setBusy(true);
    setNote(null);
    setFail(null);
    try {
      const r = await api.retryFailedJobs(sel);
      setNote(t("systemStatus.failedJobs.retried", { queued: r.queued, skipped: r.skipped }));
      refresh();
    } catch (e) {
      setFail((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function clear(sel: FailedJobSelector) {
    setBusy(true);
    setNote(null);
    setFail(null);
    try {
      const r = await api.clearFailedJobs(sel);
      setNote(t("systemStatus.failedJobs.cleared", { count: r.deleted }));
      refresh();
    } catch (e) {
      setFail((e as Error).message);
    } finally {
      setBusy(false);
      setAsk(null);
    }
  }

  const total = data?.reduce((n, g) => n + g.count, 0) ?? 0;
  return (
    <div className="card" data-testid="failed-jobs-card">
      <h2 style={{ margin: "0 0 4px" }}>{t("systemStatus.failedJobs.title")}</h2>
      <p className="muted small" style={{ margin: "0 0 8px" }}>
        {t("systemStatus.failedJobs.description")}
      </p>
      {error && <p className="error">{error}</p>}
      {fail && <p className="error">{fail}</p>}
      {note && <p className="success">{note}</p>}
      {!data && !error && <LoadingIndicator />}
      {data && data.length === 0 && <p className="muted">{t("systemStatus.failedJobs.none")}</p>}
      {data && data.length > 0 && (
        <>
          <p className="muted small">{t("systemStatus.failedJobs.summary", { count: total, groups: data.length })}</p>
          <table className="phone-cards">
            <thead>
              <tr>
                <th>{t("systemStatus.failedJobs.columns.kind")}</th>
                <th>{t("systemStatus.failedJobs.columns.error")}</th>
                <th>{t("systemStatus.failedJobs.columns.count")}</th>
                <th>{t("systemStatus.failedJobs.columns.last")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((g) => (
                <GroupRows
                  key={keyOf(g)}
                  group={g}
                  label={kindLabel(g.kind)}
                  expanded={open === keyOf(g)}
                  version={version}
                  busy={busy}
                  onToggle={() => setOpen(open === keyOf(g) ? null : keyOf(g))}
                  onRetry={retry}
                  onClear={(sel, count) => setAsk({ sel, count })}
                />
              ))}
            </tbody>
          </table>
        </>
      )}
      {ask && (
        <ConfirmDialog
          title={t("systemStatus.failedJobs.clearTitle")}
          message={t("systemStatus.failedJobs.clearConfirm", { count: ask.count })}
          confirmLabel={t("common:actions.clear")}
          danger
          busy={busy}
          onClose={() => setAsk(null)}
          onConfirm={() => void clear(ask.sel)}
        />
      )}
    </div>
  );
}

function GroupRows({
  group,
  label,
  expanded,
  version,
  busy,
  onToggle,
  onRetry,
  onClear,
}: {
  group: FailedJobGroupDto;
  label: string;
  expanded: boolean;
  version: number;
  busy: boolean;
  onToggle: () => void;
  onRetry: (sel: FailedJobSelector) => void;
  onClear: (sel: FailedJobSelector, count: number) => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const sel: FailedJobSelector = { kind: group.kind, error: group.error };
  return (
    <Fragment>
      <tr>
        <td className="pc-title">{label}</td>
        <td>{group.error || <span className="muted">{t("common:dash")}</span>}</td>
        <td>
          <span className="badge danger">{group.count}</span>
        </td>
        <td className="muted small">{group.lastFinishedAt ? formatDate(group.lastFinishedAt) : t("common:dash")}</td>
        <td>
          <div className="row wrap" style={{ gap: 8 }}>
            <button type="button" className="ghost" aria-expanded={expanded} onClick={onToggle}>
              {expanded ? t("systemStatus.failedJobs.hide") : t("systemStatus.failedJobs.details")}
            </button>
            <button type="button" disabled={busy || !group.retryable} title={group.retryable ? undefined : t("systemStatus.failedJobs.notRetryable")} onClick={() => onRetry(sel)}>
              {t("systemStatus.failedJobs.retryGroup")}
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => onClear(sel, group.count)}>
              {t("systemStatus.failedJobs.clearGroup")}
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5}>
            <GroupJobs group={group} version={version} busy={busy} onRetry={onRetry} onClear={onClear} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function GroupJobs({
  group,
  version,
  busy,
  onRetry,
  onClear,
}: {
  group: FailedJobGroupDto;
  version: number;
  busy: boolean;
  onRetry: (sel: FailedJobSelector) => void;
  onClear: (sel: FailedJobSelector, count: number) => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const [page, setPage] = useState(1);
  const { data, error } = useLoad(() => api.failedJobs({ kind: group.kind, error: group.error, page, pageSize: PAGE_SIZE }), [group.kind, group.error, page, version]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <LoadingIndicator />;
  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  return (
    <div data-testid="failed-jobs-list">
      <table>
        <thead>
          <tr>
            <th>{t("systemStatus.failedJobs.columns.project")}</th>
            <th>{t("systemStatus.failedJobs.columns.file")}</th>
            <th>{t("systemStatus.failedJobs.columns.created")}</th>
            <th>{t("systemStatus.failedJobs.columns.finished")}</th>
            <th>{t("systemStatus.failedJobs.columns.attempts")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.items.map((j) => (
            <JobRow key={j.id} job={j} busy={busy} onRetry={onRetry} onClear={onClear} />
          ))}
        </tbody>
      </table>
      {pages > 1 && (
        <div className="row wrap" style={{ gap: 8, marginTop: 8, alignItems: "center" }}>
          <button type="button" className="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            {t("systemStatus.failedJobs.previous")}
          </button>
          <span className="muted small">{t("systemStatus.failedJobs.page", { page, pages, total: data.total })}</span>
          <button type="button" className="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            {t("common:actions.next")}
          </button>
        </div>
      )}
    </div>
  );
}

function JobRow({
  job,
  busy,
  onRetry,
  onClear,
}: {
  job: FailedJobDto;
  busy: boolean;
  onRetry: (sel: FailedJobSelector) => void;
  onClear: (sel: FailedJobSelector, count: number) => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const dash = t("common:dash");
  return (
    <tr>
      <td>
        {job.project ? (
          <Link to={`/projects/${job.project.id}`}>
            {job.project.code} · {job.project.name}
          </Link>
        ) : (
          dash
        )}
      </td>
      <td>
        {job.file && job.project ? (
          <Link to={`/projects/${job.project.id}/files/${job.file.id}`}>
            {job.file.name} <span className="muted small">v{job.file.version}</span>
          </Link>
        ) : (
          dash
        )}
      </td>
      <td className="muted small">{formatDate(job.createdAt)}</td>
      <td className="muted small">{job.finishedAt ? formatDate(job.finishedAt) : dash}</td>
      <td>{job.attempts}</td>
      <td>
        <div className="row wrap" style={{ gap: 8 }}>
          <button type="button" disabled={busy || !job.retryable} onClick={() => onRetry({ ids: [job.id] })}>
            {t("systemStatus.failedJobs.retry")}
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={() => onClear({ ids: [job.id] }, 1)}>
            {t("systemStatus.failedJobs.clear")}
          </button>
        </div>
      </td>
    </tr>
  );
}
