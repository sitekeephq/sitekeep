/**
 * Administration → Privacy: the installation's switch for OCR of scanned drawing sheets
 * (docs/features/SHEETS.md, "OCR"). OCR runs on this server; nothing is sent anywhere.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLoad } from "../../app/context/project";
import { sheetsApi } from "./api";

export function AdminSheetsOcrCard() {
  const { t } = useTranslation("sheets");
  const { data, error, setData } = useLoad(() => sheetsApi.ocrAdmin(), []);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <p className="error">{error}</p>;
  if (!data) return null;

  async function toggle(enabled: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      setData(await sheetsApi.saveOcrAdmin(enabled));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack" data-testid="admin-sheets-ocr">
      <h2 style={{ margin: 0 }}>{t("ocr.admin.title")}</h2>
      <p className="muted small" style={{ margin: 0 }}>
        {t("ocr.admin.description", { languages: data.languages.join(", "), dpi: data.dpi })}
      </p>
      <label className="check">
        <input type="checkbox" checked={data.enabled && !data.disabledByEnv} disabled={busy || data.disabledByEnv} onChange={(e) => void toggle(e.target.checked)} />{" "}
        {t("ocr.admin.enabled")}
      </label>
      {data.disabledByEnv && <p className="muted small" style={{ margin: 0 }}>{t("ocr.admin.disabledByEnv")}</p>}
      {msg && <p className="error">{msg}</p>}
    </div>
  );
}
