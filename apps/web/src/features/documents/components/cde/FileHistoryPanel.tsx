/**
 * Denetim Geçmişi of a file in the file drawer (ISO-4, docs/features/AUDIT_LOG.md): who viewed,
 * downloaded, moved, changed or approved the file and its versions, newest first. Loaded when
 * opened; IP and user agent are shown to project administrators only (the server leaves them out
 * for others).
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AuditEntryDto } from "@sitekeep/shared";
import { formatDate } from "../../../../shared/api/api";
import { auditApi } from "../../../../shared/api/api-audit";
import { auditActionLabel, auditSummary } from "../../../../shared/lib/audit";
import type { FileCdeSlotProps } from "./FileCdeSlots";

const PAGE = 20;

export function FileHistoryPanel({ projectId, file }: Pick<FileCdeSlotProps, "projectId" | "file">) {
  const { t } = useTranslation("cde");
  const [entries, setEntries] = useState<AuditEntryDto[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(from: number | null) {
    setLoading(true);
    setError(null);
    try {
      const p = await auditApi.fileHistory(projectId, file.id, from, PAGE);
      setEntries((prev) => (from ? [...(prev ?? []), ...p.entries] : p.entries));
      setCursor(p.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <details
      className="file-audit-history"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && entries === null && !loading) void load(null);
      }}
    >
      <summary>
        <h3 style={{ display: "inline" }}>{t("audit.history.heading")}</h3>
      </summary>
      {error && <p className="error">{error}</p>}
      {entries && !entries.length && <p className="muted small">{t("audit.history.empty")}</p>}
      {entries && entries.length > 0 && (
        <table className="phone-cards">
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td data-label={t("audit.history.when")} className="muted small" style={{ width: 120 }}>
                  {formatDate(e.at)}
                </td>
                <td data-label={t("audit.history.who")}>
                  <div>{e.userName ?? t("audit.history.system")}</div>
                  {e.ip && (
                    <div className="muted small mono" title={e.userAgent ?? undefined}>
                      {e.ip}
                    </div>
                  )}
                </td>
                <td data-label={t("audit.history.what")}>
                  <div>{auditActionLabel(e.action)}</div>
                  <div className="muted small">{auditSummary({ ...e, targetName: undefined })}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {loading && <p className="muted small">{t("audit.history.loading")}</p>}
      {cursor && !loading && (
        <button className="small" onClick={() => void load(cursor)}>
          {t("audit.history.more")}
        </button>
      )}
    </details>
  );
}
