/**
 * Yönetim → Gizlilik Merkezi → Saklama: recycle bin auto-purge, audit log retention, the cleanups
 * that always run, and the disposal record CSV (docs/features/DATA_SUBJECT_RIGHTS.md#retention).
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AUDIT_LOG_RETENTION, TRASH_PURGE_DAYS, type PrivacySummaryDto } from "@sitekeep/shared";
import { privacyApi, subjectApi } from "../../../shared/api/api-privacy";

const AUDIT_YEAR_CHOICES = [1, 2, 3, 5, 7, 10, 15, 20, 30].filter((y) => y >= AUDIT_LOG_RETENTION.min && y <= AUDIT_LOG_RETENTION.max);

export function RetentionSection({ data, onSaved }: { data: PrivacySummaryDto; onSaved(d: PrivacySummaryDto): void }) {
  const { t, i18n } = useTranslation(["admin", "common"]);
  const [trash, setTrash] = useState(data.settings.trashPurgeDays === null ? "" : String(data.settings.trashPurgeDays));
  const [auditYears, setAuditYears] = useState(data.settings.auditLogRetentionYears === null ? "" : String(data.settings.auditLogRetentionYears));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setMsg(null);
    try {
      const d = await privacyApi.saveSettings({
        trashPurgeDays: trash ? Number(trash) : null,
        auditLogRetentionYears: auditYears ? Number(auditYears) : null,
      });
      onSaved(d);
      setMsg({ ok: true, text: t("messages.saved") });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  return (
    <div className="stack">
      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t("privacy.retention.title")}</h2>
        <p className="muted small" style={{ margin: 0 }}>
          {t("privacy.retention.intro")}
        </p>
        <div>
          <div style={{ maxWidth: 260 }}>
            <label htmlFor="retention-trash">{t("privacy.retention.fields.trash")}</label>
            <select id="retention-trash" value={trash} onChange={(e) => setTrash(e.target.value)}>
              <option value="">{t("privacy.retention.off")}</option>
              {TRASH_PURGE_DAYS.map((d) => (
                <option key={d} value={d}>
                  {t("privacy.retention.days", { count: d })}
                </option>
              ))}
            </select>
          </div>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            {t("privacy.retention.trashHelp")}
          </p>
        </div>
        <div>
          <div style={{ maxWidth: 260 }}>
            <label htmlFor="retention-audit">{t("privacy.retention.fields.auditLog")}</label>
            <select id="retention-audit" value={auditYears} onChange={(e) => setAuditYears(e.target.value)}>
              <option value="">{t("privacy.retention.unlimited")}</option>
              {AUDIT_YEAR_CHOICES.map((y) => (
                <option key={y} value={y}>
                  {t("privacy.retention.years", { count: y })}
                </option>
              ))}
            </select>
          </div>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            {t("privacy.retention.auditLogHelp", { min: AUDIT_LOG_RETENTION.min })}
          </p>
        </div>
        <div className="row">
          <button className="primary" onClick={() => void save()}>
            {t("common:actions.save")}
          </button>
          {msg && <span className={msg.ok ? "muted" : "error"}>{msg.text}</span>}
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t("privacy.retention.alwaysTitle")}</h2>
        <ul style={{ margin: 0 }}>
          <li>{t("privacy.retention.always.outbound", { days: data.settings.logRetentionDays })}</li>
          <li>{t("privacy.retention.always.auditPersonal", { months: data.settings.auditPersonalRetentionMonths })}</li>
          <li>{t("privacy.retention.always.credentials")}</li>
          <li>{t("privacy.retention.always.invitations")}</li>
          <li>{t("privacy.retention.always.exports")}</li>
        </ul>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t("privacy.retention.disposalTitle")}</h2>
        <p className="muted small" style={{ margin: 0 }}>
          {t("privacy.retention.disposalHelp")}
        </p>
        <div className="row">
          <a className="btn" href={subjectApi.disposalsCsvUrl(i18n.language)} download>
            {t("privacy.retention.disposalCsv")}
          </a>
        </div>
      </div>
    </div>
  );
}
