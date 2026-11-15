/**
 * About SiteKeep: edition, version, the source code link every user
 * is offered (AGPL-3.0 §13), the licence and the third-party notices (THIRD_PARTY_NOTICES.md from the server).
 * Reachable from the account menu and, before sign-in, from the login page.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { TRADEMARK_POLICY_URL } from "@sitekeep/shared";
import { edition, editionName } from "../../app/brand";
import { aboutApi, type AppInfoDto } from "../../shared/api/api-about";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { BrandMark } from "../../shared/ui/BrandMark";

const AGPL_URL = "https://www.gnu.org/licenses/agpl-3.0.html";

/** Signed out, the page stands alone with a way back to the login page. */
function Frame({ signedIn, children }: { signedIn: boolean; children: React.ReactNode }) {
  const { t } = useTranslation("about");
  if (signedIn) return <div className="page stack about-page">{children}</div>;
  return (
    <main className="page stack about-page about-standalone">
      <Link to="/login">{t("actions.backToSignIn")}</Link>
      {children}
    </main>
  );
}

export function AboutPage({ signedIn }: { signedIn: boolean }) {
  const { t } = useTranslation("about");
  const [info, setInfo] = useState<AppInfoDto | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    aboutApi.appInfo().then(setInfo, () => setFailed(true));
  }, []);

  const enterprise = edition() === "Enterprise";
  return (
    <Frame signedIn={signedIn}>
      <h1 className="about-title">
        <BrandMark size={32} /> {t("title")}
      </h1>
      <section className="card stack">
        <dl className="kv">
          <dt>{t("fields.product")}</dt>
          <dd>{info?.edition ?? editionName()}</dd>
          <dt>{t("fields.version")}</dt>
          <dd data-testid="about-version">{info ? (info.version ?? t("developmentBuild")) : failed ? "—" : <LoadingIndicator compact />}</dd>
          <dt>{t("fields.licence")}</dt>
          <dd>
            <a href={AGPL_URL} target="_blank" rel="noreferrer">
              {t("licence.agpl")}
            </a>
          </dd>
        </dl>
        {enterprise && <p className="muted small" style={{ margin: 0 }}>{t("licence.enterprise")}</p>}
      </section>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("source.heading")}</h2>
        <p style={{ margin: 0 }}>{t("source.description")}</p>
        {info && (
          <p style={{ margin: 0 }}>
            <a className="about-source-link" href={info.sourceUrl} target="_blank" rel="noreferrer">
              {t("source.actions.open")}
            </a>{" "}
            <span className="muted small">{info.sourceUrl}</span>
          </p>
        )}
      </section>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("notices.heading")}</h2>
        <p style={{ margin: 0 }}>{t("notices.description")}</p>
        <p style={{ margin: 0 }}>
          <Link to="/about/licences">{t("notices.actions.show")}</Link>
        </p>
      </section>

      <p className="muted small" style={{ margin: 0 }}>
        {t("trademark")}{" "}
        <a href={TRADEMARK_POLICY_URL} target="_blank" rel="noreferrer">
          {t("actions.trademarkPolicy")}
        </a>
      </p>
    </Frame>
  );
}

/** THIRD_PARTY_NOTICES.md as plain text. */
export function LicencesPage({ signedIn }: { signedIn: boolean }) {
  const { t } = useTranslation("about");
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    aboutApi.notices().then(
      (body) => setText(typeof body === "string" ? body : ""),
      () => setFailed(true),
    );
  }, []);

  return (
    <Frame signedIn={signedIn}>
      <Link to="/about">{t("actions.backToAbout")}</Link>
      <h1>{t("notices.heading")}</h1>
      <p className="muted" style={{ margin: 0 }}>{t("notices.description")}</p>
      {failed ? (
        <p className="error" role="alert">{t("notices.errors.load")}</p>
      ) : text === null ? (
        <LoadingIndicator />
      ) : (
        <pre className="about-notices" data-testid="third-party-notices">{text}</pre>
      )}
    </Frame>
  );
}
