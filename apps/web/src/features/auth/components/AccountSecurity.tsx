/** Account → two-factor authentication and browser sessions (docs/features/SIGN_IN_SECURITY.md). */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TwoFactorSetupDto } from "@sitekeep/shared";
import { formatDate } from "../../../shared/api/api";
import { securityApi } from "../../../shared/api/api-security";
import { useAuth } from "../../../app/context/auth";
import { useLoad } from "../../../app/context/project";
import { useAsk } from "../../../shared/ui/Ask";
import { RecoveryCodes, SecondFactorInput, TotpSetup } from "./TwoFactor";

export function TwoFactorCard() {
  const { t } = useTranslation(["auth", "common"]);
  const { data: status, reload } = useLoad(() => securityApi.twoFactor(), []);
  const [setup, setSetup] = useState<TwoFactorSetupDto | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  /** Confirming a change (turn off / new recovery codes) with a current code. */
  const [confirming, setConfirming] = useState<"disable" | "codes" | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const factor = () => (recovery ? { recoveryCode: code.trim() } : { code: code.replace(/\s/g, "") });

  return (
    <div className="card" data-testid="two-factor-card">
      <h2>{t("twoFactor.account.heading")}</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("twoFactor.account.description")}
      </p>
      {status && (
        <p style={{ margin: "0 0 8px" }}>
          {status.enabled ? (
            <span className="badge ok">{t("twoFactor.account.on")}</span>
          ) : (
            <span className="badge">{t("twoFactor.account.off")}</span>
          )}{" "}
          {status.required && <span className="badge warn">{t("twoFactor.account.required")}</span>}{" "}
          {status.enabled && (
            <span className="muted small">
              {t("twoFactor.account.since", { date: status.enabledAt ? formatDate(status.enabledAt) : "" })} ·{" "}
              {t("twoFactor.account.codesLeft", { count: status.recoveryCodesLeft })}
            </span>
          )}
        </p>
      )}

      {codes ? (
        <RecoveryCodes
          codes={codes}
          onDone={() => {
            setCodes(null);
            reload();
          }}
        />
      ) : setup ? (
        <form
          className="stack"
          style={{ gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await securityApi.enableTwoFactor(code.replace(/\s/g, ""));
              setSetup(null);
              setCode("");
              setCodes(r.recoveryCodes);
            });
          }}
        >
          <TotpSetup setup={setup} />
          <SecondFactorInput recovery={false} value={code} onChange={setCode} disabled={busy} />
          {error && <p className="error">{error}</p>}
          <div className="dialog-actions">
            <button type="button" onClick={() => setSetup(null)}>
              {t("common:actions.cancel")}
            </button>
            <button className="primary" disabled={busy}>
              {t("twoFactor.account.confirmSetup")}
            </button>
          </div>
        </form>
      ) : confirming ? (
        <form
          className="stack"
          style={{ gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (confirming === "disable") await securityApi.disableTwoFactor(factor());
              else setCodes((await securityApi.newRecoveryCodes(factor())).recoveryCodes);
              setConfirming(null);
              setCode("");
              reload();
            });
          }}
        >
          <SecondFactorInput recovery={recovery} value={code} onChange={setCode} disabled={busy} />
          <button type="button" className="link-button" style={{ alignSelf: "flex-start" }} onClick={() => setRecovery((r) => !r)}>
            {recovery ? t("twoFactor.signIn.useApp") : t("twoFactor.signIn.useRecovery")}
          </button>
          {error && <p className="error">{error}</p>}
          <div className="dialog-actions">
            <button type="button" onClick={() => setConfirming(null)}>
              {t("common:actions.cancel")}
            </button>
            <button className={confirming === "disable" ? "danger" : "primary"} disabled={busy}>
              {confirming === "disable" ? t("twoFactor.account.disable") : t("twoFactor.account.newCodes")}
            </button>
          </div>
        </form>
      ) : (
        <>
          {error && <p className="error">{error}</p>}
          <div className="row wrap" style={{ gap: 8 }}>
            {status && !status.enabled && (
              <button className="primary" disabled={busy} onClick={() => void run(async () => setSetup(await securityApi.setupTwoFactor()))}>
                {t("twoFactor.account.enable")}
              </button>
            )}
            {status?.enabled && (
              <button disabled={busy} onClick={() => setConfirming("codes")}>
                {t("twoFactor.account.newCodes")}
              </button>
            )}
            {status?.enabled && !status.required && (
              <button className="danger" disabled={busy} onClick={() => setConfirming("disable")}>
                {t("twoFactor.account.disable")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function SessionsCard() {
  const { t } = useTranslation(["auth", "common"]);
  const { confirm } = useAsk();
  const { logout } = useAuth();
  const { data: sessions } = useLoad(() => securityApi.sessions(), []);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="card" data-testid="sessions-card">
      <h2>{t("sessions.heading")}</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("sessions.description", { count: sessions?.length ?? 0 })}
      </p>
      {error && <p className="error">{error}</p>}
      <button
        className="danger"
        onClick={() =>
          void confirm({
            title: t("sessions.endAll.title"),
            message: t("sessions.endAll.confirm"),
            confirmLabel: t("sessions.endAll.action"),
            danger: true,
          }).then(async (ok) => {
            if (!ok) return;
            try {
              await securityApi.endAllSessions();
              await logout();
            } catch (e) {
              setError((e as Error).message);
            }
          })
        }
      >
        {t("sessions.endAll.action")}
      </button>
    </div>
  );
}
