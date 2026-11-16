/**
 * The privacy notice ("aydınlatma metni") the system administrator wrote, on the sign-in and the
 * invitation pages, with the optional "I have read it" checkbox (docs/features/PRIVACY_NOTICE.md).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { privacyNoticeText, type PrivacyNoticePublicDto } from "@sitekeep/shared";
import { privacyApi } from "../../../shared/api/api-privacy";
import { Markdown } from "../../../shared/ui/Markdown";

/** The notice for a signed-out page; null while loading or when it cannot be read. */
export function usePrivacyNotice(): PrivacyNoticePublicDto | null {
  const [notice, setNotice] = useState<PrivacyNoticePublicDto | null>(null);
  useEffect(() => {
    privacyApi.publicNotice().then(setNotice, () => undefined);
  }, []);
  return notice;
}

/** The person still has to tick the checkbox before signing in or accepting. */
export function noticeBlocks(notice: PrivacyNoticePublicDto | null, accepted: boolean): boolean {
  return !!notice?.enabled && notice.requireAck && !accepted;
}

/** The version sent with the sign-in when the checkbox is ticked. */
export function noticeVersion(notice: PrivacyNoticePublicDto | null, accepted: boolean): number | undefined {
  return notice?.enabled && notice.requireAck && accepted ? notice.version : undefined;
}

export function PrivacyNoticePanel({
  notice,
  accepted,
  onAccepted,
  disabled,
}: {
  notice: PrivacyNoticePublicDto | null;
  accepted: boolean;
  onAccepted(v: boolean): void;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation("auth");
  if (!notice?.enabled) return null;
  return (
    <section className="privacy-notice" data-testid="privacy-notice" aria-label={t("privacyNotice.title")}>
      <strong className="privacy-notice-title">{t("privacyNotice.title")}</strong>
      <div className="privacy-notice-text">
        <Markdown text={privacyNoticeText(notice.text, i18n.language)} />
      </div>
      {notice.requireAck && (
        <label className="check">
          <input type="checkbox" checked={accepted} disabled={disabled} onChange={(e) => onAccepted(e.target.checked)} />
          {t("privacyNotice.ack")}
        </label>
      )}
    </section>
  );
}
