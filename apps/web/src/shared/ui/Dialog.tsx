import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

export function Dialog({
  title,
  onClose,
  children,
  wide,
  layer,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  wide?: boolean;
  /** Confirm sits above an already-open dialog. */
  layer?: "base" | "confirm";
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (layer === "confirm") e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, layer === "confirm");
    return () => window.removeEventListener("keydown", onKey, layer === "confirm");
  }, [layer, onClose]);
  return (
    <div
      className={`overlay${layer === "confirm" ? " confirm" : ""}`}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`dialog${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <div className="spacer" />
          <button className="ghost" type="button" aria-label={t("actions.close")} onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Same chrome as Dialog; only title, body and button labels change. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog title={title} onClose={busy ? () => undefined : onClose} layer="confirm">
      <p style={{ marginTop: 0 }}>{message}</p>
      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={onClose}>
          {cancelLabel ?? t("actions.cancel")}
        </button>
        <button type="button" className={danger ? "danger" : "primary"} disabled={busy} onClick={onConfirm}>
          {confirmLabel ?? t("actions.continue")}
        </button>
      </div>
    </Dialog>
  );
}

export function PromptDialog({
  title,
  message,
  defaultValue = "",
  confirmLabel,
  cancelLabel,
  password,
  onConfirm,
  onClose,
}: {
  title: string;
  message?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  password?: boolean;
  onConfirm(value: string): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(defaultValue);
  return (
    <Dialog title={title} onClose={onClose} layer="confirm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(value);
        }}
      >
        {message && <p style={{ marginTop: 0 }}>{message}</p>}
        <input
          autoFocus
          type={password ? "password" : "text"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {cancelLabel ?? t("actions.cancel")}
          </button>
          <button type="submit" className="primary">
            {confirmLabel ?? t("actions.save")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
