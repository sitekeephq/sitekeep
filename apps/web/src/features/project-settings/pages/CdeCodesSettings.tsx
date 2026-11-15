import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { CDE_CODE_SCHEMES, CDE_STATES, codeProfile, type CdeCodeScheme, type CdeSettingsDto } from "@sitekeep/shared";
import { cdeApi } from "../../../shared/api/api-cde";
import { useLoad, useProject } from "../../../app/context/project";
import { codeHints } from "../../documents/components/cde/CodeChips";

/**
 * Proje Ayarları → CDE → Codes (docs/features/CDE_STATES.md "Codes"): the code scheme (project
 * administrators choose it), the codes each state allows, and the older attribute values the
 * migration could not turn into codes.
 */
export function CdeCodesSettings({ settings, onSaved }: { settings: CdeSettingsDto; onSaved(s: CdeSettingsDto): void }) {
  const { t } = useTranslation(["cde", "common"]);
  const project = useProject();
  const isAdmin = !!project.isProjectAdmin;
  const [scheme, setScheme] = useState<CdeCodeScheme>(settings.codeScheme);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const { data: unmapped } = useLoad(() => (isAdmin ? cdeApi.unmappedCodes(project.id).catch(() => null) : Promise.resolve(null)), [project.id, isAdmin]);
  const profile = codeProfile({ codeScheme: scheme, suitabilityCodes: settings.suitabilityCodes });

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      onSaved(await cdeApi.saveSettings(project.id, { codeScheme: scheme }));
      setMessage({ ok: true, text: t("codes.settings.saved") });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack" data-section="codes" data-testid="cde-codes-settings">
      <h3 style={{ margin: 0 }}>{t("settings.codes.heading")}</h3>
      <div>
        <label htmlFor="cde-code-scheme">{t("settings.codes.scheme")}</label>
        <div className="row wrap">
          <select id="cde-code-scheme" value={scheme} disabled={!isAdmin} onChange={(e) => setScheme(e.target.value as CdeCodeScheme)} style={{ width: "auto" }}>
            {CDE_CODE_SCHEMES.map((s) => (
              <option key={s} value={s}>
                {t(`schemes.${s}`)}
              </option>
            ))}
          </select>
          {isAdmin && (
            <button className="primary small" disabled={busy || scheme === settings.codeScheme} onClick={() => void save()}>
              {t("codes.settings.save")}
            </button>
          )}
          {message && <span className={message.ok ? "muted small" : "error small"}>{message.text}</span>}
        </div>
        <p className="muted small" style={{ margin: "4px 0 0" }}>
          {t(`codes.settings.schemeHelp.${scheme}`)}
        </p>
      </div>

      <div>
        <h4 style={{ margin: "0 0 4px" }}>{t("codes.settings.allowedHeading")}</h4>
        <table className="phone-cards">
          <thead>
            <tr>
              <th>{t("codes.settings.state")}</th>
              <th>{t("codes.suitability")}</th>
              <th>{t("codes.revision")}</th>
            </tr>
          </thead>
          <tbody>
            {CDE_STATES.map((state) => {
              const h = codeHints(profile, state);
              return (
                <tr key={state}>
                  <td className="pc-title">{t(`states.${state}`)}</td>
                  <td data-label={t("codes.suitability")} className="mono small">
                    {h.codes || "—"}
                  </td>
                  <td data-label={t("codes.revision")} className="mono small">
                    {h.revision}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {profile.customSuitability && (
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            {t("codes.settings.ownList")}
          </p>
        )}
      </div>

      {isAdmin && unmapped && (
        <div data-testid="cde-codes-unmapped">
          <h4 style={{ margin: "0 0 4px" }}>{t("codes.settings.unmappedHeading")}</h4>
          <p className="muted small" style={{ margin: 0 }}>
            {unmapped.items.length ? t("codes.settings.unmappedHelp") : t("codes.settings.unmappedEmpty")}
          </p>
          {unmapped.items.length > 0 && (
            <table className="phone-cards">
              <thead>
                <tr>
                  <th>{t("codes.settings.file")}</th>
                  <th>{t("codes.settings.field")}</th>
                  <th>{t("codes.settings.value")}</th>
                </tr>
              </thead>
              <tbody>
                {unmapped.items.map((u) => (
                  <tr key={`${u.versionId}:${u.field}`}>
                    <td className="pc-title">
                      <Link to={`/projects/${project.id}/files/${u.folderId}?file=${u.fileId}`}>{u.name}</Link>
                    </td>
                    <td data-label={t("codes.settings.field")}>{u.field === "suitabilityCode" ? t("codes.suitability") : t("codes.revision")}</td>
                    <td data-label={t("codes.settings.value")} className="mono">
                      {u.value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {unmapped.truncated && <p className="muted small">{t("codes.settings.unmappedTruncated", { count: unmapped.items.length })}</p>}
        </div>
      )}
    </section>
  );
}
