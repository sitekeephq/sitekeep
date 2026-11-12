import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../shared/api/api";
import { useAuth } from "../../../app/context/auth";
import { edition } from "../../../app/brand";
import { BrandMark, BrandName } from "../../../shared/ui/BrandMark";
import { LanguageSwitcher } from "../../../app/layout/LanguageSwitcher";

export function LoginPage() {
  const { t } = useTranslation(["auth", "common"]);
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    api.authMethods().then((methods) => setGoogleEnabled(methods.google), () => undefined);
    const code = new URLSearchParams(window.location.search).get("authError");
    if (code) {
      setError(
        code === "account_not_allowed"
          ? t("login.errors.accountNotAllowed")
          : code === "google_cancelled"
            ? t("login.errors.googleCancelled")
            : t("login.errors.googleFailed"),
      );
      window.history.replaceState({}, "", "/login");
    }
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <section className="login-showcase" aria-label={t("login.showcaseLabel")}>
        <div className="login-showcase-inner">
          <div className="login-logo">
            <span className="login-logo-mark">
              <BrandMark size={48} />
            </span>
            <BrandName edition={edition()} />
          </div>
          <div className="login-hero">
            <span className="login-eyebrow">{t("login.eyebrow")}</span>
            <h1>{t("login.headline")}</h1>
            <p>{t("login.intro")}</p>
          </div>
          <div className="login-features">
            <Feature icon={<DocumentIcon />} title={t("login.features.documents.title")}>
              {t("login.features.documents.description")}
            </Feature>
            <Feature icon={<ModelIcon />} title={t("login.features.coordination.title")}>
              {t("login.features.coordination.description")}
            </Feature>
            <Feature icon={<WorkflowIcon />} title={t("login.features.workflows.title")}>
              {t("login.features.workflows.description")}
            </Feature>
          </div>
          <div className="login-trust">
            <span className="login-trust-dot" />
            {t("login.trust")}
          </div>
        </div>
      </section>

      <section className="login-access">
        <div className="login-access-inner">
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
            <LanguageSwitcher signedIn={false} variant="plain" />
          </div>
          <div className="login-mobile-logo">
            <BrandMark size={32} /> <BrandName edition={edition()} />
          </div>
          <div className="login-heading">
            <span className="login-kicker">{t("login.kicker")}</span>
            <h2>{t("login.title")}</h2>
            <p>{t("login.description")}</p>
          </div>

          {googleEnabled && (
            <>
              <a className="login-google" href="/api/v1/auth/google">
                <GoogleIcon />
                {t("login.actions.google")}
              </a>
              <div className="login-divider">
                <span>{t("login.orEmail")}</span>
              </div>
            </>
          )}

          <form className="login-form" onSubmit={submit}>
            <label htmlFor="email">{t("login.fields.email")}</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              placeholder={t("login.emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              required
              autoFocus
            />
            <label htmlFor="password">{t("common:fields.password")}</label>
            <div className="login-password">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder={t("login.passwordPlaceholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                required
              />
              <button
                type="button"
                className="login-password-toggle"
                onClick={() => setShowPassword((shown) => !shown)}
                aria-label={showPassword ? t("password.hide") : t("password.show")}
              >
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
            {error && (
              <div className="login-error" role="alert">
                {error}
              </div>
            )}
            <button className="primary login-submit" disabled={busy}>
              {busy ? <><span className="login-spinner" /> {t("login.signingIn")}</> : t("login.actions.signIn")}
            </button>
          </form>

          <p className="login-help">
            {t("login.helpQuestion")} <span>{t("login.helpContact")}</span>
          </p>
        </div>
        <footer className="login-footer">{t("login.footer")}</footer>
      </section>
    </main>
  );
}

function Feature({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="login-feature">
      <span className="login-feature-icon">{icon}</span>
      <span>
        <strong>{title}</strong>
        <small>{children}</small>
      </span>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285f4" d="M21.6 12.2c0-.7-.1-1.5-.2-2.2H12v4.3h5.4a4.6 4.6 0 0 1-2 3v2.8h3.5c2-1.9 2.7-4.6 2.7-7.9Z" />
      <path fill="#34a853" d="M12 22c2.7 0 5-.9 6.9-2.4l-3.5-2.8c-.9.6-2.1 1-3.4 1-2.6 0-4.8-1.8-5.6-4.2H2.8v2.9A10.4 10.4 0 0 0 12 22Z" />
      <path fill="#fbbc05" d="M6.4 13.6A6.2 6.2 0 0 1 6.1 12c0-.6.1-1.1.3-1.6v-3H2.8A10 10 0 0 0 1.7 12c0 1.7.4 3.2 1.1 4.6l3.6-3Z" />
      <path fill="#ea4335" d="M12 6.2c1.5 0 2.8.5 3.8 1.5l3-3A10 10 0 0 0 2.8 7.4l3.6 3C7.2 8 9.4 6.2 12 6.2Z" />
    </svg>
  );
}

function DocumentIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7zM14 3v5h5M10 12h5M10 16h5" /></svg>;
}

function ModelIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9" /></svg>;
}

function WorkflowIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h12M6 12h8M6 19h12M3 5h.01M3 12h.01M3 19h.01M17 10l2 2-2 2" /></svg>;
}

function EyeIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></svg>;
}

function EyeOffIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 6.1c.5-.1.9-.1 1.4-.1 6 0 9.5 6 9.5 6a17 17 0 0 1-2.1 2.8M6.2 6.3C3.8 8 2.5 12 2.5 12s3.5 6 9.5 6c1.4 0 2.7-.3 3.8-.8M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>;
}
