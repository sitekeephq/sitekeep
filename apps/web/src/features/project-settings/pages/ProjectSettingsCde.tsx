import { useTranslation } from "react-i18next";
import { api } from "../../../shared/api/api";
import { cdeApi } from "../../../shared/api/api-cde";
import { useLoad, useProject } from "../../../app/context/project";
import { CdeCodeConflicts } from "../components/CdeCodeConflicts";
import { TaskTeamsSection } from "./TaskTeamsSection";
import { CdeCodesSettings } from "./CdeCodesSettings";
import { CdeTransitionsEditor } from "./CdeTransitionsEditor";

/**
 * Proje Ayarları → CDE: the project's ISO 19650 settings (docs/features/CDE_STATES.md): the codes
 * (ISO-2, CdeCodesSettings), the transitions with the enforcement switch and the archive folder
 * (ISO-1, CdeTransitionsEditor) and task teams (ISO-5, TaskTeamsSection).
 */
export function CdeSettings() {
  const { t } = useTranslation("cde");
  const project = useProject();
  const { data: s, error, setData: setSettings } = useLoad(() => cdeApi.settings(project.id), [project.id]);
  const { data: workflows } = useLoad(() => api.workflowTemplates(project.id, "review").catch(() => []), [project.id]);

  if (error) return <p className="error">{error}</p>;
  if (!s) return <p className="muted">…</p>;
  return (
    <div className="stack" data-testid="cde-settings">
      <p className="muted" style={{ margin: 0 }}>
        {t("settings.description")}
      </p>

      <CdeCodesSettings settings={s} onSaved={setSettings} />

      <CdeTransitionsEditor key={s.updatedAt ?? "new"} settings={s} workflows={workflows} onSaved={setSettings} />

      <TaskTeamsSection settings={s} onSettings={setSettings} />

      <CdeCodeConflicts projectId={project.id} settings={s} onSaved={setSettings} />
    </div>
  );
}
