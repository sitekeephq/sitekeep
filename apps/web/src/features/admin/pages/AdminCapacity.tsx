/**
 * Yönetim → Sistem Durumu → Kapasite (docs/onprem/capacity.md): the server against the sizing
 * table, Canlı Test Et with live charts, Kapasite Rehberi and the reports. While the sample engine
 * runs the tests, every run says "örnek veri".
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CAPACITY_LIMITS,
  CAPACITY_TEST_MAX_AGE_DAYS,
  CAPACITY_TIERS,
  capacityCommonRequirements,
  capacityTierDatabase,
  capacityTierLabel,
  type AdminCapacityDto,
  type CapacityRunDto,
  type CapacityRunMode,
  type CapacitySample,
} from "@sitekeep/shared";
import { api, formatDate, formatNumber, formatPercent, formatSize } from "../../../shared/api/api";
import { useLoad } from "../../../app/context/project";
import { i18n } from "../../../i18n";
import { Dialog } from "../../../shared/ui/Dialog";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";

const STATUS_TONE: Record<CapacityRunDto["status"], string> = {
  running: "info",
  passed: "ok",
  limited: "ok",
  cancelled: "warn",
  failed: "danger",
};
const GiB = 1024 ** 3;

const tierLabel = (id: string | null) => {
  const tier = CAPACITY_TIERS.find((x) => x.id === id);
  if (!tier) return i18n.t("admin:capacity.tierBelow");
  const name = capacityTierLabel(tier.id, i18n.language);
  return tier.maxUsers ? i18n.t("admin:capacity.tierWithMax", { tier: name, max: tier.maxUsers }) : i18n.t("admin:capacity.tierUnbounded", { tier: name });
};
const pct = (v: number) => formatPercent(v);
const ms = (v: number) => `${formatNumber(Math.round(v))} ms`;
const oneDecimal = (v: number) => formatNumber(v, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function CapacityCard() {
  const { t } = useTranslation("admin");
  const { data, error, reload } = useLoad(() => api.adminCapacity(), []);
  const [panel, setPanel] = useState<"test" | "guide" | "runs" | null>(null);
  if (error) return <div className="card"><p className="error">{error}</p></div>;
  if (!data) return <div className="card"><LoadingIndicator /></div>;
  const last = data.lastRun;
  const lastText = last
    ? last.result?.concurrent != null
      ? t("capacity.lastTestWithResult", {
          date: formatDate(last.finishedAt ?? last.startedAt),
          mode: t(`capacity.modes.${last.mode}`),
          concurrent: last.result.concurrent,
          registered: last.result.registered,
        })
      : t("capacity.lastTest", { date: formatDate(last.finishedAt ?? last.startedAt), mode: t(`capacity.modes.${last.mode}`) })
    : t("capacity.noTest");
  return (
    <div className="card" data-testid="capacity-card">
      <div className="row wrap" style={{ gap: 12 }}>
        <div style={{ flex: "1 1 280px" }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <h2 style={{ margin: 0 }}>{t("capacity.title")}</h2>
            <span className={`badge ${data.level}`}>{t(`capacity.badges.${data.level}`)}</span>
            {data.demo && <span className="badge info">{t("capacity.badges.sampleData")}</span>}
            {!data.measuredAt && <span className="badge">{t("capacity.badges.estimatedTable")}</span>}
          </div>
          <p className="muted small" style={{ margin: "6px 0 0" }}>
            {`${t("capacity.summary", { tier: tierLabel(data.hardwareTier), registered: data.counts.registered, active: data.counts.active })} ${lastText}`}
          </p>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <button type="button" className="primary" onClick={() => setPanel("test")}>
            {data.running ? t("capacity.actions.watchTest") : t("capacity.actions.runTest")}
          </button>
          <button type="button" onClick={() => setPanel("guide")}>
            {t("capacity.actions.guide")}
          </button>
          <button type="button" onClick={() => setPanel("runs")}>
            {t("capacity.actions.reports")}
          </button>
        </div>
      </div>
      <Findings findings={data.findings} />

      {panel === "test" && <CapacityTestDialog capacity={data} onClose={() => setPanel(null)} onFinished={reload} />}
      {panel === "guide" && <CapacityGuideDialog capacity={data} onClose={() => setPanel(null)} />}
      {panel === "runs" && <CapacityRunsDialog onClose={() => setPanel(null)} />}
    </div>
  );
}

function Findings({ findings }: { findings: AdminCapacityDto["findings"] }) {
  const { t } = useTranslation("admin");
  return (
    <table className="phone-cards" style={{ marginTop: 12 }}>
      <tbody>
        {findings.map((f) => (
          <tr key={f.key}>
            <td className="pc-title">{t(`capacity.findingNames.${f.key}`)}</td>
            <td>
              <span className={`badge ${f.level}`}>{t(`capacity.badges.${f.level}`)}</span>
              <span style={{ marginLeft: 8 }}>{f.title}</span>
            </td>
            <td className="muted small" data-label={t("capacity.findingAction")}>
              {f.level === "ok" ? "" : f.action}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Polls a running test once a second until it ends. */
