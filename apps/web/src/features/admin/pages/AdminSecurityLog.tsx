/**
 * Administration → Security Log (docs/features/SECURITY_LOG.md): the installation's security events
 * (G-7) and the audit log of every project, with filters and CSV; open security alerts as cards (G-8)
 * and their settings. Auditors (G-10) see all of it and change nothing.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SECURITY_ALERT_LIMITS,
  SECURITY_ALERT_RULES,
  SECURITY_LOG_CATEGORIES,
  type AuditEntryDto,
  type SecurityAlertDto,
  type SecurityAlertRule,
  type SecurityAlertSettingsDto,
  type SecurityLogCategory,
} from "@sitekeep/shared";
import { api, formatDate } from "../../../shared/api/api";
import { securityLogApi, type AllEventsFilter, type SecurityLogFilter } from "../../../shared/api/api-security-log";
import { auditActionLabel, auditSummary } from "../../../shared/lib/audit";
import { useAuth } from "../../../app/context/auth";
import { useLoad } from "../../../app/context/project";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";
import { ChainStatus } from "../../project-settings/pages/ProjectAuditLog";

const PAGE = 50;
/** An alert was acknowledged or dismissed: the history below the log reloads. */
const ALERTS_CHANGED = "cde:security-alerts-changed";

/** Title and one-line text of an alert. */
function useAlertText() {
  const { t } = useTranslation("admin");
  return (a: Pick<SecurityAlertDto, "rule" | "details">) => ({
    title: t(`securityAlerts.rules.${a.rule}.title`) as string,
    body: String(t(`securityAlerts.rules.${a.rule}.body` as never, a.details as never)),
  });
}

