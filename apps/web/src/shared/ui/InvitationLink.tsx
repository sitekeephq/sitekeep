/** An invitation link the inviter hands over when no e-mail was sent (docs/features/INVITATIONS.md). */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { InvitationDeliveryDto } from "@sitekeep/shared";

export function InvitationLink({ email, delivery }: { email: string; delivery: InvitationDeliveryDto }) {
  const { t } = useTranslation("auth");
  const [copied, setCopied] = useState(false);
  if (delivery.mailed) return <span className="badge ok">{t("invite.link.mailed")}</span>;
  if (!delivery.url) return null;
  return (
    <div className="stack" style={{ gap: 4 }} data-testid="invitation-link" data-email={email}>
      <div className="invite-link">
        <input readOnly value={delivery.url} aria-label={t("invite.link.label", { email })} onFocus={(e) => e.currentTarget.select()} />
        <button
          type="button"
          className="small"
          onClick={() =>
            void navigator.clipboard?.writeText(delivery.url!).then(
              () => setCopied(true),
              () => undefined,
            )
          }
        >
          {copied ? t("invite.link.copied") : t("invite.link.copy")}
        </button>
      </div>
      <span className="muted small">{t(`invite.link.reasons.${delivery.mailSkipped ?? "smtp_not_configured"}`)}</span>
    </div>
  );
}
