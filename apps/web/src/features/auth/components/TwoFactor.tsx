/**
 * Two-factor authentication pieces (docs/features/SIGN_IN_SECURITY.md): the second step of the sign-in
 * page, the authenticator set-up (QR code made by the server, no external service) and the recovery
 * codes shown once.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TwoFactorSetupDto, UserDto } from "@sitekeep/shared";
import { securityApi } from "../../../shared/api/api-security";

/** QR code and the same secret as text, for apps that cannot scan. */
export function TotpSetup({ setup }: { setup: TwoFactorSetupDto }) {
  const { t } = useTranslation("auth");
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="small" style={{ margin: 0 }}>
        {t("twoFactor.setup.scan")}
      </p>
      <img
        src={setup.qrDataUrl}
        alt={t("twoFactor.setup.qrAlt")}
        width={180}
        height={180}
        style={{ background: "#fff", padding: 4, borderRadius: 6, alignSelf: "flex-start" }}
      />
      <p className="small muted" style={{ margin: 0 }}>
        {t("twoFactor.setup.manual")}{" "}
        <code data-testid="totp-secret" style={{ userSelect: "all", wordBreak: "break-all" }}>
          {setup.secret}
        </code>
      </p>
    </div>
  );
}

/** The recovery codes, shown once; the person confirms they saved them. */
export function RecoveryCodes({ codes, onDone, doneLabel }: { codes: string[]; onDone(): void; doneLabel?: string }) {
  const { t } = useTranslation("auth");
  return (
    <div className="stack" style={{ gap: 8 }} data-testid="recovery-codes">
      <strong>{t("twoFactor.recovery.title")}</strong>
      <p className="small" style={{ margin: 0 }}>
        {t("twoFactor.recovery.description")}
      </p>
      <pre style={{ margin: 0, padding: 10, columns: 2, fontSize: 14, userSelect: "all" }}>{codes.join("\n")}</pre>
      <div className="row wrap" style={{ gap: 8 }}>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(codes.join("\n")).catch(() => undefined)}>
          {t("twoFactor.recovery.copy")}
        </button>
        <button type="button" className="primary" onClick={onDone}>
          {doneLabel ?? t("twoFactor.recovery.saved")}
        </button>
      </div>
    </div>
  );
}

/** A code from the app, or (toggle) a recovery code. */
export function SecondFactorInput({
  recovery,
  value,
  onChange,
  disabled,
}: {
  recovery: boolean;
  value: string;
  onChange(v: string): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("auth");
  return (
    <>
      <label htmlFor="two-factor-code">{recovery ? t("twoFactor.fields.recoveryCode") : t("twoFactor.fields.code")}</label>
      <input
        id="two-factor-code"
        inputMode={recovery ? "text" : "numeric"}
        autoComplete="one-time-code"
        pattern={recovery ? undefined : "[0-9 ]{6,7}"}
        maxLength={recovery ? 40 : 7}
        placeholder={recovery ? "xxxx-xxxx-xxxx-xxxx" : "123456"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required
        autoFocus
      />
    </>
  );
}

/**
 * The second step of the sign-in page: "verify" asks for a code; "enrol" (required by the
 * administrator, not set up yet) shows the QR code first, then the recovery codes.
 */
export function TwoFactorSignInStep({
  mode,
  onSignedIn,
  onCancel,
}: {
  mode: "verify" | "enrol";
  onSignedIn(user: UserDto): void;
  onCancel(): void;
}) {
  const { t } = useTranslation("auth");
  const [setup, setSetup] = useState<TwoFactorSetupDto | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ user: UserDto; codes: string[] } | null>(null);

  useEffect(() => {
    if (mode !== "enrol") return;
    securityApi.challengeEnrol().then(setSetup, (e: Error) => setError(e.message));
  }, [mode]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const value = code.trim();
      const { recoveryCodes, ...user } = await securityApi.challengeVerify(recovery ? { recoveryCode: value } : { code: value.replace(/\s/g, "") });
      if (recoveryCodes?.length) setDone({ user, codes: recoveryCodes });
      else onSignedIn(user);
    } catch (err) {
      setError((err as Error).message);
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  if (done) return <RecoveryCodes codes={done.codes} onDone={() => onSignedIn(done.user)} doneLabel={t("twoFactor.recovery.continue")} />;

  return (
    <form className="login-form" onSubmit={submit} data-testid="two-factor-step">
      <div className="login-heading" style={{ marginBottom: 4 }}>
        <h2>{mode === "enrol" ? t("twoFactor.signIn.enrolTitle") : t("twoFactor.signIn.title")}</h2>
        <p>{mode === "enrol" ? t("twoFactor.signIn.enrolDescription") : recovery ? t("twoFactor.signIn.recoveryDescription") : t("twoFactor.signIn.description")}</p>
      </div>
      {mode === "enrol" && setup && <TotpSetup setup={setup} />}
      <SecondFactorInput recovery={recovery} value={code} onChange={setCode} disabled={busy} />
      {error && (
        <div className="login-error" role="alert">
          {error}
        </div>
      )}
      <button className="primary login-submit" disabled={busy || (mode === "enrol" && !setup)}>
        {mode === "enrol" ? t("twoFactor.signIn.enrolSubmit") : t("twoFactor.signIn.submit")}
      </button>
      <div className="row wrap" style={{ justifyContent: "space-between", gap: 8 }}>
        {mode === "verify" ? (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setRecovery((r) => !r);
              setCode("");
              setError(null);
            }}
          >
            {recovery ? t("twoFactor.signIn.useApp") : t("twoFactor.signIn.useRecovery")}
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="link-button" onClick={onCancel}>
          {t("twoFactor.signIn.back")}
        </button>
      </div>
    </form>
  );
}