/** Open alerts as cards (top of the Administration page); administrators acknowledge or dismiss them. */
export function SecurityAlertCards({ onShowEvent }: { onShowEvent?: (auditId: number) => void }) {
  const { t } = useTranslation("admin");
  const { user } = useAuth();
  const text = useAlertText();
  const { data, reload } = useLoad(() => securityLogApi.alerts("open"), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!data?.length) return null;

  async function handle(id: string, how: "acknowledge" | "dismiss") {
    setBusy(id);
    setError(null);
    try {
      await securityLogApi[how](id);
      reload();
      window.dispatchEvent(new Event(ALERTS_CHANGED));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack" data-testid="security-alerts" style={{ gap: 8 }}>
      {error && <p className="error">{error}</p>}
      {data.map((a) => {
        const { title, body } = text(a);
        return (
          <div key={a.id} className="card security-alert" style={{ borderLeft: "4px solid var(--danger)" }} data-testid={`security-alert-${a.rule}`}>
            <div className="row wrap" style={{ gap: 12, alignItems: "flex-start" }}>
              <div style={{ flex: "1 1 320px" }}>
                <div className="row wrap" style={{ gap: 6 }}>
                  <span className="badge danger">{t("securityAlerts.badge")}</span>
                  <strong>{title}</strong>
                </div>
                <p style={{ margin: "6px 0 4px" }}>{body}</p>
                <p className="muted small" style={{ margin: 0 }}>
                  {[
                    formatDate(a.createdAt),
                    a.userName ? t("securityAlerts.person", { name: a.userName }) : null,
                    a.occurrences > 1 ? t("securityAlerts.occurrences", { count: a.occurrences, date: formatDate(a.lastSeenAt) }) : null,
                    a.mailedAt ? t("securityAlerts.mailed") : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                {a.auditId && onShowEvent && (
                  <button className="small" onClick={() => onShowEvent(a.auditId!)}>
                    {t("securityAlerts.actions.showEvent")}
                  </button>
                )}
                {user?.isAdmin && (
                  <>
                    <button className="small primary" disabled={busy === a.id} onClick={() => void handle(a.id, "acknowledge")}>
                      {t("securityAlerts.actions.acknowledge")}
                    </button>
                    <button className="small" disabled={busy === a.id} onClick={() => void handle(a.id, "dismiss")}>
                      {t("securityAlerts.actions.dismiss")}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })}
      <p className="muted small" style={{ margin: 0 }}>
        {t("securityAlerts.notification")}
      </p>
    </div>
  );
}

type Scope = "security" | "all";

/** The Security Log tab. `focus` shows one audit row (an alert's "Show Event"). */
export function AdminSecurityLogSection({ focus, onFocusCleared }: { focus?: number | null; onFocusCleared?: () => void }) {
  const { t } = useTranslation(["admin", "projectSettings", "common"]);
  const [scope, setScope] = useState<Scope>("security");
  const [filter, setFilter] = useState<SecurityLogFilter>({});
  const [allFilter, setAllFilter] = useState<AllEventsFilter>({});
  const [entries, setEntries] = useState<AuditEntryDto[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { data: people } = useLoad(() => api.users(), []);
  const { data: projects } = useLoad(() => (scope === "all" ? securityLogApi.projects() : Promise.resolve(null)), [scope]);

  useEffect(() => {
    if (focus) {
      setScope("security");
      setFilter({ id: focus });
    }
  }, [focus]);

  const fetchPage = (c?: number | null) => (scope === "security" ? securityLogApi.page(filter, c, PAGE) : securityLogApi.allEvents(allFilter, c, PAGE));

  useEffect(() => {
    let alive = true;
    setEntries(null);
    setError(null);
    fetchPage().then(
      (p) => {
        if (!alive) return;
        setEntries(p.entries);
        setCursor(p.nextCursor);
      },
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, JSON.stringify(filter), JSON.stringify(allFilter)]);

  async function more() {
    if (!cursor) return;
    setLoading(true);
    try {
      const p = await fetchPage(cursor);
      setEntries((prev) => [...(prev ?? []), ...p.entries]);
      setCursor(p.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const set = (p: Partial<SecurityLogFilter>) => setFilter((f) => ({ ...f, ...p }));
  const setAll = (p: Partial<AllEventsFilter>) => setAllFilter((f) => ({ ...f, ...p }));
  const current = scope === "security" ? filter : allFilter;
  const setCurrent = (p: { from?: string; to?: string; userId?: string }) => (scope === "security" ? set(p) : setAll(p));

  return (
    <div className="stack" data-testid="security-log">
      <ChainStatus />
      <div className="card stack">
        <div className="row wrap" style={{ gap: 8 }}>
          <h2 style={{ margin: 0 }}>{t("securityLog.title")}</h2>
          <div className="spacer" />
          {(["security", "all"] as const).map((s) => (
            <button key={s} className={scope === s ? "primary" : ""} onClick={() => setScope(s)}>
              {t(`securityLog.scopes.${s}`)}
            </button>
          ))}
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          {scope === "security" ? t("securityLog.description") : t("securityLog.allDescription")}
        </p>
        {scope === "security" && filter.id && (
          <p className="small" style={{ margin: 0 }}>
            {t("securityLog.onlyEntry", { id: filter.id })}{" "}
            <button
              className="link-button"
              onClick={() => {
                set({ id: undefined });
                onFocusCleared?.();
              }}
            >
              {t("projectSettings:auditLog.filters.clear")}
            </button>
          </p>
        )}
        <div className="row wrap" style={{ alignItems: "flex-end", gap: 8 }}>
          {scope === "security" ? (
            <div>
              <label htmlFor="seclog-type">{t("securityLog.filters.type")}</label>
              <select id="seclog-type" value={filter.type ?? ""} onChange={(e) => set({ type: (e.target.value || undefined) as SecurityLogCategory | undefined })}>
                <option value="">{t("projectSettings:auditLog.filters.all")}</option>
                {SECURITY_LOG_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`securityLog.types.${c}`)}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label htmlFor="seclog-project">{t("securityLog.filters.project")}</label>
              <select id="seclog-project" value={allFilter.projectId ?? ""} onChange={(e) => setAll({ projectId: e.target.value || undefined })}>
                <option value="">{t("projectSettings:auditLog.filters.all")}</option>
                {(projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label htmlFor="seclog-user">{t("projectSettings:auditLog.filters.person")}</label>
            <select id="seclog-user" value={current.userId ?? ""} onChange={(e) => setCurrent({ userId: e.target.value || undefined })}>
              <option value="">{t("projectSettings:auditLog.filters.all")}</option>
              {(people ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="seclog-from">{t("projectSettings:auditLog.filters.from")}</label>
            <input id="seclog-from" type="date" value={current.from ?? ""} onChange={(e) => setCurrent({ from: e.target.value || undefined })} />
          </div>
          <div>
            <label htmlFor="seclog-to">{t("projectSettings:auditLog.filters.to")}</label>
            <input id="seclog-to" type="date" value={current.to ?? ""} onChange={(e) => setCurrent({ to: e.target.value || undefined })} />
          </div>
          {scope === "security" && (
            <div>
              <label htmlFor="seclog-ip">{t("securityLog.filters.ip")}</label>
              <IpInput value={filter.ip ?? ""} onChange={(ip) => set({ ip: ip || undefined })} />
            </div>
          )}
          <div className="spacer" />
          <a className="btn" href={scope === "security" ? securityLogApi.csvUrl(filter) : securityLogApi.allEventsCsvUrl(allFilter)} download>
            {t("projectSettings:auditLog.downloadCsv")}
          </a>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-scroll">
          <table className="phone-cards">
            <thead>
              <tr>
                <th style={{ width: 140 }}>{t("projectSettings:activity.columns.time")}</th>
                <th style={{ width: 150 }}>{t("projectSettings:activity.columns.person")}</th>
                <th style={{ width: 200 }}>{t("projectSettings:activity.columns.action")}</th>
                <th>{t("projectSettings:activity.columns.details")}</th>
                <th style={{ width: 90 }}>{t("securityLog.columns.project")}</th>
                <th style={{ width: 140 }}>{t("projectSettings:auditLog.columns.client")}</th>
              </tr>
            </thead>
            <tbody>
              {entries?.map((e) => (
                <tr key={e.id}>
                  <td className="muted small" data-label={t("projectSettings:activity.columns.time")}>
                    {formatDate(e.at)}
                  </td>
                  <td data-label={t("projectSettings:activity.columns.person")}>{e.userName ?? t("common:dash")}</td>
                  <td data-label={t("projectSettings:activity.columns.action")}>{auditActionLabel(e.action)}</td>
                  <td
                    className="muted small"
                    data-label={t("projectSettings:activity.columns.details")}
                    style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={e.details ? JSON.stringify(e.details) : undefined}
                  >
                    {auditSummary(e)}
                  </td>
                  <td className="small" data-label={t("securityLog.columns.project")}>
                    {e.projectCode ?? t("common:dash")}
                  </td>
                  <td className="muted small mono" data-label={t("projectSettings:auditLog.columns.client")} title={e.userAgent ?? undefined}>
                    {e.ip ?? (e.personalRemoved ? t(`projectSettings:auditLog.personalRemoved.${e.personalRemoved}`) : t("common:dash"))}
                  </td>
                </tr>
              ))}
              {entries && !entries.length && (
                <tr>
                  <td colSpan={6} className="muted">
                    {t("projectSettings:auditLog.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {!entries && !error && <LoadingIndicator />}
      </div>
      {cursor && (
        <div>
          <button disabled={loading} onClick={() => void more()}>
            {t("projectSettings:auditLog.more")}
          </button>
        </div>
      )}
      <AlertHistory />
    </div>
  );
}

/** The IP filter applies when the field is left or Enter is pressed (not on every key). */
function IpInput({ value, onChange }: { value: string; onChange(v: string): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      id="seclog-ip"
      value={draft}
      placeholder="10.0.4."
      style={{ width: 150 }}
      onChange={(e) => setDraft(e.target.value.replace(/[^0-9a-fA-F.:]/g, ""))}
      onBlur={() => draft !== value && onChange(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onChange(draft);
        }
      }}
    />
  );
}

/** Recent alerts with their status (handled ones included). */
function AlertHistory() {
  const { t } = useTranslation(["admin", "common"]);
  const text = useAlertText();
  const { data, reload } = useLoad(() => securityLogApi.alerts("all", 20), []);
  useEffect(() => {
    window.addEventListener(ALERTS_CHANGED, reload);
    return () => window.removeEventListener(ALERTS_CHANGED, reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!data?.length) return null;
  return (
    <div className="card" data-testid="security-alert-history">
      <h2 style={{ marginTop: 0 }}>{t("securityAlerts.history")}</h2>
      <table className="phone-cards">
        <thead>
          <tr>
            <th style={{ width: 140 }}>{t("securityAlerts.columns.time")}</th>
            <th>{t("securityAlerts.columns.alert")}</th>
            <th style={{ width: 150 }}>{t("securityAlerts.columns.person")}</th>
            <th style={{ width: 220 }}>{t("securityAlerts.columns.status")}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((a) => (
            <tr key={a.id}>
              <td className="muted small" data-label={t("securityAlerts.columns.time")}>
                {formatDate(a.createdAt)}
              </td>
              <td data-label={t("securityAlerts.columns.alert")} title={text(a).body}>
                {text(a).title}
              </td>
              <td data-label={t("securityAlerts.columns.person")}>{a.userName ?? t("common:dash")}</td>
              <td data-label={t("securityAlerts.columns.status")}>
                <span className={`badge ${a.status === "open" ? "danger" : a.status === "acknowledged" ? "ok" : ""}`}>{t(`securityAlerts.status.${a.status}`)}</span>
                {a.handledByName && <span className="muted small"> {t("securityAlerts.handledBy", { name: a.handledByName })}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type NumberKey = keyof typeof SECURITY_ALERT_LIMITS;
const NUMBER_FIELDS: NumberKey[] = ["failedSignInsAccount", "failedSignInsGlobal", "failedSignInsWindowMinutes", "bulkDownloadFiles", "bulkDownloadWindowMinutes"];

/** Administration → Sign-in Security → Security Alerts: rules, thresholds and recipients. */
export function SecurityAlertSettingsCard() {
  const { t } = useTranslation(["admin", "common"]);
  const { data } = useLoad(() => securityLogApi.alertSettings(), []);
  const [form, setForm] = useState<SecurityAlertSettingsDto | null>(null);
  const [emails, setEmails] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    setForm(data);
    setEmails(data.emailTo.join("\n"));
  }, [data]);

  if (!form) return <LoadingIndicator />;

  const toggleRule = (rule: SecurityAlertRule, on: boolean) =>
    setForm({ ...form, disabledRules: on ? form.disabledRules.filter((r) => r !== rule) : [...form.disabledRules, rule] });

  async function save() {
    if (!form) return;
    setBusy(true);
    setMsg(null);
    try {
      const { mail: _mail, ...settings } = form;
      const next = await securityLogApi.saveAlertSettings({
        ...settings,
        emailTo: emails
          .split(/[\s,;]+/)
          .map((e) => e.trim())
          .filter(Boolean),
      });
      setForm(next);
      setEmails(next.emailTo.join("\n"));
      setMsg({ ok: true, text: t("security.saved") });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" data-testid="security-alert-settings">
      <h2 style={{ marginTop: 0 }}>{t("securityAlerts.settings.title")}</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("securityAlerts.settings.description")}
      </p>
      <h3>{t("securityAlerts.settings.rules")}</h3>
      <div className="stack" style={{ gap: 4 }}>
        {SECURITY_ALERT_RULES.map((rule) => (
          <label key={rule} className="row" style={{ color: "var(--text)", fontSize: 13, margin: 0 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={!form.disabledRules.includes(rule)} onChange={(e) => toggleRule(rule, e.target.checked)} />{" "}
            {t(`securityAlerts.rules.${rule}.title`)}
          </label>
        ))}
      </div>
      <h3>{t("securityAlerts.settings.thresholds")}</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {NUMBER_FIELDS.map((k) => (
          <div key={k}>
            <label htmlFor={`alert-${k}`}>{t(`securityAlerts.settings.fields.${k}`)}</label>
            <input
              id={`alert-${k}`}
              type="number"
              min={SECURITY_ALERT_LIMITS[k][0]}
              max={SECURITY_ALERT_LIMITS[k][1]}
              value={form[k]}
              onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })}
            />
          </div>
        ))}
      </div>
      <h3>{t("securityAlerts.settings.email")}</h3>
      <label htmlFor="alert-email-to">{t("securityAlerts.settings.emailTo")}</label>
      <textarea id="alert-email-to" rows={3} value={emails} onChange={(e) => setEmails(e.target.value)} />
      <p className="muted small">
        {form.mail ? t(`securityAlerts.settings.mail.${form.mail}`) : t("securityAlerts.settings.mail.ok")} {t("securityAlerts.settings.emailHelp")}
      </p>
      {msg && <p className={msg.ok ? "success" : "error"}>{msg.text}</p>}
      <div className="dialog-actions">
        <button className="primary" disabled={busy} onClick={() => void save()}>
          {t("common:actions.save")}
        </button>
      </div>
    </div>
  );
}
