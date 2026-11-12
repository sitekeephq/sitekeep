/**
 * Yönetim → Gizlilik Merkezi: what leaves the server (nothing by default), every external
 * connection with an on/off switch, the outbound log and "Tüm Dış Bağlantıları Kapat".
 * docs/features/PRIVACY.md.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  privacyStatement,
  type OutboundLogPageDto,
  type OutboundLogRowDto,
  type PrivacyAiMode,
  type PrivacyConnectionDto,
  type PrivacySummaryDto,
} from "@sitekeep/shared";
import { formatDate, formatNumber, formatSize } from "../../../shared/api/api";
import { PRIVACY_CHANGED_EVENT, privacyApi, type OutboundFilter } from "../../../shared/api/api-privacy";
import { useLoad } from "../../../app/context/project";
import { i18n } from "../../../i18n";
import { ConfirmDialog } from "../../../shared/ui/Dialog";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";

type Section = "summary" | "connections" | "log";

const SECTIONS: Section[] = ["summary", "connections", "log"];

const AI_MODE_KEY = {
  off: "privacy.aiModes.off",
  local_only: "privacy.aiModes.localOnly",
  allow_external: "privacy.aiModes.allowExternal",
} as const satisfies Record<PrivacyAiMode, string>;

export function AdminPrivacySection() {
  const { t } = useTranslation("admin");
  const { data, error, setData } = useLoad(() => privacyApi.summary(), []);
  const [section, setSection] = useState<Section>("summary");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<{ on: boolean; title: string; message: string; confirmLabel: string } | null>(null);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <LoadingIndicator />;

  function requestToggle(on: boolean) {
    setAsk({
      on,
      title: on ? t("privacy.kill.title") : t("privacy.kill.reopenTitle"),
      message: on ? t("privacy.kill.confirmOff") : t("privacy.kill.confirmOn"),
      confirmLabel: on ? t("privacy.kill.actions.turnOff") : t("privacy.kill.actions.reopen"),
    });
  }

  async function toggleKill(on: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      setData(await privacyApi.setKillSwitch(on));
      window.dispatchEvent(new Event(PRIVACY_CHANGED_EVENT));
      setAsk(null);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const kill = data.killSwitch;
  return (
    <div className="stack">
      <div className={`card privacy-kill${kill.on ? " on" : ""}`}>
        <div className="row wrap" style={{ gap: 12 }}>
          <div style={{ flex: "1 1 320px" }}>
            <h2 style={{ margin: "0 0 4px" }}>{t("privacy.kill.title")}</h2>
            <p className="muted small" style={{ margin: 0 }}>
              {kill.on
                ? kill.at
                  ? kill.byName
                    ? t("privacy.kill.onSinceBy", { date: formatDate(kill.at), name: kill.byName })
                    : t("privacy.kill.onSince", { date: formatDate(kill.at) })
                  : t("privacy.kill.on")
                : t("privacy.kill.off")}
            </p>
          </div>
          {kill.on ? (
            <button className="primary" disabled={busy} onClick={() => requestToggle(false)}>
              {t("privacy.kill.actions.reopenAll")}
            </button>
          ) : (
            <button className="danger" disabled={busy} onClick={() => requestToggle(true)}>
              {t("privacy.kill.actions.turnOffAll")}
            </button>
          )}
        </div>
        {msg && <p className="error">{msg}</p>}
      </div>

      <div className="row wrap">
        {SECTIONS.map((k) => (
          <button key={k} className={section === k ? "primary" : ""} onClick={() => setSection(k)}>
            {t(`privacy.tabs.${k}`)}
          </button>
        ))}
      </div>

      {section === "summary" ? (
        <PrivacySummary data={data} onSaved={setData} />
      ) : section === "connections" ? (
        <Connections killSwitch={kill.on} />
      ) : (
        <OutboundLog />
      )}

      {ask && (
        <ConfirmDialog
          title={ask.title}
          message={ask.message}
          confirmLabel={ask.confirmLabel}
          danger={ask.on}
          busy={busy}
          onClose={() => !busy && setAsk(null)}
          onConfirm={() => void toggleKill(ask.on)}
        />
      )}
    </div>
  );
}

function PrivacySummary({ data, onSaved }: { data: PrivacySummaryDto; onSaved(d: PrivacySummaryDto): void }) {
  const { t, i18n } = useTranslation(["admin", "common"]);
  const [days, setDays] = useState(String(data.settings.logRetentionDays));
  const [lan, setLan] = useState(data.settings.lanHosts.join("\n"));
  const [redactLocal, setRedactLocal] = useState(data.settings.redactLocal);
  const [redactNames, setRedactNames] = useState(data.settings.redactNames);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setMsg(null);
    try {
      const d = await privacyApi.saveSettings({
        logRetentionDays: Number(days),
        lanHosts: lan
          .split(/[\n,]+/)
          .map((x) => x.trim())
          .filter(Boolean),
        redactLocal,
        redactNames,
      });
      onSaved(d);
      setMsg({ ok: true, text: t("messages.saved") });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  const ai = data.ai;
  return (
    <div className="stack">
      <div className="card">
        <p style={{ marginTop: 0 }}>
          <strong>{privacyStatement(i18n.language)}</strong>
        </p>
        <table className="props-table">
          <tbody>
            <tr>
              <td>{t("privacy.summary.fields.aiMode")}</td>
              <td>
                <span className={`badge ${ai.mode === "allow_external" ? "warn" : "ok"}`}>{t(AI_MODE_KEY[ai.mode])}</span>
                {ai.mode !== ai.storedMode && (
                  <span className="muted small"> {t("privacy.summary.selectedMode", { mode: t(AI_MODE_KEY[ai.storedMode]) })}</span>
                )}
              </td>
            </tr>
            <tr>
              <td>{t("privacy.summary.fields.externalProjects")}</td>
              <td>
                {ai.externalProjects.length ? (
                  ai.externalProjects.map((p) => (
                    <span key={p.id} className="badge" style={{ marginRight: 4 }}>
                      {p.code ? `${p.code} · ` : ""}
                      {p.name}
                    </span>
                  ))
                ) : (
                  <span className="muted">{t("privacy.summary.noExternal")}</span>
                )}
                {ai.externalProjects.length > 0 && ai.mode !== "allow_external" && (
                  <span className="muted small"> {t("privacy.summary.permissionsInvalid")}</span>
                )}
              </td>
            </tr>
            <tr>
              <td>{t("privacy.summary.fields.database")}</td>
              <td>
                <code>{data.data.database}</code>
              </td>
            </tr>
            <tr>
              <td>{t("privacy.summary.fields.files")}</td>
              <td>
                <code>{data.data.storage}</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t("privacy.settings.title")}</h2>
        <label className="check">
          <input type="checkbox" checked={redactLocal} onChange={(e) => setRedactLocal(e.target.checked)} />
          {t("privacy.settings.options.redactLocal")} <span className="muted small">{t("privacy.settings.redactLocalHint")}</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={redactNames} onChange={(e) => setRedactNames(e.target.checked)} />
          {t("privacy.settings.options.redactNames")} <span className="muted small">{t("privacy.settings.redactNamesHint")}</span>
        </label>
        <p className="muted small" style={{ margin: 0 }}>
          {t("privacy.settings.always")}
        </p>
        <div style={{ maxWidth: 220 }}>
          <label htmlFor="privacy-days">{t("privacy.settings.fields.retention")}</label>
          <input id="privacy-days" type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />
        </div>
        <div>
          <label htmlFor="privacy-lan">{t("privacy.settings.fields.lanHosts")}</label>
          <textarea id="privacy-lan" rows={4} value={lan} placeholder={t("privacy.settings.lanPlaceholder")} onChange={(e) => setLan(e.target.value)} />
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            {t("privacy.settings.lanHelp")}
          </p>
        </div>
        <div className="row">
          <button className="primary" onClick={() => void save()}>
            {t("common:actions.save")}
          </button>
          {msg && <span className={msg.ok ? "muted" : "error"}>{msg.text}</span>}
        </div>
      </div>
    </div>
  );
}

const LOCATION_TONE: Record<PrivacyConnectionDto["location"], string> = { local: "ok", external: "warn", inbound: "info" };

function Connections({ killSwitch }: { killSwitch: boolean }) {
  const { t } = useTranslation(["admin", "common"]);
  const { data, error, setData } = useLoad(() => privacyApi.connections(), []);
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <LoadingIndicator />;

  async function toggle(c: PrivacyConnectionDto, enabled: boolean) {
    setMsg(null);
    try {
      setData(await privacyApi.setConnection(c.id, enabled));
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="card">
      {msg && <p className="error">{msg}</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("privacy.connections.columns.connection")}</th>
              <th>{t("privacy.connections.columns.server")}</th>
              <th>{t("common:fields.location")}</th>
              <th>{t("privacy.connections.columns.lastUsed")}</th>
              <th>{t("common:fields.status")}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((c) => {
              const stopped = killSwitch && c.location === "external";
              return (
                <tr key={c.id}>
                  <td>
                    {/* i18n: server text (connection name and notes) */}
                    <strong>{c.name}</strong>
                    {c.notes.length > 0 && <div className="muted small">{c.notes.join(" · ")}</div>}
                  </td>
                  <td>{c.host ? <code>{c.host}</code> : <span className="muted">{t("common:dash")}</span>}</td>
                  <td>
                    <span className={`badge ${LOCATION_TONE[c.location]}`} title={t(`privacy.location.${c.location}Hint`)}>
                      {c.kind === "ai" && c.location !== "inbound"
                        ? c.location === "external"
                          ? t("privacy.location.cloud")
                          : t("privacy.location.localShort")
                        : t(`privacy.location.${c.location}`)}
                    </span>
                  </td>
                  <td className="small">{c.lastUsedAt ? formatDate(c.lastUsedAt) : <span className="muted">{t("common:dash")}</span>}</td>
                  <td>
                    {c.toggleable ? (
                      <label className="check" style={{ margin: 0 }}>
                        <input type="checkbox" checked={c.enabled} onChange={(e) => void toggle(c, e.target.checked)} />
                        {t("privacy.connections.options.on")}
                      </label>
                    ) : (
                      <span className={`badge ${c.enabled ? "ok" : ""}`}>
                        {c.enabled ? t("privacy.connections.badges.on") : t("privacy.connections.badges.off")}
                      </span>
                    )}
                    {stopped && c.enabled && <div className="muted small">{t("privacy.connections.stoppedHint")}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const PAGE = 100;

function aiDetails(r: OutboundLogRowDto): string {
  const d = r.details as { feature?: string; chars?: number; redactions?: Record<string, number>; provider?: string } | null;
  if (!d) return "";
  const parts: string[] = [];
  if (d.feature) parts.push(d.feature);
  if (typeof d.chars === "number") parts.push(i18n.t("admin:privacy.log.chars", { count: d.chars, formatted: formatNumber(d.chars) }));
  const red = Object.entries(d.redactions ?? {}).filter(([, n]) => n > 0);
  if (red.length)
    parts.push(
      i18n.t("admin:privacy.log.redacted", {
        list: red.map(([k, n]) => `${i18n.t(`admin:privacy.log.redactions.${k}`, { defaultValue: k } as never)} ${n}`).join(", "),
      }),
    );
  return parts.join(" · ");
}

function OutboundLog() {
  const { t } = useTranslation(["admin", "common"]);
  const [filter, setFilter] = useState<OutboundFilter>({});
  const [page, setPage] = useState<OutboundLogPageDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    privacyApi.outbound(filter, PAGE, 0).then(
      (p) => alive && (setPage(p), setLoading(false)),
      (e: Error) => alive && (setError(e.message), setLoading(false)),
    );
    return () => {
      alive = false;
    };
  }, [filter]);

  async function more() {
    if (!page) return;
    setLoading(true);
    try {
      const next = await privacyApi.outbound(filter, PAGE, page.rows.length);
      setPage({ ...next, rows: [...page.rows, ...next.rows] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const set = (p: Partial<OutboundFilter>) => setFilter((f) => ({ ...f, ...p }));
  const dash = t("common:dash");
  return (
    <div className="card stack">
      <div className="row wrap" style={{ alignItems: "flex-end", gap: 8 }}>
        <div>
          <label htmlFor="ob-purpose">{t("privacy.log.fields.purpose")}</label>
          <select id="ob-purpose" value={filter.purpose ?? ""} onChange={(e) => set({ purpose: e.target.value || undefined })}>
            <option value="">{t("common:status.all")}</option>
            <option value="yapay_zeka">{t("privacy.log.options.aiAll")}</option>
            {(page?.purposes ?? []).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ob-host">{t("privacy.log.fields.server")}</label>
          <select id="ob-host" value={filter.host ?? ""} onChange={(e) => set({ host: e.target.value || undefined })}>
            <option value="">{t("common:status.all")}</option>
            {(page?.hosts ?? []).map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ob-from">{t("common:fields.start")}</label>
          <input id="ob-from" type="date" value={filter.from ?? ""} onChange={(e) => set({ from: e.target.value || undefined })} />
        </div>
        <div>
          <label htmlFor="ob-to">{t("common:fields.finish")}</label>
          <input id="ob-to" type="date" value={filter.to ?? ""} onChange={(e) => set({ to: e.target.value || undefined })} />
        </div>
        <label className="check" style={{ margin: 0 }}>
          <input type="checkbox" checked={!!filter.blocked} onChange={(e) => set({ blocked: e.target.checked || undefined })} />
          {t("privacy.log.options.onlyBlocked")}
        </label>
        <div className="spacer" />
        <a className="btn" href={privacyApi.csvUrl(filter)} download>
          {t("privacy.log.actions.downloadCsv")}
        </a>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        {t("privacy.log.description")}
      </p>
      {error && <p className="error">{error}</p>}
      {page && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("common:fields.time")}</th>
                  <th>{t("privacy.log.columns.purpose")}</th>
                  <th>{t("privacy.log.columns.server")}</th>
                  <th>{t("privacy.log.columns.outIn")}</th>
                  <th>{t("common:fields.result")}</th>
                  <th>{t("common:fields.duration")}</th>
                  <th>{t("privacy.log.columns.user")}</th>
                  <th>{t("common:fields.project")}</th>
                  <th>{t("privacy.log.columns.details")}</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="small">{formatDate(r.at)}</td>
                    <td>
                      <code>{r.purpose}</code>
                    </td>
                    <td>
                      <code>{r.host}</code>{" "}
                      <span className={`badge ${r.local ? "ok" : "warn"}`}>{r.local ? t("privacy.log.badges.local") : t("privacy.log.badges.external")}</span>
                    </td>
                    <td className="small">
                      {r.bytesOut != null ? formatSize(r.bytesOut) : dash} / {r.bytesIn != null ? formatSize(r.bytesIn) : dash}
                    </td>
                    <td className="small">
                      {r.blocked ? (
                        <span className="badge danger">{t("privacy.log.badges.blocked")}</span>
                      ) : r.error ? (
                        <span className="badge warn">{r.error}</span>
                      ) : r.status != null ? (
                        <span className={`badge ${r.status < 400 ? "ok" : "warn"}`}>{r.status}</span>
                      ) : (
                        <span className="badge ok">{t("privacy.log.badges.ok")}</span>
                      )}
                    </td>
                    <td className="small">{r.durationMs != null ? `${r.durationMs} ms` : dash}</td>
                    <td className="small">{r.userName ?? <span className="muted">{dash}</span>}</td>
                    <td className="small">{r.projectCode ?? <span className="muted">{dash}</span>}</td>
                    <td className="small muted">{aiDetails(r)}</td>
                  </tr>
                ))}
                {!page.rows.length && (
                  <tr>
                    <td colSpan={9} className="muted">
                      {t("privacy.log.empty")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="row">
            <span className="muted small">{t("privacy.log.count", { shown: page.rows.length, total: page.total })}</span>
            {page.rows.length < page.total && (
              <button disabled={loading} onClick={() => void more()}>
                {t("common:actions.showMore")}
              </button>
            )}
          </div>
        </>
      )}
      {!page && loading && <LoadingIndicator />}
    </div>
  );
}
