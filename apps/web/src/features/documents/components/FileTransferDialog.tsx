import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { FolderDto } from "@sitekeep/shared";
import { documentsApi } from "../api";
import { Dialog } from "../../../shared/ui/Dialog";
import { LoadingIndicator, LoadingSpinner } from "../../../shared/ui/LoadingIndicator";

type TargetFolder = FolderDto & { pathLabel: string };

export function FileTransferDialog({
  projectId,
  currentFolderId,
  fileId,
  fileName,
  mode,
  onClose,
  onDone,
}: {
  projectId: string;
  currentFolderId: string;
  fileId: string;
  fileName: string;
  mode: "move" | "copy";
  onClose(): void;
  onDone(folderId: string): void;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const [folders, setFolders] = useState<TargetFolder[] | null>(null);
  const [folderId, setFolderId] = useState(currentFolderId);
  const [name, setName] = useState(fileName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function loadFolders() {
      try {
        const current = await documentsApi.folder(projectId, currentFolderId);
        const rootId = current.path[0]?.id ?? currentFolderId;
        const queue: { id: string; path: string[] }[] = [{ id: rootId, path: [] }];
        const result: TargetFolder[] = [];
        const seen = new Set<string>();
        while (queue.length) {
          const next = queue.shift()!;
          if (seen.has(next.id)) continue;
          seen.add(next.id);
          const contents = await documentsApi.contents(projectId, next.id);
          const ownPath = [...next.path, contents.folder.name];
          result.push({ ...contents.folder, pathLabel: ownPath.join(" / ") });
          for (const child of contents.folders) queue.push({ id: child.id, path: ownPath });
        }
        if (alive) setFolders(result.filter((folder) => folder.canUpload));
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    }
    void loadFolders();
    return () => {
      alive = false;
    };
  }, [projectId, currentFolderId]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (mode === "move") await documentsApi.updateFile(projectId, fileId, { folderId });
      else await documentsApi.copyFile(projectId, fileId, { folderId, name: name.trim() });
      onDone(folderId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const movingNowhere = mode === "move" && folderId === currentFolderId;
  return (
    <Dialog title={mode === "move" ? t("transfer.moveTitle") : t("transfer.copyTitle")} onClose={() => !busy && onClose()}>
      <p className="muted small">
        <Trans t={t} i18nKey="transfer.hint" values={{ name: fileName }} components={{ b: <strong /> }} />
      </p>
      <label>{t("transfer.target")}</label>
      {!folders ? (
        <LoadingIndicator compact />
      ) : (
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)} disabled={busy}>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.pathLabel}
            </option>
          ))}
        </select>
      )}
      {mode === "copy" && (
        <>
          <label>{t("transfer.copyName")}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
        </>
      )}
      {movingNowhere && <p className="muted small">{t("transfer.alreadyHere")}</p>}
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button disabled={busy} onClick={onClose}>{t("common:actions.cancel")}</button>
        <button
          className="primary"
          disabled={busy || !folders?.length || movingNowhere || (mode === "copy" && !name.trim())}
          onClick={() => void submit()}
        >
          {busy ? <LoadingSpinner className="small" /> : mode === "move" ? t("transfer.actions.move") : t("common:actions.copy")}
        </button>
      </div>
    </Dialog>
  );
}
