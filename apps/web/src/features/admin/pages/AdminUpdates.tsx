/**
 * Administration → System Status → new versions (docs/features/PRIVACY.md → Update Check): the one-time card that
 * offers the daily check (off until an administrator turns it on), the notice when a newer release is
 * known, and "Check for updates" with the time and result of the last check.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SOURCE_REPOSITORY_URL } from "@sitekeep/shared";
import { updatesApi, type UpdatesDto } from "../../../shared/api/api-updates";
import { formatDate } from "../../../shared/lib/format";

/** The top-bar badge listens: the answer of a check changes it without a reload. */
export const UPDATES_EVENT = "sitekeep-updates";
const COMPOSE_UPDATE = "docker compose pull && docker compose up -d";
const DOCS = `${SOURCE_REPOSITORY_URL}/blob/main/docs/onprem`;

export function UpdatesPanel() {
  const { t } = useTranslation("admin");
  const [data, setData] = useState<UpdatesDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Loaded once per visit; the panel stays out of the page until the answer arrives (or when it fails).
  useEffect(() => {
    updatesApi.get().then(setData, () => undefined);
  }, []);
  if (!data) return null;

  async function run(action: () => Promise<UpdatesDto>, done?: (d: UpdatesDto) => string | null) {
    setBusy(true);
    setMsg(null);
    try {
      const next = await action();
      setData(next);
      window.dispatchEvent(new CustomEvent<UpdatesDto>(UPDATES_EVENT, { detail: next }));
      setMsg(done ? done(next) : null);
    } catch (e) {
      setMsg((e as Error).message);
      // The failure is on the server too (last check, reason): show it.
      updatesApi.get().then(setData, () => undefined);
    } finally {
      setBusy(false);
    }
  }

  const checked = (d: UpdatesDto) => (d.updateAvailable ? null : d.current.development ? t("updates.devBuild") : d.latest ? t("updates.upToDate") : t("updates.nothingFound"));

  return (
    <>
      {!data.enabled && !data.promptDismissed && (
        <div className="card" role="region" aria-labelledby="updates-prompt-title">
          <h2 id="updates-prompt-title">{t("updates.prompt.title")}</h2>
          <p className="muted">{t("updates.prompt.text")}</p>
          <div className="row" style={{ gap: 8 }}>
            <button className="primary" disabled={busy} onClick={() => run(() => updatesApi.setEnabled(true))}>
              {t("updates.prompt.turnOn")}
            </button>
            <button disabled={busy} onClick={() => run(() => updatesApi.dismissPrompt())}>
              {t("updates.prompt.notNow")}
            </button>
          </div>
        </div>
      )}

      {data.updateAvailable && data.latest && (
        <div className="card" role="region" aria-labelledby="updates-available-title" data-testid="update-available">
          <h2 id="updates-available-title">{t("updates.available.title", { latest: data.latest.version, current: data.current.version })}</h2>
          <p className="muted small">
            {data.latest.publishedAt ? t("updates.available.published", { date: formatDate(data.latest.publishedAt) }) : null}{" "}
            {data.latest.url && (
              <a href={data.latest.url} target="_blank" rel="noopener noreferrer">
                {t("updates.available.notes")}
              </a>
            )}
          </p>
          <p>{t("updates.available.how")}</p>
          <ul className="small">
            <li>
              {t("updates.available.bundle")} <code>{`sudo sitekeep upgrade <${t("updates.available.bundleDir")}>`}</code> (
              <a href={`${DOCS}/installation-bundle.md`} target="_blank" rel="noopener noreferrer">
                {t("updates.available.docs")}
              </a>
              )
            </li>
            <li>
              {t("updates.available.compose")} <code>{COMPOSE_UPDATE}</code> (
              <a href={`${DOCS}/docker-compose.md#updating`} target="_blank" rel="noopener noreferrer">
                {t("updates.available.docs")}
              </a>
              )
            </li>
          </ul>
          <p className="muted small">{t("updates.available.backup")}</p>
        </div>
      )}

      <div className="card">
        <h2>{t("updates.title")}</h2>
        <table className="phone-cards">
          <tbody>
            <tr>
              <td className="pc-title">{t("updates.running")}</td>
              <td>{data.current.version ?? t("updates.development")}</td>
            </tr>
            <tr>
              <td className="pc-title">{t("updates.latest")}</td>
              <td>
                {data.latest ? (
                  <>
                    {data.latest.version}{" "}
                    <span className="muted small">{t(data.latest.source === "licence" ? "updates.fromLicence" : "updates.fromGithub")}</span>
                  </>
                ) : (
                  <span className="muted">{t("updates.unknown")}</span>
                )}
              </td>
            </tr>
            <tr>
              <td className="pc-title">{t("updates.lastCheck")}</td>
              <td>
                {data.lastCheckAt ? formatDate(data.lastCheckAt) : <span className="muted">{t("updates.never")}</span>}
                {data.lastCheckAt && (data.lastError ? <span className="badge danger" style={{ marginLeft: 8 }}>{t("updates.failed")}</span> : <span className="badge ok" style={{ marginLeft: 8 }}>{t("updates.succeeded")}</span>)}
                {data.lastError && <div className="muted small">{data.lastError}</div>}
              </td>
            </tr>
            <tr>
              <td className="pc-title">{t("updates.automatic")}</td>
              <td>
                <label className="row" style={{ gap: 8 }}>
                  <input type="checkbox" checked={data.enabled} disabled={busy} onChange={(e) => run(() => updatesApi.setEnabled(e.target.checked))} />
                  <span>{t("updates.automaticLabel")}</span>
                </label>
                <div className="muted small">{t("updates.privacy")}</div>
              </td>
            </tr>
          </tbody>
        </table>
        <div className="row wrap" style={{ gap: 8, marginTop: 12, alignItems: "center" }}>
          <button disabled={busy || !!data.blockedReason} onClick={() => run(() => updatesApi.check(), checked)}>
            {t("updates.check")}
          </button>
          {data.blockedReason && <span className="muted small">{data.blockedReason}</span>}
          {msg && <span role="status" className="small">{msg}</span>}
        </div>
      </div>
    </>
  );
}
