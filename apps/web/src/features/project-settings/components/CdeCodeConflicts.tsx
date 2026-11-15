import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CdeSettingsDto } from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { cdeApi } from "../../../shared/api/api-cde";
import { request } from "../../../shared/api/client";
import { useLoad, useProject } from "../../../app/context/project";

interface ConflictFile {
  fileId: string;
  name: string;
  path: string;
  createdAt: string;
}
interface CodeConflict {
  code: string;
  holder: ConflictFile | null;
  others: ConflictFile[];
}

/**
 * Proje Ayarları → CDE → Document Code Standard (ISO-3, docs/features/DOCUMENT_CODES.md): the naming
 * standard that gives files in folders without one of their own a document code
 * (`project_cde_settings.container_standard_id`). Project administrators change it.
 */
function DocumentCodeStandard({ settings, onSaved }: { settings: CdeSettingsDto; onSaved(s: CdeSettingsDto): void }) {
  const { t } = useTranslation("cde");
  const project = useProject();
  const isAdmin = !!project.isProjectAdmin;
  const { data: standards } = useLoad(() => api.namingStandards(project.id).catch(() => []), [project.id]);
  const [value, setValue] = useState(settings.containerStandardId ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      onSaved(await cdeApi.saveSettings(project.id, { containerStandardId: value || null }));
      setMessage({ ok: true, text: t("documentCode.standard.saved") });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="cde-container-standard">
      <label htmlFor="cde-container-standard">{t("documentCode.standard.label")}</label>
      <div className="row wrap">
        <select id="cde-container-standard" value={value} disabled={!isAdmin} onChange={(e) => setValue(e.target.value)} style={{ width: "auto" }}>
          <option value="">{t("documentCode.standard.none")}</option>
          {(standards ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.definition.name}
            </option>
          ))}
        </select>
        {isAdmin && (
          <button className="primary small" disabled={busy || value === (settings.containerStandardId ?? "")} onClick={() => void save()}>
            {t("documentCode.standard.save")}
          </button>
        )}
        {message && <span className={message.ok ? "muted small" : "error small"}>{message.text}</span>}
      </div>
      <p className="muted small" style={{ margin: "4px 0 0" }}>
        {t("documentCode.standard.help")}
      </p>
    </div>
  );
}

/**
 * Proje Ayarları → CDE → Document codes (ISO-3, docs/features/DOCUMENT_CODES.md): the document code
 * standard, and the files from before unique document codes that use a code registered to another
 * document. The conflicts list is for project administrators only (hidden for others).
 */
export function CdeCodeConflicts({ projectId, settings, onSaved }: { projectId: string; settings: CdeSettingsDto; onSaved(s: CdeSettingsDto): void }) {
  const { t } = useTranslation("cde");
  const { data, error } = useLoad(
    () => request<{ conflicts: CodeConflict[] }>("GET", `/projects/${projectId}/cde/code-conflicts`),
    [projectId],
  );
  if (error)
    return (
      <section className="card stack" data-section="code-conflicts">
        <DocumentCodeStandard settings={settings} onSaved={onSaved} />
      </section>
    );
  return (
    <section className="card stack" data-section="code-conflicts" data-testid="cde-code-conflicts">
      <DocumentCodeStandard settings={settings} onSaved={onSaved} />
      <h3 style={{ margin: 0 }}>{t("documentCode.conflicts.heading")}</h3>
      <p className="muted small" style={{ margin: 0 }}>
        {t("documentCode.conflicts.description")}
      </p>
      {!data ? (
        <p className="muted">…</p>
      ) : data.conflicts.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          {t("documentCode.conflicts.empty")}
        </p>
      ) : (
        <table className="phone-cards">
          <thead>
            <tr>
              <th>{t("documentCode.conflicts.code")}</th>
              <th>{t("documentCode.conflicts.holder")}</th>
              <th>{t("documentCode.conflicts.others")}</th>
            </tr>
          </thead>
          <tbody>
            {data.conflicts.map((c) => (
              <tr key={c.code}>
                <td className="mono pc-title">{c.code}</td>
                <td className="small" data-label={t("documentCode.conflicts.holder")}>
                  {c.holder ? <span className="mono">{c.holder.path}</span> : <span className="muted">—</span>}
                </td>
                <td className="small" data-label={t("documentCode.conflicts.others")}>
                  {c.others.map((o) => (
                    <div key={o.fileId} className="mono">
                      {o.path}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
