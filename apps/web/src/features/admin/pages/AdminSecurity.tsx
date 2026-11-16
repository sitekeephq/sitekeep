/** Administration → Sign-in security (docs/features/SIGN_IN_SECURITY.md). */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SIGN_IN_SECURITY_LIMITS, type SignInSecuritySettings, type TwoFactorRequirement } from "@sitekeep/shared";
import { securityApi } from "../../../shared/api/api-security";
import { useLoad } from "../../../app/context/project";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";
import { AdminOidcSection } from "./AdminOidc";
import { SecurityAlertSettingsCard } from "./AdminSecurityLog";

type NumberKey = keyof typeof SIGN_IN_SECURITY_LIMITS;
const NUMBER_FIELDS: NumberKey[] = ["failureLimit", "ipFailureLimit", "failureWindowMinutes", "sessionAbsoluteDays", "sessionIdleHours"];

export function AdminSecuritySection() {
  const { t } = useTranslation(["admin", "common"]);
  const { data, reload } = useLoad(() => securityApi.settings(), []);
  const [form, setForm] = useState<SignInSecuritySettings | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  if (!form) return <LoadingIndicator />;

  async function save() {
    if (!form) return;
    setBusy(true);
    setMsg(null);
    try {
      setForm(await securityApi.updateSettings(form));
      setMsg({ ok: true, text: t("security.saved") });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" data-testid="admin-security">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t("security.title")}</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          {t("security.description")}
        </p>

        <h3>{t("security.twoFactor.heading")}</h3>
        <label htmlFor="require-two-factor">{t("security.twoFactor.require")}</label>
        <select
          id="require-two-factor"
          value={form.requireTwoFactor}
          onChange={(e) => setForm({ ...form, requireTwoFactor: e.target.value as TwoFactorRequirement })}
        >
          <option value="off">{t("security.twoFactor.options.off")}</option>
          <option value="admins">{t("security.twoFactor.options.admins")}</option>
          <option value="all">{t("security.twoFactor.options.all")}</option>
        </select>
        <p className="muted small">{t("security.twoFactor.help")}</p>

        <h3>{t("security.limits.heading")}</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          {NUMBER_FIELDS.map((k) => (
            <div key={k}>
              <label htmlFor={`security-${k}`}>{t(`security.fields.${k}`)}</label>
              <input
                id={`security-${k}`}
                type="number"
                min={SIGN_IN_SECURITY_LIMITS[k][0]}
                max={SIGN_IN_SECURITY_LIMITS[k][1]}
                value={form[k]}
                onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })}
              />
              <div className="muted small">{t(`security.help.${k}`)}</div>
            </div>
          ))}
        </div>
        {msg && <p className={msg.ok ? "success" : "error"}>{msg.text}</p>}
        <div className="dialog-actions">
          <button className="primary" disabled={busy} onClick={() => void save()}>
            {t("common:actions.save")}
          </button>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t("security.unlock.heading")}</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          {t("security.unlock.description")}
        </p>
        <button
          disabled={busy}
          onClick={() =>
            void securityApi.unlock().then(
              () => setMsg({ ok: true, text: t("security.unlock.done") }),
              (e: Error) => setMsg({ ok: false, text: e.message }),
            )
          }
        >
          {t("security.unlock.action")}
        </button>
      </div>

      <AdminOidcSection />
      <SecurityAlertSettingsCard />
    </div>
  );
}
