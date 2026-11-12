/**
 * Yönetim → Sistem Durumu (docs/onprem/monitoring.md): canlılık, kaynak, kuyruk, yedek özeti.
 * Kartlar örnek listeleri modalda açar; yedek işi henüz kuyruğa bağlı değil.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AdminStatusDto, StatusLevel } from "@sitekeep/shared";
import { api, formatDate, formatNumber, formatPercent, formatSize } from "../../../shared/api/api";
import { useAuth } from "../../../app/context/auth";
import { useLoad } from "../../../app/context/project";
import { i18n } from "../../../i18n";
import { ConfirmDialog, Dialog } from "../../../shared/ui/Dialog";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";
import { CapacityCard } from "./AdminCapacity";

const LEVEL_BADGE: Record<StatusLevel, string> = {
  ok: "ok",
  warn: "warn",
  danger: "danger",
};

type JobStatus = "queued" | "running" | "done" | "failed";
type JobKind = "ifc" | "preview" | "clash" | "backup";
type DemoTarget = "estimate" | "facade" | "clash" | "localDisk" | "meetingNote" | "now";

type DemoJob = {
  id: string;
  kind: JobKind;
  /** A sample file name, or a translated sample target. */
  target: string | { key: DemoTarget };
  status: JobStatus;
  at: string;
};

type DemoBackup = {
  id: string;
  at: string;
  sizeBytes: number;
  minutes: number;
  appVersion: string;
};

type DemoLog = {
  at: string;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
};

const JOB_TONE: Record<JobStatus, string> = { queued: "info", running: "", done: "ok", failed: "danger" };

const LOG_TONE: Record<DemoLog["level"], string> = { info: "info", warn: "warn", error: "danger" };

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function seedJobs(): DemoJob[] {
  return [
    { id: "j1", kind: "ifc", target: "Blok A.ifc", status: "running", at: minutesAgo(8) },
    { id: "j2", kind: "preview", target: { key: "estimate" }, status: "queued", at: minutesAgo(3) },
    { id: "j3", kind: "preview", target: { key: "facade" }, status: "queued", at: minutesAgo(2) },
    { id: "j4", kind: "clash", target: { key: "clash" }, status: "queued", at: minutesAgo(1) },
    { id: "j5", kind: "backup", target: { key: "localDisk" }, status: "done", at: hoursAgo(16.3) },
    { id: "j6", kind: "ifc", target: "Tesisat.ifc", status: "done", at: hoursAgo(20) },
    { id: "j7", kind: "preview", target: { key: "meetingNote" }, status: "done", at: hoursAgo(26) },
    { id: "j8", kind: "ifc", target: "Statik.ifc", status: "done", at: hoursAgo(30) },
  ];
}

function seedBackups(): DemoBackup[] {
  return [0, 1, 2, 3, 4, 5, 6].map((i) => ({
    id: `b${i}`,
    at: hoursAgo(16.3 + i * 24),
    sizeBytes: Math.round((1.82 - i * 0.03) * 1024 ** 3),
    minutes: 12 + i,
    appVersion: "0.1.0",
  }));
}

/** Sample lines in the current language (called while rendering). */
function seedLogs(): DemoLog[] {
  const facade = i18n.t("admin:systemStatus.demo.targets.facade");
  return [
    { at: minutesAgo(8), level: "info", source: i18n.t("admin:systemStatus.demo.sources.queue"), message: i18n.t("admin:systemStatus.demo.logs.ifcStarted", { file: "Blok A.ifc" }) },
    {
      at: hoursAgo(16.3),
      level: "info",
      source: i18n.t("admin:systemStatus.demo.sources.backup"),
      message: i18n.t("admin:systemStatus.demo.logs.backupDone", { size: `${formatNumber(1.8)} GB`, minutes: 12 }),
    },
    { at: hoursAgo(30), level: "error", source: i18n.t("admin:systemStatus.demo.sources.queue"), message: i18n.t("admin:systemStatus.demo.logs.ifcTimeout", { file: "Statik.ifc" }) },
    { at: hoursAgo(40), level: "warn", source: i18n.t("admin:systemStatus.demo.sources.preview"), message: i18n.t("admin:systemStatus.demo.logs.noDwg", { file: facade }) },
  ];
}

