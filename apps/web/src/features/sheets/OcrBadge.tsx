/** "Read by OCR — check": shown on sheets whose title block came from OCR of a scanned page. */
import { useTranslation } from "react-i18next";
import { OCR_LOW_CONFIDENCE, type DrawingSheetDto } from "@sitekeep/shared";

export function OcrBadge({ sheet }: { sheet: Pick<DrawingSheetDto, "readBy" | "ocrConfidence"> & { edited?: boolean } }) {
  const { t } = useTranslation("sheets");
  // Checked and corrected by a person: no reminder any more.
  if (sheet.readBy !== "ocr" || sheet.edited) return null;
  const percent = Math.round((sheet.ocrConfidence ?? 0) * 100);
  const low = (sheet.ocrConfidence ?? 0) < OCR_LOW_CONFIDENCE;
  return (
    <span className={`badge ${low ? "danger" : "warn"}`} title={t("ocr.badgeHint", { percent })} data-testid="sheet-ocr-badge">
      {t("ocr.badge", { percent })}
    </span>
  );
}
