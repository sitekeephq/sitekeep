/**
 * Projeler → Projeyi Geri Yükle (system administrators, docs/features/PROJECT_EXPORT.md#restore):
 * uploads a full project export, follows the restore job (checksums first, then the import) and
 * shows its report: what came in and the people and companies without a match here.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { ProjectImportDto } from "@sitekeep/shared";
import { portabilityApi } from "../../../shared/api/api-portability";
import { Dialog } from "../../../shared/ui/Dialog";

const POLL_MS = 2000;

export function RestoreProjectDialog({ onClose, onRestored }: { onClose: () => void; onRestored: () => void }) {
  const { t } = useTranslation("projects");
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ProjectImportDto | null>(null);

  const running = job && (job.status === "queued" || job.status === "running");
  useEffect(() => {
    if (!job || !running) return;
    const timer = setInterval(() => {
      portabilityApi.importOne(job.id).then(
        (j) => {
          setJob(j);
          if (j.status === "done") onRestored();
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, running]);

  async function start() {
    if (!file || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setJob(await portabilityApi.startImport(file, code.trim(), name.trim() || undefined));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const r = job?.report;
  return (
    <Dialog title={t("restore.title")} onClose={() => !busy && onClose()}>
      <div className="stack" data-testid="restore-project">
        <p className="muted small" style={{ margin: 0 }}>
          {t("restore.hint")}
        </p>
        {!job && (
          <>
            <label className="stack" style={{ gap: 4 }}>
              <span>{t("restore.file")}</span>
              <input type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            <label className="stack" style={{ gap: 4 }}>
              <span>{t("restore.code")}</span>
              <input value={code} maxLength={40} onChange={(e) => setCode(e.target.value)} />
            </label>
            <label className="stack" style={{ gap: 4 }}>
              <span>{t("restore.name")}</span>
              <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            </label>
          </>
        )}
        {busy && <p className="small">{t("restore.uploading")}</p>}
        {job && job.status === "queued" && <p className="small">{t("restore.queued")}</p>}
        {job && job.status === "running" && (
          <div className="stack" style={{ gap: 4 }}>
            <span className="small">
              {job.phase === "import" ? t("restore.importing", { done: job.filesDone, total: job.filesTotal }) : t("restore.verifying", { done: job.filesDone, total: job.filesTotal })}
            </span>
            <progress max={Math.max(1, job.filesTotal)} value={job.filesDone} />
          </div>
        )}
        {job && job.status === "failed" && (
          <p className="error" data-testid="restore-failed">
            {t("restore.failed", { error: job.error ?? "" })}
          </p>
        )}
        {job && job.status === "done" && r && (
          <div className="stack" data-testid="restore-done">
            <p className="small" style={{ margin: 0 }}>
              {t("restore.done", { code: job.code, files: r.counts.files, versions: r.counts.versions, topics: r.counts.issues, members: r.counts.members })}
            </p>
            {r.unknownUsers.length > 0 && (
              <div className="small">
                {t("restore.unknownUsers")}
                <ul data-testid="restore-unknown-users">
                  {r.unknownUsers.map((u) => (
                    <li key={u.email}>
                      {u.name ? `${u.name} <${u.email}>` : u.email}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {r.unknownCompanies.length > 0 && (
              <div className="small">
                {t("restore.unknownCompanies")}
                <ul>
                  {r.unknownCompanies.map((c) => (
                    <li key={`${c.code ?? ""}:${c.name}`}>{c.code ? `${c.code} ${c.name}` : c.name}</li>
                  ))}
                </ul>
              </div>
            )}
            {r.skippedGrants > 0 && <p className="small muted">{t("restore.skippedGrants", { count: r.skippedGrants })}</p>}
            {r.missingVersions.length > 0 && <p className="small muted">{t("restore.missingVersions", { count: r.missingVersions.length })}</p>}
            {r.warnings.length > 0 && (
              <div className="small muted">
                {t("restore.warnings")}
                <ul>
                  {r.warnings.slice(0, 50).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button disabled={busy} onClick={onClose}>
            {t("restore.close")}
          </button>
          {!job && (
            <button className="primary" disabled={busy || !file || !code.trim()} onClick={() => void start()}>
              {t("restore.start")}
            </button>
          )}
          {job?.status === "done" && job.projectId && (
            <button className="primary" onClick={() => navigate(`/projects/${job.projectId}/files`)}>
              {t("restore.open")}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