function duration(abs: number): string {
  return abs < 60
    ? i18n.t("admin:systemStatus.time.seconds", { n: abs })
    : abs < 3600
      ? i18n.t("admin:systemStatus.time.minutes", { n: Math.round(abs / 60) })
      : i18n.t("admin:systemStatus.time.hours", { n: Math.round(abs / 3600) });
}

function ago(iso: string): string {
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const time = duration(Math.abs(sec));
  return sec >= 0 ? i18n.t("admin:systemStatus.time.ago", { time }) : i18n.t("admin:systemStatus.time.in", { time });
}

function uptime(sec: number): string {
  if (sec < 60) return i18n.t("admin:systemStatus.time.seconds", { n: sec });
  if (sec < 3600) return i18n.t("admin:systemStatus.time.minutes", { n: Math.round(sec / 60) });
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? i18n.t("admin:systemStatus.time.hoursMinutes", { h, m }) : i18n.t("admin:systemStatus.time.hours", { n: h });
}

function pct(ratio: number): string {
  return formatPercent(ratio);
}

/** Stable 24-hour sample — not live host metrics, not Grafana. */
function hours24(seed: number, base: number, wobble: number): number[] {
  return Array.from({ length: 24 }, (_, i) => {
    const wave = Math.sin((i + seed) / 3.2) * wobble;
    const work = i >= 8 && i <= 18 ? wobble * 0.6 : 0;
    return Math.max(0.03, Math.min(0.9, base + wave + work));
  });
}

const CPU_24 = hours24(2, 0.14, 0.07);
const MEM_24 = hours24(5, 0.26, 0.04);
const DISK_24 = hours24(1, 0.2, 0.015).map((v, i) => v + i * 0.001);
const QUEUE_24 = hours24(8, 0.18, 0.12).map((v) => Math.round(v * 12));

