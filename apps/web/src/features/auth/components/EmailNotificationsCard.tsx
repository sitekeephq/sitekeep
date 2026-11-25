/**
 * Workflow e-mail per notification type (docs/features/WORKFLOW_EMAIL.md). Account: every person picks
 * "project default / on / off" per type; Project Settings: the project administrator sets the default
 * (on / off) for members who made no choice.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EMAIL_NOTIFY_TYPES, type EmailNotifyPrefs, type EmailNotifyType } from "@sitekeep/shared";
import { hubApi } from "../../../shared/api/api-hub";
import { useLoad } from "../../../app/context/project";

type Choice = "inherit" | "on" | "off";
const toChoice = (v: boolean | undefined): Choice => (v === undefined ? "inherit" : v ? "on" : "off");
const fromChoice = (c: Choice): boolean | undefined => (c === "inherit" ? undefined : c === "on");

export function EmailNotificationsCard({ projectId }: { projectId?: string }) {
  const { t } = useTranslation("auth");
  const project = !!projectId;
  const { data: prefs, setData } = useLoad(
    (): Promise<EmailNotifyPrefs> => (projectId ? hubApi.projectEmailDefaults(projectId) : hubApi.prefs().then((p) => p.emailNotifications ?? {})),
    [projectId],
  );
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function choose(type: EmailNotifyType, choice: Choice) {
    setMsg(null);
    const value = fromChoice(choice);
    try {
      if (projectId) setData(await hubApi.setProjectEmailDefaults(projectId, { [type]: value !== false }));
      else {
        // An "inherit" choice removes the user's own value: the server merges, so send it as a full object.
        const next: EmailNotifyPrefs = { ...(prefs ?? {}) };
        if (value === undefined) delete next[type];
        else next[type] = value;
        const saved = await hubApi.setPrefs({ emailNotifications: next });
        setData(saved.emailNotifications ?? {});
      }
      setMsg({ ok: true, text: t("account.emailNotifications.saved") });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  return (
    <div className="card stack" data-testid={project ? "project-email-notifications" : "email-notifications"}>
      <h2>{t("account.emailNotifications.heading")}</h2>
      <p className="muted" style={{ margin: 0 }}>
        {t(project ? "account.emailNotifications.projectDescription" : "account.emailNotifications.description")}
      </p>
      {prefs && (
        <div className="stack">
          {EMAIL_NOTIFY_TYPES.map((type) => (
            <div key={type} className="row wrap" style={{ alignItems: "center" }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <strong>{t(`account.emailNotifications.types.${type}.label`)}</strong>
                <div className="muted small">{t(`account.emailNotifications.types.${type}.help`)}</div>
              </div>
              {project ? (
                <label className="check" style={{ margin: 0 }}>
                  <input type="checkbox" checked={prefs[type] !== false} onChange={(e) => void choose(type, e.target.checked ? "on" : "off")} />{" "}
                  {t("account.emailNotifications.choice.on")}
                </label>
              ) : (
                <select
                  aria-label={t(`account.emailNotifications.types.${type}.label`)}
                  value={toChoice(prefs[type])}
                  onChange={(e) => void choose(type, e.target.value as Choice)}
                >
                  {(["inherit", "on", "off"] as const).map((c) => (
                    <option key={c} value={c}>
                      {t(`account.emailNotifications.choice.${c}`)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </div>
      )}
      {msg && <p className={msg.ok ? "success" : "error"}>{msg.text}</p>}
    </div>
  );
}
