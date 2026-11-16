import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CDE_STATES, type CdeState } from "@sitekeep/shared";
import { useLoad, useProject } from "../../../app/context/project";
import { documentsApi } from "../../documents/api";
import { sheetsApi } from "../../sheets/api";

/**
 * Proje Ayarları → CDE → Paftalar (FP-2, docs/features/SHEETS.md): the folders whose PDF and DWG
 * drawings are split into sheets: by state (default Shared and Published) and chosen folders.
 */
export function SheetSettingsSection() {
  const { t } = useTranslation(["sheets", "cde", "common"]);
  const project = useProject();
  const { data, setData } = useLoad(() => sheetsApi.settings(project.id), [project.id]);
  const { data: root } = useLoad(() => documentsApi.contents(project.id, project.rootFolderId).catch(() => null), [project.id, project.rootFolderId]);
  const [states, setStates] = useState<CdeState[]>([]);
  const [folderIds, setFolderIds] = useState<string[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    setStates(data.states);
    setFolderIds(data.folderIds);
  }, [data]);

  if (!data) return null;
  const canEdit = data.canEdit;
  const folders = [
    { id: project.rootFolderId, name: root?.folder.name ?? project.name },
    ...(root?.folders ?? []).map((f) => ({ id: f.id, name: `${root?.folder.name ?? ""} / ${f.name}` })),
  ];
  const nameOf = (id: string) => folders.find((f) => f.id === id)?.name ?? id.slice(0, 8);
  const changed = states.join() !== data.states.join() || folderIds.join() !== data.folderIds.join();

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const saved = await sheetsApi.saveSettings(project.id, { states, folderIds });
      setData(saved);
      setMessage({ ok: true, text: t("settings.saved") });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack" data-section="sheets" data-testid="sheet-settings">
      <h3 style={{ margin: 0 }}>{t("settings.title")}</h3>
      <p className="muted" style={{ margin: 0 }}>
        {t("settings.description")}
      </p>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>{t("settings.states")}</legend>
        <div className="row" style={{ flexWrap: "wrap", gap: 16 }}>
          {CDE_STATES.map((s) => (
            <label key={s} className="check">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={states.includes(s)}
                onChange={(e) => setStates((cur) => (e.target.checked ? CDE_STATES.filter((x) => x === s || cur.includes(x)) : cur.filter((x) => x !== s)))}
              />{" "}
              {t(`cde:states.${s}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label htmlFor="sheet-settings-folder">{t("settings.folders")}</label>
        <ul className="sheet-settings-folders">
          {folderIds.map((id) => (
            <li key={id}>
              <span>{nameOf(id)}</span>
              {canEdit && (
                <button type="button" className="ghost" onClick={() => setFolderIds((cur) => cur.filter((x) => x !== id))}>
                  {t("settings.removeFolder")}
                </button>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <select id="sheet-settings-folder" value="" onChange={(e) => e.target.value && setFolderIds((cur) => [...cur, e.target.value])} style={{ width: "auto" }}>
            <option value="">{t("settings.addFolder")}</option>
            {folders
              .filter((f) => !folderIds.includes(f.id))
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </select>
        )}
      </div>
      {message && <div className={message.ok ? "success" : "error"}>{message.text}</div>}
      {canEdit && (
        <div className="row">
          <button type="button" className="primary" onClick={save} disabled={busy || !changed}>
            {t("common:actions.save")}
          </button>
        </div>
      )}
    </section>
  );
}