function Spark({ values, label }: { values: number[]; label: string }) {
  const w = 168;
  const h = 36;
  const max = Math.max(...values, 1);
  const points = values
    .map((v, i) => {
      const x = 1 + (i / Math.max(values.length - 1, 1)) * (w - 2);
      const y = h - 2 - (v / max) * (h - 6);
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <div>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
        <polyline fill="none" stroke="var(--primary)" strokeWidth="1.6" strokeLinejoin="round" points={points} />
      </svg>
      <div className="muted small">{label}</div>
    </div>
  );
}

export function ProjectStatusPage() {
  const { t } = useTranslation("admin");
  const { user } = useAuth();
  if (!user?.isAdmin) return <div className="page error">{t("adminOnly")}</div>;
  return (
    <div className="page">
      <AdminStatusSection />
    </div>
  );
}

export function AdminStatusSection() {
  const [clock, setClock] = useState(0);
  const { data, error, setData } = useLoad(() => api.adminStatus(), []);
  useEffect(() => {
    const id = window.setInterval(() => setClock((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <LoadingIndicator />;
  return <StatusCards data={data} clock={clock} onQueued={() => setData(queuedBackup(data))} />;
}

function queuedBackup(data: AdminStatusDto): AdminStatusDto {
  return {
    ...data,
    jobs: { ...data.jobs, queued: data.jobs.queued + 1 },
    backup: { ...data.backup, lastError: null },
  };
}

function StatusCards({
  data,
  clock,
  onQueued,
}: {
  data: AdminStatusDto;
  clock: number;
  onQueued: () => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const diskRatio = data.disk?.usedRatio ?? 0;
  const memUsed = data.memory.totalBytes ? 1 - data.memory.freeBytes / data.memory.totalBytes : 0;
  const [queuedNote, setQueuedNote] = useState(false);
  const [panel, setPanel] = useState<"jobs" | "backups" | "logs" | null>(null);
  const [jobs, setJobs] = useState(seedJobs);
  const [backups, setBackups] = useState(seedBackups);
  const [cleaned, setCleaned] = useState(false);
  const [ask, setAsk] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
    run: () => void;
  } | null>(null);
  void clock;

  const newestBackup = backups[0]?.id;
  const jobTarget = (job: DemoJob) => (typeof job.target === "string" ? job.target : t(`systemStatus.demo.targets.${job.target.key}`));

  return (
    <div className="stack">
      <div className="card">
        <div className="row wrap" style={{ gap: 12 }}>
          <div style={{ flex: "1 1 280px" }}>
            <h2 style={{ margin: "0 0 4px" }}>{t("systemStatus.title")}</h2>
            <p className="muted small" style={{ margin: 0 }}>
              {t("systemStatus.checked", { time: ago(data.checkedAt) })}
            </p>
          </div>
          <span className={`badge ${LEVEL_BADGE[data.level]}`}>{t(`systemStatus.badges.${data.level}`)}</span>
        </div>
      </div>

      <div className="card">
        <h2>{t("systemStatus.health.title")}</h2>
        <table className="phone-cards">
          <tbody>
            <Row
              label={t("systemStatus.health.app")}
              ok={data.app.ok}
              detail={t("systemStatus.health.appDetail", { version: data.app.version ?? t("common:dash"), node: data.app.node, uptime: uptime(data.app.uptimeSeconds) })}
            />
            <Row
              label={t("systemStatus.health.database")}
              ok={data.database.ok}
              detail={
                data.database.ok
                  ? t("systemStatus.health.databaseDetail", { kind: data.database.kind, size: `${formatNumber(2.4)} GB` })
                  : t("systemStatus.health.databaseDown")
              }
            />
            <tr>
              <td className="pc-title">{t("systemStatus.health.licence")}</td>
              <td>
                <span className="badge ok">{t("systemStatus.badges.valid")}</span>
                <span className="muted small" style={{ marginLeft: 8 }}>
                  {t("systemStatus.health.monthsLeft", { count: 14 })}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>{t("systemStatus.resources.title")}</h2>
        <table className="phone-cards">
          <tbody>
            {data.cpu && (
              <tr>
                <td className="pc-title">{t("systemStatus.resources.cpu")}</td>
                <td>{t("systemStatus.resources.cpuUsage", { percent: pct(data.cpu.usedRatio) })}</td>
              </tr>
            )}
            <tr>
              <td className="pc-title">{t("systemStatus.resources.memory")}</td>
              <td>
                {t("systemStatus.resources.usage", {
                  percent: pct(memUsed),
                  free: formatSize(data.memory.freeBytes),
                  total: formatSize(data.memory.totalBytes),
                })}
                <div className="muted small">{t("systemStatus.resources.process", { size: formatSize(data.memory.processBytes) })}</div>
              </td>
            </tr>
            <tr>
              <td className="pc-title">{t("systemStatus.resources.disk")}</td>
              <td>
                {data.disk ? (
                  <>
                    {t("systemStatus.resources.usage", {
                      percent: pct(diskRatio),
                      free: formatSize(data.disk.freeBytes),
                      total: formatSize(data.disk.totalBytes),
                    })}
                    <div className="muted small">{data.disk.path}</div>
                  </>
                ) : (
                  <span className="muted">{t("systemStatus.resources.unreadable")}</span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="muted small" style={{ margin: "12px 0 8px" }}>
          {t("systemStatus.resources.last24")}
        </p>
        <div className="row wrap" style={{ gap: 20 }}>
          <Spark values={CPU_24} label={t("systemStatus.resources.cpu")} />
          <Spark values={MEM_24} label={t("systemStatus.resources.memory")} />
          <Spark values={DISK_24} label={t("systemStatus.resources.disk")} />
        </div>
      </div>

      <CapacityCard />

      <div className="card">
        <div className="row wrap" style={{ gap: 12 }}>
          <div style={{ flex: "1 1 280px" }}>
            <h2 style={{ margin: "0 0 4px" }}>{t("systemStatus.queue.title")}</h2>
            <p className="muted small" style={{ margin: 0 }}>
              {t("systemStatus.queue.description")}
            </p>
          </div>
          <button type="button" onClick={() => setPanel("jobs")}>
            {t("systemStatus.queue.actions.view")}
          </button>
        </div>
        <div className="row wrap" style={{ gap: 16, marginTop: 12, alignItems: "flex-end" }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="badge info">{t("systemStatus.badges.queued", { n: data.jobs.queued })}</span>
            <span className="badge">{t("systemStatus.badges.running", { n: data.jobs.running })}</span>
            <span className={`badge ${data.jobs.failed ? "danger" : "ok"}`}>{t("systemStatus.badges.failed", { n: data.jobs.failed })}</span>
            <span className="badge ok">{t("systemStatus.badges.done", { n: data.jobs.done })}</span>
          </div>
          <Spark values={QUEUE_24} label={t("systemStatus.queue.spark")} />
        </div>
      </div>

      <div className="card">
        <div className="row wrap" style={{ gap: 12 }}>
          <div style={{ flex: "1 1 280px" }}>
            <h2 style={{ margin: "0 0 4px" }}>{t("systemStatus.backup.title")}</h2>
            <p className="muted small" style={{ margin: 0 }}>
              {data.backup.scheduled
                ? [
                    t("systemStatus.backup.nightly"),
                    data.backup.lastSuccessAt ? t("systemStatus.backup.lastSuccess", { time: ago(data.backup.lastSuccessAt) }) : null,
                    data.backup.nextAt ? t("systemStatus.backup.next", { time: ago(data.backup.nextAt) }) : null,
                    t("systemStatus.backup.copies", { count: backups.length }),
                  ]
                    .filter(Boolean)
                    .join(" ")
                : t("systemStatus.backup.notScheduled")}
            </p>
            {queuedNote && <p className="success">{t("systemStatus.backup.queued")}</p>}
            {data.backup.lastError && <p className="error">{data.backup.lastError}</p>}
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <button type="button" onClick={() => setPanel("backups")}>
              {t("systemStatus.backup.actions.viewCopies")}
            </button>
            <button
              type="button"
              disabled={!data.backup.scheduled || queuedNote}
              onClick={() => {
                onQueued();
                setJobs((rows) => [
                  {
                    id: `q-${Date.now()}`,
                    kind: "backup",
                    target: { key: "now" },
                    status: "queued",
                    at: new Date().toISOString(),
                  },
                  ...rows,
                ]);
                setQueuedNote(true);
              }}
            >
              {t("systemStatus.backup.actions.backupNow")}
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row wrap" style={{ gap: 12 }}>
          <div style={{ flex: "1 1 280px" }}>
            <h2 style={{ margin: "0 0 4px" }}>{t("systemStatus.maintenance.title")}</h2>
            <p className="muted small" style={{ margin: 0 }}>
              {cleaned ? t("systemStatus.maintenance.cleaned") : t("systemStatus.maintenance.description")}
            </p>
          </div>
          <button
            type="button"
            disabled={cleaned}
            onClick={() =>
              setAsk({
                title: t("systemStatus.maintenance.actions.clean"),
                message: t("systemStatus.maintenance.confirm", { size: `${formatNumber(1.1)} GB` }),
                confirmLabel: t("common:actions.clear"),
                danger: true,
                run: () => setCleaned(true),
              })
            }
          >
            {t("systemStatus.maintenance.actions.clean")}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row wrap" style={{ gap: 12 }}>
          <div style={{ flex: "1 1 280px" }}>
            <h2 style={{ margin: "0 0 4px" }}>{t("systemStatus.recentErrors.title")}</h2>
            <p className="muted small" style={{ margin: 0 }}>
              {t("systemStatus.recentErrors.description")}
            </p>
          </div>
          <button type="button" onClick={() => setPanel("logs")}>
            {t("systemStatus.recentErrors.actions.view")}
          </button>
        </div>
      </div>

      <div className="card">
        <h2>{t("systemStatus.external.title")}</h2>
        <p style={{ marginBottom: 0 }}>
          {data.privacy.killSwitch ? (
            <span className="badge danger">{t("systemStatus.badges.allExternalOff")}</span>
          ) : (
            <span className="badge ok">{t("systemStatus.badges.externalOn")}</span>
          )}
        </p>
      </div>

      {panel === "jobs" && (
        <Dialog title={t("systemStatus.queue.title")} onClose={() => setPanel(null)} wide>
          <p className="muted small" style={{ marginTop: 0 }}>
            {t("systemStatus.queue.dialogDescription")}
          </p>
          <table>
            <thead>
              <tr>
                <th>{t("systemStatus.queue.columns.job")}</th>
                <th>{t("systemStatus.queue.columns.target")}</th>
                <th>{t("common:fields.status")}</th>
                <th>{t("common:fields.time")}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>{job.kind === "ifc" ? "IFC → Fragments" : t(`systemStatus.demo.kinds.${job.kind}`)}</td>
                  <td>{jobTarget(job)}</td>
                  <td>
                    <span className={`badge ${JOB_TONE[job.status]}`}>{t(`systemStatus.queue.status.${job.status}`)}</span>
                  </td>
                  <td className="muted small">{ago(job.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Dialog>
      )}

      {panel === "backups" && (
        <Dialog title={t("systemStatus.backup.copiesTitle")} onClose={() => setPanel(null)} wide>
          <p className="muted small" style={{ marginTop: 0 }}>
            {t("systemStatus.backup.copiesDescription")}
          </p>
          <table>
            <thead>
              <tr>
                <th>{t("systemStatus.backup.columns.taken")}</th>
                <th>{t("common:fields.version")}</th>
                <th>{t("common:fields.size")}</th>
                <th>{t("common:fields.duration")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {backups.map((copy) => {
                const latest = copy.id === newestBackup;
                return (
                  <tr key={copy.id}>
                    <td>{formatDate(copy.at)}</td>
                    <td>v{copy.appVersion}</td>
                    <td>{formatSize(copy.sizeBytes)}</td>
                    <td>{t("systemStatus.backup.minutes", { n: copy.minutes })}</td>
                    <td>
                      {latest ? (
                        <span className="badge ok">{t("systemStatus.badges.latest")}</span>
                      ) : (
                        <button
                          type="button"
                          className="ghost"
                          onClick={() =>
                            setAsk({
                              title: t("systemStatus.backup.actions.delete"),
                              message: t("systemStatus.backup.deleteConfirm", { date: formatDate(copy.at) }),
                              confirmLabel: t("common:actions.delete"),
                              danger: true,
                              run: () => setBackups((rows) => rows.filter((row) => row.id !== copy.id)),
                            })
                          }
                        >
                          {t("common:actions.delete")}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Dialog>
      )}

      {ask && (
        <ConfirmDialog
          title={ask.title}
          message={ask.message}
          confirmLabel={ask.confirmLabel}
          danger={ask.danger}
          onClose={() => setAsk(null)}
          onConfirm={() => {
            ask.run();
            setAsk(null);
          }}
        />
      )}

      {panel === "logs" && (
        <Dialog title={t("systemStatus.recentErrors.title")} onClose={() => setPanel(null)} wide>
          <p className="muted small" style={{ marginTop: 0 }}>
            {t("systemStatus.recentErrors.dialogDescription")}
          </p>
          <table>
            <thead>
              <tr>
                <th>{t("common:fields.time")}</th>
                <th>{t("systemStatus.recentErrors.columns.level")}</th>
                <th>{t("systemStatus.recentErrors.columns.source")}</th>
                <th>{t("systemStatus.recentErrors.columns.message")}</th>
              </tr>
            </thead>
            <tbody>
              {seedLogs().map((line, i) => (
                <tr key={i}>
                  <td className="muted small">{ago(line.at)}</td>
                  <td>
                    <span className={`badge ${LOG_TONE[line.level]}`}>{t(`systemStatus.recentErrors.levels.${line.level}`)}</span>
                  </td>
                  <td>{line.source}</td>
                  <td>{line.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Dialog>
      )}
    </div>
  );
}

function Row({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  const { t } = useTranslation("admin");
  return (
    <tr>
      <td className="pc-title">{label}</td>
      <td>
        <span className={`badge ${ok ? "ok" : "danger"}`}>{ok ? t("systemStatus.badges.up") : t("systemStatus.badges.down")}</span>
        <span className="muted small" style={{ marginLeft: 8 }}>
          {detail}
        </span>
      </td>
    </tr>
  );
}
