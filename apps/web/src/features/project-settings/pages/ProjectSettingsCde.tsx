import { useTranslation } from "react-i18next";
import type { CdeState } from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { cdeApi } from "../../../shared/api/api-cde";
import { useLoad, useProject } from "../../../app/context/project";

/**
 * Proje Ayarları → CDE: the project's ISO 19650 settings (docs/features/CDE_STATES.md). Read-only
 * for now; the sections are where the follow-up work adds editing: codes (ISO-2), transitions
 * (ISO-1) and task teams (ISO-5).
 */
export function CdeSettings() {
  const { t } = useTranslation("cde");
  const project = useProject();
  const { data: s, error } = useLoad(() => cdeApi.settings(project.id), [project.id]);
  const { data: workflows } = useLoad(() => api.workflowTemplates(project.id, "review").catch(() => []), [project.id]);
  const state = (v: CdeState | null) => (v ? t(`states.${v}`) : t("settings.transitions.upload"));
  const yesNo = (v: boolean) => (v ? t("settings.yes") : t("settings.no"));

  if (error) return <p className="error">{error}</p>;
  if (!s) return <p className="muted">…</p>;
  return (
    <div className="stack" data-testid="cde-settings">
      <p className="muted" style={{ margin: 0 }}>
        {t("settings.description")}
      </p>

      <section className="card stack" data-section="general">
        <h3 style={{ margin: 0 }}>{t("settings.general.heading")}</h3>
        <table className="props-table">
          <tbody>
            <tr>
              <td>{t("settings.general.enforceTransitions")}</td>
              <td>
                {yesNo(s.enforceTransitions)}
                <div className="muted small">{s.enforceTransitions ? t("settings.general.enforceOn") : t("settings.general.enforceOff")}</div>
              </td>
            </tr>
            <tr>
              <td>{t("settings.general.archiveFolder")}</td>
              <td>{s.archiveFolderId ? <span className="mono small">{s.archiveFolderId.slice(0, 8)}</span> : <span className="muted">{t("settings.general.notSet")}</span>}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="card stack" data-section="codes">
        <h3 style={{ margin: 0 }}>{t("settings.codes.heading")}</h3>
        <table className="props-table">
          <tbody>
            <tr>
              <td>{t("settings.codes.scheme")}</td>
              <td>{t(`schemes.${s.codeScheme}`)}</td>
            </tr>
          </tbody>
        </table>
        <p className="muted small" style={{ margin: 0 }}>
          {t("settings.codes.pending")}
        </p>
      </section>

      <section className="card stack" data-section="transitions">
        <h3 style={{ margin: 0 }}>{t("settings.transitions.heading")}</h3>
        {s.transitions.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            {t("settings.transitions.empty")}
          </p>
        ) : (
          <table className="phone-cards">
            <thead>
              <tr>
                <th>{t("settings.transitions.from")}</th>
                <th>{t("settings.transitions.to")}</th>
                <th>{t("settings.transitions.mode")}</th>
                <th>{t("settings.transitions.workflow")}</th>
                <th>{t("settings.transitions.reason")}</th>
              </tr>
            </thead>
            <tbody>
              {s.transitions.map((tr) => (
                <tr key={`${tr.fromState ?? "upload"}>${tr.toState}`}>
                  <td data-label={t("settings.transitions.from")}>{state(tr.fromState)}</td>
                  <td data-label={t("settings.transitions.to")}>{state(tr.toState)}</td>
                  <td data-label={t("settings.transitions.mode")}>{t(`modes.${tr.mode}`)}</td>
                  <td data-label={t("settings.transitions.workflow")}>
                    {tr.mode === "review"
                      ? (workflows?.find((w) => w.id === tr.workflowTemplateId)?.name ?? t("settings.transitions.anyReview"))
                      : "—"}
                  </td>
                  <td data-label={t("settings.transitions.reason")}>{yesNo(tr.requireReason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card stack" data-section="teams">
        <h3 style={{ margin: 0 }}>{t("settings.teams.heading")}</h3>
        <table className="props-table">
          <tbody>
            <tr>
              <td>{t("settings.teams.wipPolicy")}</td>
              <td>{t(`wipPolicies.${s.wipPolicy}`)}</td>
            </tr>
            <tr>
              <td>{t("settings.teams.adminSeesWip")}</td>
              <td>{yesNo(s.adminSeesWip)}</td>
            </tr>
          </tbody>
        </table>
        <p className="muted small" style={{ margin: 0 }}>
          {t("settings.teams.pending")}
        </p>
      </section>
    </div>
  );
}
