import { useTranslation } from "react-i18next";
import type { DocumentCodeConflict } from "../api";

/**
 * A file refused because its document code belongs to another document (ISO-3,
 * docs/features/DOCUMENT_CODES.md): says which code and where the document that holds it is.
 * `warning`: the file was stored anyway (the project does not enforce the ISO rules, D-8).
 */
export function DocumentCodeConflictNote({ conflict, warning = false }: { conflict: DocumentCodeConflict; warning?: boolean }) {
  const { t } = useTranslation("cde");
  return (
    <div className="stack" style={{ gap: 2 }} data-testid={warning ? "upload-code-warning" : "upload-code-conflict"}>
      <span className={`badge ${warning ? "warn" : "danger"}`}>
        {t(warning ? "documentCode.upload.duplicate" : "documentCode.upload.taken", { code: conflict.code })}
      </span>
      <span className="small">
        {t("documentCode.upload.heldBy")} <span className="mono">{conflict.existingPath}</span>
      </span>
      <span className="muted small">{t("documentCode.upload.hint")}</span>
    </div>
  );
}
