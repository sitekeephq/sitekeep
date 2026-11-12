/**
 * OAuth consent page (outside the app shell): "<Uygulama> hesabınıza erişmek istiyor", the scopes,
 * Onayla / Reddet. The server checks the request again when the user decides (docs/features/OPENCDE.md).
 */
import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { oauthScopeHint, type OAuthConsentDto } from "@sitekeep/shared";
import { ApiError } from "../../../shared/api/api";
import { oauthApi, safeOAuthNext } from "../../../shared/api/api-oauth";
import { useAuth } from "../../../app/context/auth";
import { label } from "../../../i18n";
import { editionName } from "../../../app/brand";
import { BrandMark } from "../../../shared/ui/BrandMark";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";


export function OAuthConsentPage() {
  const { t, i18n } = useTranslation("integrations");
  const { user, logout } = useAuth();
  const location = useLocation();
  const params = useMemo(() => Object.fromEntries(new URLSearchParams(location.search)), [location.search]);
  const [info, setInfo] = useState<OAuthConsentDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The page must not be framed by another site (clickjacking).
  const framed = window.top !== window.self;

  useEffect(() => {
    if (framed) return;
    oauthApi.consentInfo(location.search.slice(1)).then(setInfo, (e: Error) => {
      const redirectTo = e instanceof ApiError ? (e.body as { details?: { redirectTo?: string | null } } | null)?.details?.redirectTo : null;
      if (redirectTo) window.location.replace(redirectTo);
      else setError(e.message);
    });
  }, [location.search, framed]);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      const { redirectTo } = await oauthApi.decide(params, approve);
      window.location.replace(redirectTo);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="card consent">
        <div className="brand" style={{ marginBottom: 16, fontSize: 18 }}>
          <BrandMark /> {editionName()}
        </div>
        {framed ? (
          <p className="error">{t("framed")}</p>
        ) : error ? (
          <>
            <h1 className="consent-title">{t("consent.failed.title")}</h1>
            <p className="error">{error}</p>
          </>
        ) : !info ? (
          <LoadingIndicator />
        ) : (
          <>
            <h1 className="consent-title">
              <Trans t={t} i18nKey="consent.request" values={{ name: info.client.name }} components={{ b: <strong /> }} />
            </h1>
            {info.client.description && <p className="muted small">{info.client.description}</p>}
            <p className="small" style={{ marginBottom: 4 }}>
              <Trans t={t} i18nKey="consent.intro" values={{ name: user?.name, email: user?.email }} components={{ b: <strong /> }} />
            </p>
            <ul className="consent-scopes">
              {info.scopes.map((s) => (
                <li key={s}>
                  <strong>{label("oauthScope", s)}</strong>
                  <div className="muted small">{oauthScopeHint(s, i18n.language)}</div>
                </li>
              ))}
            </ul>
            <p className="muted small">
              <Trans t={t} i18nKey="consent.after" values={{ target: info.redirectTarget }} components={{ b: <strong /> }} />
            </p>
            <div className="dialog-actions">
              <button disabled={busy} onClick={() => void decide(false)}>
                {t("consent.actions.deny")}
              </button>
              <button className="primary" disabled={busy} onClick={() => void decide(true)}>
                {t("consent.actions.approve")}
              </button>
            </div>
            <p className="muted small" style={{ marginBottom: 0 }}>
              {t("consent.notYou")}{" "}
              <button className="link-button small" onClick={() => void logout()}>
                {t("consent.actions.switchAccount")}
              </button>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** /login?next=… after signing in: back to the OAuth authorization request, else the start page. */
export function AfterLoginPage() {
  const { t } = useTranslation("integrations");
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const next = safeOAuthNext(new URLSearchParams(location.search).get("next"), window.location.origin);
    if (next) window.location.replace(next);
    else navigate("/", { replace: true });
  }, [location.search, navigate]);
  return <div className="page muted">{t("consent.redirecting")}</div>;
}
