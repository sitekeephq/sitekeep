import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type FolderDto, type FolderState } from "@sitekeep/shared";
import { labelEntries, useLabel } from "../../../i18n";
import { api } from "../../../shared/api/api";
import { documentsApi } from "../api";
import { useLoad } from "../../../app/context/project";
import { useAsk } from "../../../shared/ui/Ask";
import { Dialog } from "../../../shared/ui/Dialog";
import { WhoCanSeeDialog } from "./WhoCanSeeDialog";

export function FolderSettingsDialog({
  projectId,
  folder,
  onClose,
  onChanged,
  onDeleted,
}: {
  projectId: string;
  folder: FolderDto;
  onClose(): void;
  onChanged(): void;
  onDeleted(): void;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const label = useLabel();
  const { confirm } = useAsk();
  const { data: standards } = useLoad(() => api.namingStandards(projectId), [projectId]);
  const { data: allDefs } = useLoad(() => documentsApi.attributeDefinitions(projectId), [projectId]);
  const { data: effective } = useLoad(() => documentsApi.folderAttributes(projectId, folder.id), [projectId, folder.id]);
  const [bound, setBound] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (effective) setBound(new Set(effective.filter((d) => !d.inherited).map((d) => d.id)));
  }, [effective]);
  const inheritedIds = new Set((effective ?? []).filter((d) => d.inherited).map((d) => d.id));
  const [name, setName] = useState(folder.name);
  const [state, setState] = useState<FolderState | "">(folder.state ?? "");
  const [standardId, setStandardId] = useState(folder.namingStandardId ?? "");
  const { data: settings } = useLoad(() => documentsApi.folderSettings(projectId, folder.id), [projectId, folder.id]);
  const [gate, setGate] = useState(false);
  useEffect(() => setGate(!!settings?.requireApprovedReview), [settings]);
  const [error, setError] = useState<string | null>(null);
  const [whoOpen, setWhoOpen] = useState(false);
  const isRoot = folder.parentId === null;

  async function save() {
    setError(null);
    try {
      await documentsApi.updateFolder(projectId, folder.id, {
        ...(isRoot || name === folder.name ? {} : { name }),
        state: state || null,
        namingStandardId: standardId || null,
      });
      if (settings && gate !== settings.requireApprovedReview)
        await documentsApi.updateFolderSettings(projectId, folder.id, { requireApprovedReview: gate });
      const before = (effective ?? []).filter((d) => !d.inherited).map((d) => d.id).sort();
      const after = [...(bound ?? [])].sort();
      if (bound && before.join() !== after.join()) await documentsApi.setFolderAttributes(projectId, folder.id, after);
      onChanged();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove() {
    if (
      !(await confirm({
        title: t("folderSettings.actions.delete"),
        message: t("folderSettings.deleteConfirm", { name: folder.name }),
        confirmLabel: t("common:actions.delete"),
        danger: true,
      }))
    )
      return;
    try {
      await documentsApi.deleteFolder(projectId, folder.id);
      onClose();
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Dialog title={t("folderSettings.title")} onClose={onClose}>
      {!isRoot && (
        <>
          <label>{t("newFolder.fields.name")}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </>
      )}
      <label>{t("folderSettings.fields.state")}</label>
      <select value={state} onChange={(e) => setState(e.target.value as FolderState | "")}>
        <option value="">—</option>
        {labelEntries("folderState").map(([s, text]) => (
          <option key={s} value={s}>
            {text}
          </option>
        ))}
      </select>
      <label>{t("folderSettings.fields.standard")}</label>
      <select value={standardId} onChange={(e) => setStandardId(e.target.value)}>
        <option value="">{t("folderSettings.options.inheritStandard")}</option>
        {standards?.map((s) => (
          <option key={s.id} value={s.id}>
            {s.definition.name}
          </option>
        ))}
      </select>
      {standards?.length === 0 && (
        <p className="muted small">{t("folderSettings.noStandards")}</p>
      )}
      <label className="row" style={{ color: "var(--text)", fontSize: 13, marginTop: 14 }}>
        <input type="checkbox" style={{ width: "auto" }} checked={gate} onChange={(e) => setGate(e.target.checked)} />
        {t("folderSettings.options.gate")}
      </label>
      <p className="muted small" style={{ marginTop: 2 }}>
        {t("folderSettings.gateHelp")}
        {settings && !settings.requireApprovedReview && settings.gated && ` ${t("folderSettings.gateInherited", { folder: settings.gatedBy })}`}
      </p>
      <label>{t("folderSettings.fields.attributes")}</label>
      {allDefs && allDefs.length === 0 && (
        <p className="muted small" style={{ margin: 0 }}>
          {t("folderSettings.noAttributes")}
        </p>
      )}
      <div style={{ display: "grid", gap: 6, maxHeight: 220, overflow: "auto" }}>
        {allDefs?.map((d) => {
          const inherited = inheritedIds.has(d.id);
          return (
            <label key={d.id} className="row" style={{ margin: 0, color: "var(--text)", fontSize: 13 }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                disabled={inherited || !bound}
                checked={inherited || !!bound?.has(d.id)}
                onChange={(e) =>
                  setBound((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.add(d.id);
                    else n.delete(d.id);
                    return n;
                  })
                }
              />
              <span>
                {d.name}
                {d.required && <span style={{ color: "var(--danger)" }}> *</span>}
              </span>
              <span className="badge">{label("attributeType", d.type)}</span>
              {inherited && <span className="badge info">{t("folderSettings.badges.inherited")}</span>}
            </label>
          );
        })}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        {!isRoot && (
          <button className="danger" style={{ marginRight: "auto" }} onClick={() => void remove()}>
            {t("folderSettings.actions.delete")}
          </button>
        )}
        <button onClick={() => setWhoOpen(true)}>{t("permissions.actions.whoCanSee")}</button>
        <button onClick={onClose}>{t("common:actions.cancel")}</button>
        <button className="primary" onClick={() => void save()}>
          {t("common:actions.save")}
        </button>
      </div>
      {whoOpen && <WhoCanSeeDialog projectId={projectId} folderId={folder.id} onClose={() => setWhoOpen(false)} />}
    </Dialog>
  );
}