function useRun(id: string | null, onEnd: () => void) {
  const [run, setRun] = useState<CapacityRunDto | null>(null);
  const ended = useRef(onEnd);
  ended.current = onEnd;
  useEffect(() => {
    if (!id) return;
    let stop = false;
    let timer = 0;
    const tick = async () => {
      try {
        const next = await api.capacityRun(id);
        if (stop) return;
        setRun(next);
        if (next.status !== "running") return ended.current();
      } catch {
        // A missed poll is retried on the next tick.
      }
      if (!stop) timer = window.setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [id]);
  return [run, setRun] as const;
}

function CapacityTestDialog({ capacity, onClose, onFinished }: { capacity: AdminCapacityDto; onClose(): void; onFinished(): void }) {
  const { t } = useTranslation(["admin", "common"]);
  const [mode, setMode] = useState<CapacityRunMode>("quick");
  const [confirmed, setConfirmed] = useState(false);
  const [runId, setRunId] = useState<string | null>(capacity.running?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useRun(runId, onFinished);

  const start = async () => {
    setError(null);
    try {
      const started = await api.startCapacityRun(mode);
      setRun(started);
      setRunId(started.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Dialog title={t("capacity.test.title")} onClose={onClose} wide>
      {!runId ? (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            {t("capacity.test.description")}
          </p>
          {capacity.demo && <p className="notice">{t("capacity.test.demoNotice")}</p>}
          <div className="grid-cards">
            <ModeOption
              mode="quick"
              current={mode}
              onPick={setMode}
              title={t("capacity.modes.quick")}
              meta={t("capacity.test.quickMeta")}
              text={t("capacity.test.quickText")}
            />
            <ModeOption
              mode="load"
              current={mode}
              onPick={setMode}
              disabled={!capacity.loadTestEnabled}
              title={t("capacity.modes.load")}
              meta={t("capacity.test.loadMeta")}
              text={t("capacity.test.loadText", {
                p95: CAPACITY_LIMITS.p95Ms,
                errorRate: formatPercent(CAPACITY_LIMITS.errorRate, 1),
                cpu: formatPercent(CAPACITY_LIMITS.cpu),
              })}
            />
          </div>
          {mode === "load" && (
            <>
              <p className="muted small" style={{ margin: "12px 0 4px" }}>
                {t("capacity.test.loadWarning")}
              </p>
              <label className="row" style={{ color: "var(--text)", fontSize: 13 }}>
                <input type="checkbox" style={{ width: "auto" }} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                {t("capacity.test.options.afterHours")}
              </label>
            </>
          )}
          {error && <p className="error">{error}</p>}
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              {t("common:actions.cancel")}
            </button>
            <button type="button" className="primary" disabled={mode === "load" && !confirmed} onClick={() => void start()}>
              {t("capacity.actions.startTest")}
            </button>
          </div>
        </>
      ) : !run ? (
        <LoadingIndicator />
      ) : (
        <RunView
          run={run}
          onCancel={() => void api.cancelCapacityRun(run.id).then(setRun, (err: Error) => setError(err.message))}
          onAgain={() => {
            setRunId(null);
            setRun(null);
            setConfirmed(false);
          }}
        />
      )}
      {runId && error && <p className="error">{error}</p>}
    </Dialog>
  );
}

function ModeOption(props: {
  mode: CapacityRunMode;
  current: CapacityRunMode;
  onPick(mode: CapacityRunMode): void;
  title: string;
  meta: string;
  text: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation("admin");
  const active = props.mode === props.current;
  return (
    <label className={`card${active ? " highlighted" : ""}`} style={{ cursor: props.disabled ? "not-allowed" : "pointer", opacity: props.disabled ? 0.55 : 1, margin: 0 }}>
      <div className="row" style={{ gap: 8 }}>
        <input
          type="radio"
          name="capacity-mode"
          style={{ width: "auto" }}
          checked={active}
          disabled={props.disabled}
          onChange={() => props.onPick(props.mode)}
        />
        <b>{props.title}</b>
      </div>
      <div className="muted small" style={{ margin: "4px 0 6px" }}>
        {props.disabled ? t("capacity.test.disabledHere") : props.meta}
      </div>
      <div className="small">{props.text}</div>
    </label>
  );
}

function RunView({ run, onCancel, onAgain }: { run: CapacityRunDto; onCancel(): void; onAgain(): void }) {
  const { t } = useTranslation("admin");
  const running = run.status === "running";
  return (
    <div className="stack" data-testid="capacity-run">
      <div>
        <div className="row wrap" style={{ gap: 8 }}>
          <b>{t(`capacity.modes.${run.mode}`)}</b>
          <span className={`badge ${STATUS_TONE[run.status]}`}>{t(`capacity.status.${run.status}`)}</span>
          {run.demo && <span className="badge info">{t("capacity.badges.sampleData")}</span>}
          <div className="spacer" />
          {running && (
            <button type="button" onClick={onCancel}>
              {t("capacity.actions.stop")}
            </button>
          )}
        </div>
        <div className="muted small" style={{ margin: "6px 0" }}>
          {run.stage /* i18n: server text */}
        </div>
        <div
          role="progressbar"
          aria-label={t("capacity.run.progressLabel")}
          aria-valuenow={Math.round(run.progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{ height: 6, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}
        >
          <div style={{ width: `${run.progress * 100}%`, height: "100%", background: "var(--primary)", transition: "width .4s" }} />
        </div>
      </div>

      {run.mode === "quick" ? <QuickChecks run={run} /> : <LoadCharts run={run} />}

      {!running && (
        <>
          {run.result?.concurrent != null && (
            <div className="success">
              <b>{t("capacity.run.result", { concurrent: run.result.concurrent, registered: run.result.registered })}</b>
              {/* i18n: server text (stop reason) */}
              <div className="small">{run.result.stopReason ? t("capacity.run.stopReason", { reason: run.result.stopReason }) : t("capacity.run.noLimit")}</div>
            </div>
          )}
          {run.mode === "load" && run.result && run.result.concurrent == null && run.status !== "cancelled" && (
            <p className="error">{t("capacity.run.firstStepOver", { reason: run.result.stopReason })}</p>
          )}
          {run.findings.length > 0 && (
            <div>
              <h3 style={{ margin: "0 0 4px" }}>{t("capacity.run.findings.title")}</h3>
              <Findings findings={run.findings} />
            </div>
          )}
          <div className="dialog-actions">
            {(run.status === "passed" || run.status === "limited") && (
              <>
                <a className="btn" href={api.capacityReportUrl(run.id)} download>
                  {t("capacity.actions.downloadReport")}
                </a>
                <a className="btn" href={api.capacityReportUrl(run.id, "json")} download>
                  {t("capacity.actions.downloadPackage")}
                </a>
              </>
            )}
            <button type="button" className="primary" onClick={onAgain}>
              {t("capacity.actions.newTest")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function QuickChecks({ run }: { run: CapacityRunDto }) {
  const { t } = useTranslation("admin");
  return (
    <table className="phone-cards">
      <tbody>
        {run.checks.map((c) => (
          <tr key={c.key}>
            {/* i18n: server text (check label and value) */}
            <td className="pc-title">{c.label}</td>
            <td>
              {c.level ? (
                <>
                  <span className={`badge ${c.level}`}>{t(`capacity.badges.${c.level}`)}</span>
                  <span style={{ marginLeft: 8 }}>{c.value}</span>
                </>
              ) : (
                <span className="muted">{t("capacity.run.waiting")}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LoadCharts({ run }: { run: CapacityRunDto }) {
  const { t } = useTranslation("admin");
  const s = run.samples;
  const series = (pick: (x: CapacitySample) => number) => s.map((x) => ({ x: x.t, y: pick(x) }));
  return (
    <>
      <div className="capacity-charts" data-testid="capacity-charts">
        <LineChart title={t("capacity.charts.responseTime")} points={series((x) => x.p95Ms)} format={ms} limit={CAPACITY_LIMITS.p95Ms} />
        <LineChart title={t("capacity.charts.virtualUsers")} points={series((x) => x.users)} format={(v) => String(Math.round(v))} />
        <LineChart title={t("capacity.charts.requestsPerSecond")} points={series((x) => x.rps)} format={oneDecimal} />
        <LineChart title={t("capacity.charts.cpu")} points={series((x) => x.cpu)} format={pct} limit={CAPACITY_LIMITS.cpu} max={1} />
      </div>
      {run.steps.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{t("capacity.charts.columns.users")}</th>
              <th>{t("capacity.charts.columns.p95")}</th>
              <th>{t("capacity.charts.columns.rps")}</th>
              <th>{t("capacity.charts.columns.errors")}</th>
              <th>{t("capacity.charts.columns.cpu")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {run.steps.map((st) => (
              <tr key={st.users}>
                <td>{st.users}</td>
                <td>{ms(st.p95Ms)}</td>
                <td>{oneDecimal(st.rps)}</td>
                <td>{formatPercent(st.errorRate, 2)}</td>
                <td>{pct(st.cpu)}</td>
                <td>
                  <span className={`badge ${st.passed ? "ok" : "danger"}`}>{st.passed ? t("capacity.status.stepPassed") : t("capacity.status.stepLimit")}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** Small line chart (no chart library): the series, an optional dashed limit and the last value. */
export function LineChart({
  title,
  points,
  format,
  limit,
  max,
}: {
  title: string;
  points: { x: number; y: number }[];
  format(v: number): string;
  limit?: number;
  max?: number;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const w = 300;
  const h = 110;
  const pad = 6;
  const top = max ?? Math.max(1, (limit ?? 0) * 1.25, ...points.map((p) => p.y)) * 1.05;
  const xMax = Math.max(10, ...points.map((p) => p.x));
  const X = (x: number) => pad + (x / xMax) * (w - pad * 2);
  const Y = (y: number) => h - pad - (Math.min(y, top) / top) * (h - pad * 2);
  const path = points.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
  const last = points.at(-1);
  const over = limit !== undefined && last !== undefined && last.y > limit;
  return (
    <figure style={{ margin: 0 }} aria-label={title}>
      <div className="row" style={{ marginBottom: 4 }}>
        <span className="small">{title}</span>
        <div className="spacer" />
        <b className="small" style={{ color: over ? "var(--danger)" : undefined }}>
          {last ? format(last.y) : t("common:dash")}
        </b>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img" aria-label={t("capacity.charts.chartLabel", { title })}>
        <rect x="0" y="0" width={w} height={h} rx="6" fill="var(--surface)" stroke="var(--border)" />
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={pad} x2={w - pad} y1={pad + f * (h - pad * 2)} y2={pad + f * (h - pad * 2)} stroke="var(--border)" strokeWidth="0.5" />
        ))}
        {limit !== undefined && (
          <line x1={pad} x2={w - pad} y1={Y(limit)} y2={Y(limit)} stroke="var(--danger)" strokeDasharray="4 4" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        )}
        {path && <path d={path} fill="none" stroke="var(--primary)" strokeWidth="1.8" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
      </svg>
      {limit !== undefined && <figcaption className="muted small">{t("capacity.charts.limitCaption", { limit: format(limit) })}</figcaption>}
    </figure>
  );
}

function CapacityGuideDialog({ capacity, onClose }: { capacity: AdminCapacityDto; onClose(): void }) {
  const {
    t,
    i18n: { language },
  } = useTranslation("admin");
  const hw = capacity.hardware;
  const perProject = t("capacity.guide.perProject");
  const serverSummary = hw.disk
    ? t("capacity.guide.serverSummaryDisk", {
        cpu: hw.cpuCount,
        ram: Math.round(hw.memoryBytes / GiB),
        total: formatSize(hw.disk.totalBytes),
        free: formatSize(hw.disk.freeBytes),
        os: hw.os,
      })
    : t("capacity.guide.serverSummary", { cpu: hw.cpuCount, ram: Math.round(hw.memoryBytes / GiB), os: hw.os });
  return (
    <Dialog title={t("capacity.guide.title")} onClose={onClose} wide>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>
          {t("capacity.guide.intro")}{" "}
          {capacity.measuredAt ? t("capacity.guide.measuredOn", { date: capacity.measuredAt }) : t("capacity.guide.estimated")}{" "}
          {t("capacity.guide.concurrency", { percent: pct(capacity.concurrency) })}
        </p>
        <div>
          <h3 style={{ margin: "0 0 6px" }}>{t("capacity.guide.tiers.title")}</h3>
          <table className="phone-cards" data-testid="capacity-tiers">
            <thead>
              <tr>
                <th>{t("capacity.guide.columns.tier")}</th>
                <th>{t("capacity.guide.columns.registered")}</th>
                <th>{t("capacity.guide.columns.concurrent")}</th>
                <th>{t("capacity.guide.columns.vcpu")}</th>
                <th>{t("capacity.guide.columns.ram")}</th>
                <th>{t("capacity.guide.columns.disk")}</th>
                <th>{t("capacity.guide.columns.database")}</th>
              </tr>
            </thead>
            <tbody>
              {CAPACITY_TIERS.map((tier, i) => {
                const mine = tier.id === capacity.hardwareTier;
                // "Gereken" only when the users need more than this server meets.
                const hwIndex = CAPACITY_TIERS.findIndex((x) => x.id === capacity.hardwareTier);
                const needed = tier.id === capacity.neededTier && i > hwIndex;
                return (
                  <tr key={tier.id} style={mine ? { background: "var(--ok-soft)" } : needed ? { background: "var(--warn-soft)" } : undefined}>
                    <td className="pc-title">
                      {capacityTierLabel(tier.id, language)}
                      {mine && <span className="badge ok" style={{ marginLeft: 6 }}>{t("capacity.badges.thisServer")}</span>}
                      {needed && !mine && <span className="badge warn" style={{ marginLeft: 6 }}>{t("capacity.badges.needed")}</span>}
                    </td>
                    <td data-label={t("capacity.guide.columns.registered")}>{tier.maxUsers ? `≤ ${tier.maxUsers}` : "500+"}</td>
                    <td data-label={t("capacity.guide.columns.concurrent")}>{tier.concurrent}{tier.maxUsers ? "" : "+"}</td>
                    <td data-label={t("capacity.guide.columns.vcpu")}>{tier.vcpu ?? perProject}</td>
                    <td data-label={t("capacity.guide.columns.ram")}>{tier.ramGb ? `${tier.ramGb} GB` : perProject}</td>
                    <td data-label={t("capacity.guide.columns.disk")}>
                      {tier.diskGb
                        ? tier.diskGb[0] === tier.diskGb[1]
                          ? `${tier.diskGb[0]} GB`
                          : `${formatNumber(tier.diskGb[0] / 1000)}–${formatNumber(tier.diskGb[1] / 1000)} TB`
                        : perProject}
                    </td>
                    <td data-label={t("capacity.guide.columns.database")}>{capacityTierDatabase(tier.id, language)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted small">{serverSummary}</p>
        </div>
        <div>
          <h3 style={{ margin: "0 0 6px" }}>{t("capacity.guide.everyTier.title")}</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {capacityCommonRequirements(language).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 style={{ margin: "0 0 6px" }}>{t("capacity.guide.disk.title")}</h3>
          <p style={{ margin: 0 }}>{t("capacity.guide.disk.description")}</p>
        </div>
        <div>
          <h3 style={{ margin: "0 0 6px" }}>{t("capacity.guide.operations.title")}</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>{t("capacity.guide.operations.whenToTest")}</li>
            <li>{t("capacity.guide.operations.oldTest", { days: CAPACITY_TEST_MAX_AGE_DAYS })}</li>
            <li>{t("capacity.guide.operations.plan")}</li>
            <li>{t("capacity.guide.operations.afterHours")}</li>
            <li>{t("capacity.guide.operations.disk")}</li>
            <li>{t("capacity.guide.operations.office")}</li>
          </ul>
        </div>
        <div>
          <h3 style={{ margin: "0 0 6px" }}>{t("capacity.guide.meaning.title")}</h3>
          <table className="phone-cards">
            <tbody>
              <tr>
                <td className="pc-title"><span className="badge ok">{t("capacity.badges.ok")}</span></td>
                <td>{t("capacity.guide.meaning.ok")}</td>
              </tr>
              <tr>
                <td className="pc-title"><span className="badge warn">{t("capacity.badges.warn")}</span></td>
                <td>{t("capacity.guide.meaning.warn")}</td>
              </tr>
              <tr>
                <td className="pc-title"><span className="badge danger">{t("capacity.badges.danger")}</span></td>
                <td>{t("capacity.guide.meaning.danger")}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </Dialog>
  );
}

function CapacityRunsDialog({ onClose }: { onClose(): void }) {
  const { t } = useTranslation(["admin", "common"]);
  const { data, error } = useLoad(() => api.capacityRuns(), []);
  return (
    <Dialog title={t("capacity.runs.title")} onClose={onClose} wide>
      {error ? (
        <p className="error">{error}</p>
      ) : !data ? (
        <LoadingIndicator />
      ) : data.length === 0 ? (
        <p className="muted">{t("capacity.runs.empty")}</p>
      ) : (
        <table className="phone-cards">
          <thead>
            <tr>
              <th>{t("common:fields.date")}</th>
              <th>{t("capacity.runs.columns.test")}</th>
              <th>{t("common:fields.status")}</th>
              <th>{t("common:fields.result")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id}>
                <td className="pc-title">{formatDate(r.startedAt)}</td>
                <td data-label={t("capacity.runs.columns.test")}>
                  {t(`capacity.modes.${r.mode}`)}
                  {r.demo && <span className="badge info" style={{ marginLeft: 6 }}>{t("capacity.badges.sample")}</span>}
                </td>
                <td data-label={t("common:fields.status")}>
                  <span className={`badge ${STATUS_TONE[r.status]}`}>{t(`capacity.status.${r.status}`)}</span>
                </td>
                <td data-label={t("common:fields.result")}>
                  {r.result?.concurrent != null
                    ? t("capacity.runs.result", { concurrent: r.result.concurrent, registered: r.result.registered })
                    : t("common:dash")}
                </td>
                <td className="pc-actions">
                  {(r.status === "passed" || r.status === "limited") && (
                    <a className="btn small" href={api.capacityReportUrl(r.id)} download>
                      {t("capacity.actions.report")}
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">{t("capacity.runs.footnote")}</p>
    </Dialog>
  );
}
