/**
 * Accept page of an invitation (docs/features/INVITATIONS.md): /invite#<token>. The token stays in
 * the fragment (never sent to the server in a URL); the page shows who invited whom to what and
 * the person sets a name and password, or continues with Google for the same address.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { InvitationInfoDto } from "@sitekeep/shared";
import { invitationsApi } from "../../../shared/api/api-invitations";
import { useAuth } from "../../../app/context/auth";
import { editionName } from "../../../app/brand";
import { currentIntlLocale } from "../../../i18n";
import { BrandMark } from "../../../shared/ui/BrandMark";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";
import { LanguageSwitcher } from "../../../app/layout/LanguageSwitcher";
import { GoogleIcon } from "./Login";
import { invitationToken } from "../invitation-token";
import { PrivacyNoticePanel, noticeBlocks, noticeVersion, usePrivacyNotice } from "../components/PrivacyNotice";

export function AcceptInvitationPage() {
  const { t } = useTranslation(["auth", "common"]);
  const { user, reloadUser } = useAuth();
  const navigate = useNavigate();
  const [token] = useState(() => invitationToken(window.location.hash));
  const [info, setInfo] = useState<InvitationInfoDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const notice = usePrivacyNotice();
  const [noticeRead, setNoticeRead] = useState(false);
  const blocked = noticeBlocks(notice, noticeRead);

  useEffect(() => {
    if (!token) {
      setError(t("invite.errors.noToken"));
      return;
    }
    invitationsApi.lookup(token).then(
      (i) => {
        setInfo(i);
        setName(i.name);
      },
      (e: Error) => setError(e.message),
    );
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== repeat) {
      setError(t("invite.errors.mismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await invitationsApi.accept(token, name.trim(), password, noticeVersion(notice, noticeRead));
      window.history.replaceState({}, "", "/invite");
      // Two-factor required for everyone: set it up on the sign-in page before the session starts.
      if ("twoFactor" in result) {
        navigate("/login?twoFactor=1", { replace: true });
        return;
      }
      await reloadUser();
      navigate("/home", { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function google() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await invitationsApi.google(token, noticeVersion(notice, noticeRead));
      window.location.assign(url);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const expires = info ? new Intl.DateTimeFormat(currentIntlLocale(), { dateStyle: "long" }).format(new Date(info.expiresAt)) : "";
  return (
    <main className="invite-page">
      <div className="card invite-card" data-testid="accept-invitation">
        <div className="row" style={{ marginBottom: 16 }}>
          <div className="brand" style={{ fontSize: 18 }}>
            <BrandMark /> {editionName()}
          </div>
          <div className="spacer" />
          {!user && <LanguageSwitcher signedIn={false} variant="plain" />}
        </div>
        {user && !busy && (
          <p className="notice small">
            {t("invite.signedInAs", { name: user.name, email: user.email })} <Link to="/home">{t("invite.actions.toProjects")}</Link>
          </p>
        )}
        {!info && !error && <LoadingIndicator />}
        {!info && error && (
          <>
            <h1 className="consent-title">{t("invite.failedTitle")}</h1>
            <p className="error" role="alert">
              {error}
            </p>
            <Link to="/login">{t("invite.actions.toSignIn")}</Link>
          </>
        )}
        {info && (
          <>
            <h1 className="consent-title">{t("invite.title")}</h1>
            <p className="small">
              {info.invitedBy
                ? t("invite.intro", { inviter: info.invitedBy, projects: info.projects.map((p) => p.name).join(", ") || "—" })
                : t("invite.introNoInviter", { projects: info.projects.map((p) => p.name).join(", ") || "—" })}
            </p>
            <p className="muted small">{t("invite.expires", { date: expires })}</p>
            <PrivacyNoticePanel notice={notice} accepted={noticeRead} onAccepted={setNoticeRead} disabled={busy} />
            {info.google && (
              <>
                <button type="button" className="login-google invite-google" disabled={busy || blocked} onClick={() => void google()}>
                  <GoogleIcon />
                  {t("invite.actions.google")}
                </button>
                <p className="muted small">{t("invite.googleHint", { email: info.email })}</p>
                <div className="login-divider">
                  <span>{t("invite.orPassword")}</span>
                </div>
              </>
            )}
            <form className="stack invite-form" onSubmit={(e) => void submit(e)}>
              <label>
                {t("login.fields.email")}
                <input type="email" value={info.email} readOnly autoComplete="username" />
              </label>
              <label>
                {t("invite.fields.name")}
                <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} autoComplete="name" disabled={busy} />
              </label>
              <label>
                {t("common:fields.password")}
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={10}
                  autoComplete="new-password"
                  disabled={busy}
                />
              </label>
              <label>
                {t("invite.fields.repeat")}
                <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required autoComplete="new-password" disabled={busy} />
              </label>
              <p className="muted small" style={{ margin: 0 }}>
                {t("invite.passwordHint")}
              </p>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary" disabled={busy || blocked || !name.trim() || !password}>
                {t("invite.actions.accept")}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
