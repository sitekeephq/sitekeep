import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { PROVISION_PASSWORD } from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { useAuth } from "../../../app/context/auth";
import { Icon } from "../../../shared/ui/Icon";

const MIN_LEN = 10;

/** Blocks the app until a provisioned user replaces their temporary password. */
export function ForcePasswordChange() {
  const { t } = useTranslation(["auth", "common"]);
  const { user, reloadUser, pendingCurrentPassword } = useAuth();
  const [current, setCurrent] = useState(pendingCurrentPassword || PROVISION_PASSWORD);
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [show, setShow] = useState({ current: false, next: false, again: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCurrent(pendingCurrentPassword || PROVISION_PASSWORD);
  }, [pendingCurrentPassword]);

  const longEnough = next.length >= MIN_LEN;
  const matches = next.length > 0 && next === again;
  const canSave = !busy && current.length > 0 && longEnough && matches && next !== current;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      await reloadUser();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay force-password-overlay" role="presentation">
      <div className="dialog force-password-dialog" role="dialog" aria-modal="true" aria-labelledby="force-password-title">
        <h2 id="force-password-title">{t("forcePassword.title")}</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          {user?.name ? t("forcePassword.descriptionNamed", { name: user.name }) : t("forcePassword.description")}
        </p>
        <form className="force-password-form" onSubmit={(e) => void submit(e)}>
          <label htmlFor="force-current">{t("forcePassword.fields.current")}</label>
          <PasswordInput
            id="force-current"
            autoComplete="current-password"
            value={current}
            revealed={show.current}
            onReveal={() => setShow((s) => ({ ...s, current: !s.current }))}
            onChange={setCurrent}
          />
          <label htmlFor="force-next">{t("forcePassword.fields.next")}</label>
          <PasswordInput
            id="force-next"
            autoComplete="new-password"
            value={next}
            revealed={show.next}
            onReveal={() => setShow((s) => ({ ...s, next: !s.next }))}
            onChange={setNext}
          />
          <p className="force-password-hint">{t("forcePassword.minLength", { count: MIN_LEN })}</p>
          <label htmlFor="force-again">{t("forcePassword.fields.again")}</label>
          <PasswordInput
            id="force-again"
            autoComplete="new-password"
            value={again}
            revealed={show.again}
            onReveal={() => setShow((s) => ({ ...s, again: !s.again }))}
            onChange={setAgain}
          />
          {again.length > 0 && !matches && <p className="force-password-hint warn">{t("forcePassword.mismatch")}</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="submit" className="primary" disabled={!canSave}>
              {busy ? t("common:status.saving") : t("forcePassword.actions.save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function PasswordInput({
  id,
  value,
  revealed,
  autoComplete,
  onChange,
  onReveal,
}: {
  id: string;
  value: string;
  revealed: boolean;
  autoComplete: string;
  onChange(value: string): void;
  onReveal(): void;
}) {
  const { t } = useTranslation(["auth", "common"]);
  return (
    <div className="force-password-field">
      <input
        id={id}
        type={revealed ? "text" : "password"}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
      />
      <button
        type="button"
        className="force-password-toggle"
        onClick={onReveal}
        aria-label={revealed ? t("password.hide") : t("password.show")}
      >
        <Icon name={revealed ? "eyeOff" : "eye"} size={16} />
      </button>
    </div>
  );
}
