import { useState } from "react";
import { useTranslation } from "react-i18next";
import { documentsApi } from "./api";
import { Dialog } from "../../shared/ui/Dialog";

export function NewFolderDialog({
  projectId,
  parentId,
  onClose,
  onCreated,
}: {
  projectId: string;
  parentId: string;
  onClose(): void;
  onCreated(): void;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={t("newFolder.title")} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await documentsApi.createFolder(projectId, parentId, name);
            onCreated();
            onClose();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <label>{t("newFolder.fields.name")}</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required />
        <p className="muted small">{t("newFolder.hint")}</p>
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t("common:actions.cancel")}
          </button>
          <button className="primary">{t("common:actions.create")}</button>
        </div>
      </form>
    </Dialog>
  );
}
