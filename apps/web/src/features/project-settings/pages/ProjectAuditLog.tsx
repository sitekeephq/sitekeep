/**
 * Proje Ayarları → Denetim Kaydı (docs/features/AUDIT_LOG.md): the project's append-only audit log
 * with filters, pages, CSV download and, for system administrators, the hash-chain check.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AuditEntryDto, AuditVerifyDto } from "@sitekeep/shared";
import { api, formatDate } from "../../../shared/api/api";
import { auditApi, type AuditFilter } from "../../../shared/api/api-audit";
import { auditActionLabel, auditSummary } from "../../../shared/lib/audit";
import { useAuth } from "../../../app/context/auth";
import { useLoad, useProject } from "../../../app/context/project";

const PAGE = 50;

/** Action groups of the filter: a prefix ("file.*") or one action. */
const ACTION_GROUPS = ["file.*", "file.viewed", "file.downloaded", "file.moved", "cde.*", "folder.*", "member.*", "invitation.*", "role.*", "review.*", "issue.*", "project.*", "audit.*"] as const;

export function AuditLog() {
  const { t } = useTranslation("projectSettings");
  const project = useProject();
  const { user } = useAuth();
  const { data: members } = useLoad(() => api.members(project.id), [project.id]);
  const [filter, setFilter] = useState<AuditFilter>({});
  const [entries, setEntries] = useState<AuditEntryDto[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    auditApi.project(project.id, filter, null, PAGE).then(
      (p) => alive && (setEntries(p.entries), setCursor(p.nextCursor), setLoading(false)),
      (e: Error) => alive && (setError(e.message), setLoading(false)),
    );
    return () => {
      alive = false;
    };
  }, [project.id, filter]);

  async function more() {
    if (!cursor) return;
    setLoading(true);
    try {
      const p = await auditApi.project(project.id, filter, cursor, PAGE);
      setEntries((prev) => [...(prev ?? []), ...p.entries]);
      setCursor(p.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const set = (p: Partial<AuditFilter>) => setFilter((f) => ({ ...f, ...p }));
  return (
    <div className="stack">
      {user?.isAdmin && <ChainStatus />}
      <div className="card stack">
        <p className="muted small" style={{ margin: 0 }}>
          {t("auditLog.description")}
        </p>
        <div className="row wrap" style={{ alignItems: "flex-end", gap: 8 }}>
          <div>
            <label htmlFor="audit-from">{t("auditLog.filters.from")}</label>
            <input id="audit-from" type="date" value={filter.from ?? ""} onChange={(e) => set({ from: e.target.value || undefined })} />
          </div>
          <div>
            <label htmlFor="audit-to">{t("auditLog.filters.to")}</label>
            <input id="audit-to" type="date" value={filter.to ?? ""} onChange={(e) => set({ to: e.target.value || undefined })} />
          </div>
          <div>
            <label htmlFor="audit-action">{t("auditLog.filters.action")}</label>
            <select id="audit-action" value={filter.action ?? ""} onChange={(e) => set({ action: e.target.value || undefined })}>
              <option value="">{t("auditLog.filters.all")}</option>
              {ACTION_GROUPS.map((a) => (
                <option key={a} value={a}>
                  {a.endsWith(".*") ? t(`auditLog.groups.${a.slice(0, -2)}` as never) : auditActionLabel(a)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="audit-user">{t("auditLog.filters.person")}</label>
            <select id="audit-user" value={filter.userId ?? ""} onChange={(e) => set({ userId: e.target.value || undefined })}>
              <option value="">{t("auditLog.filters.all")}</option>
              {(members ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="spacer" />
          <a className="btn" href={auditApi.projectCsvUrl(project.id, filter)} download>
            {t("auditLog.downloadCsv")}
          </a>
        </div>
        {filter.targetId && (
          <p className="small" style={{ margin: 0 }}>
            {t("auditLog.filters.target", { id: filter.targetId })}{" "}
            <button className="link-button" onClick={() => set({ targetType: undefined, targetId: undefined })}>
              {t("auditLog.filters.clear")}
            </button>
          </p>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-scroll">
          <table className="phone-cards">
            <thead>
              <tr>
                <th style={{ width: 140 }}>{t("activity.columns.time")}</th>
                <th style={{ width: 160 }}>{t("activity.columns.person")}</th>
                <th style={{ width: 200 }}>{t("activity.columns.action")}</th>
                <th>{t("activity.columns.details")}</th>
                <th style={{ width: 140 }}>{t("auditLog.columns.client")}</th>
              </tr>
            </thead>
            <tbody>
              {entries?.map((e) => (
                <tr key={e.id}>
                  <td className="muted small" data-label={t("activity.columns.time")}>
                    {formatDate(e.at)}
                  </td>
                  <td data-label={t("activity.columns.person")}>{e.userName ?? "—"}</td>
                  <td data-label={t("activity.columns.action")}>{auditActionLabel(e.action)}</td>
                  <td
                    className="muted small"
                    data-label={t("activity.columns.details")}
                    style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={e.details ? JSON.stringify(e.details) : undefined}
                  >
                    {e.targetId && e.targetType ? (
                      <button className="link-button" title={t("auditLog.onlyThisTarget")} onClick={() => set({ targetType: e.targetType!, targetId: e.targetId! })}>
                        {auditSummary(e) || e.targetId}
                      </button>
                    ) : (
                      auditSummary(e)
                    )}
                  </td>
                  <td className="muted small mono" data-label={t("auditLog.columns.client")} title={e.userAgent ?? undefined}>
                    {e.ip ?? (e.personalRemoved ? t(`auditLog.personalRemoved.${e.personalRemoved}`) : "—")}
                  </td>
                </tr>
              ))}
              {entries && !entries.length && (
                <tr>
                  <td colSpan={5} className="muted">
                    {t("auditLog.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {cursor && (
        <div>
          <button disabled={loading} onClick={() => void more()}>
            {t("auditLog.more")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Hash-chain check (system administrators): walks the whole log on the server. */
export function ChainStatus() {
  const { t } = useTranslation("projectSettings");
  const [result, setResult] = useState<AuditVerifyDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      setResult(await auditApi.verify());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card row wrap" style={{ gap: 8, alignItems: "center" }} data-testid="audit-chain">
      <strong>{t("auditLog.chain.heading")}</strong>
      {result &&
        (result.ok ? (
          <span className="badge ok">{t("auditLog.chain.ok", { count: result.checked })}</span>
        ) : (
          <span className="badge danger">{t("auditLog.chain.broken", { id: result.broken!.id, reason: t(`auditLog.chain.reasons.${result.broken!.reason}`) })}</span>
        ))}
      {result?.truncated && <span className="muted small">{t("auditLog.chain.truncated", { date: result.truncated.before.slice(0, 10) })}</span>}
      {result?.head && (
        <span className="muted small mono" title={result.head.hash}>
          {t("auditLog.chain.head", { hash: result.head.hash.slice(0, 16) })}
        </span>
      )}
      {error && <span className="error">{error}</span>}
      <div className="spacer" />
      <button disabled={busy} onClick={() => void check()}>
        {t("auditLog.chain.check")}
      </button>
    </div>
  );
}
