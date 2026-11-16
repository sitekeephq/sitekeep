/**
 * Yönetim → Gizlilik Merkezi → Aydınlatma Metni: the privacy notice shown on the sign-in and
 * invitation pages, in English and Turkish, with the optional "I have read it" checkbox
 * (docs/features/PRIVACY_NOTICE.md).
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PRIVACY_NOTICE_MAX_LENGTH, type PrivacyNoticeAdminDto } from "@sitekeep/shared";
import { formatDate } from "../../../shared/api/api";
import { privacyApi } from "../../../shared/api/api-privacy";
import { useLoad } from "../../../app/context/project";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";
import { Markdown } from "../../../shared/ui/Markdown";

export function PrivacyNoticeSection() {
  const { data, error, setData } = useLoad(() => privacyApi.notice(), []);
  const [saved, setSaved] = useState(false);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <LoadingIndicator />;
  return (
    <NoticeForm
      key={`${data.version}-${data.updatedAt ?? ""}`}
      data={data}
      saved={saved}
      onSaved={(d) => {
        setData(d);
        setSaved(true);
      }}
    />
  );
}

function NoticeForm({ data, saved, onSaved }: { data: PrivacyNoticeAdminDto; saved: boolean; onSaved(d: PrivacyNoticeAdminDto): void }) {
  const { t } = useTranslation(["admin", "common"]);
  const [enabled, setEnabled] = useState(data.enabled);
  const [requireAck, setRequireAck] = useState(data.requireAck);
  const [reask, setReask] = useState(data.reaskOnChange);
  const [en, setEn] = useState(data.text.en);
  const [tr, setTr] = useState(data.text.tr);
  const [preview, setPreview] = useState<"en" | "tr" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(saved ? { ok: true, text: t("messages.saved") } : null);
  const [busy, setBusy] = useState(false);
  const textChanged = en !== data.text.en || tr !== data.text.tr;

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const next = await privacyApi.saveNotice({ enabled, requireAck, reaskOnChange: reask, text: { en, tr } });
      onSaved(next);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      setBusy(false);
    }
  }

  return (
    <div className="card stack" data-testid="privacy-notice-settings">
      <h2 style={{ margin: 0 }}>{t("privacy.notice.title")}</h2>
      <p className="muted small" style={{ margin: 0 }}>
        {t("privacy.notice.intro")}
      </p>
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t("privacy.notice.fields.enabled")}
      </label>
      <label className="check">
        <input type="checkbox" checked={requireAck} onChange={(e) => setRequireAck(e.target.checked)} />
        {t("privacy.notice.fields.requireAck")}
      </label>
      <label className="check">
        <input type="checkbox" checked={reask} disabled={!requireAck} onChange={(e) => setReask(e.target.checked)} />
        {t("privacy.notice.fields.reask")}
      </label>
      {(["en", "tr"] as const).map((lang) => (
        <div key={lang}>
          <label htmlFor={`privacy-notice-${lang}`}>{t(`privacy.notice.fields.text_${lang}`)}</label>
          <textarea
            id={`privacy-notice-${lang}`}
            rows={8}
            maxLength={PRIVACY_NOTICE_MAX_LENGTH}
            value={lang === "en" ? en : tr}
            onChange={(e) => (lang === "en" ? setEn : setTr)(e.target.value)}
          />
          <div className="row">
            <button type="button" onClick={() => setPreview(preview === lang ? null : lang)}>
              {preview === lang ? t("privacy.notice.actions.hidePreview") : t("privacy.notice.actions.preview")}
            </button>
          </div>
          {preview === lang && (
            <div className="privacy-notice" style={{ marginTop: 8 }}>
              <Markdown text={lang === "en" ? en : tr} />
            </div>
          )}
        </div>
      ))}
      <p className="muted small" style={{ margin: 0 }}>
        {t("privacy.notice.markupHelp")}
      </p>
      <p className="muted small" style={{ margin: 0 }} data-testid="privacy-notice-version">
        {data.version
          ? t("privacy.notice.version", {
              version: data.version,
              date: data.updatedAt ? formatDate(data.updatedAt) : "—",
              name: data.updatedByName ?? "—",
              count: data.acceptedCurrent,
            })
          : t("privacy.notice.noVersion")}
      </p>
      {textChanged && data.version > 0 && (
        <p className="notice small" style={{ margin: 0 }}>
          {requireAck && reask ? t("privacy.notice.newVersionReask") : t("privacy.notice.newVersion")}
        </p>
      )}
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void save()}>
          {t("common:actions.save")}
        </button>
        {msg && <span className={msg.ok ? "muted" : "error"}>{msg.text}</span>}
      </div>
    </div>
  );
}
