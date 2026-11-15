import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { FolderDto } from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { teamsApi } from "../../../shared/api/api-teams";
import { documentsApi } from "../api";
import { useLoad, useProject } from "../../../app/context/project";

/**
 * Folder settings → Owner task team (ISO-5, docs/features/TASK_TEAMS.md). Shown for WIP folders;
 * project administrators change it (saved at once), others read it. Under the "owning task team
 * only" policy the folder is closed to everyone outside the team.
 */
export function OwnerTeamField({ folder, onChanged }: { folder: FolderDto; onChanged(): void }) {
  const { t } = useTranslation("cde");
  const project = useProject();
  const { data: roles } = useLoad(() => api.roles(project.id), [project.id]);
  // The CDE state is the folder's own or its nearest ancestor's (the breadcrumb path).
  const { data: withPath } = useLoad(() => documentsApi.folder(project.id, folder.id), [project.id, folder.id]);
  const isWip = [...(withPath?.path ?? [])].reverse().find((f) => f.state)?.state === "wip";
  const [value, setValue] = useState(folder.ownerTeamId ?? "");
  const [error, setError] = useState<string | null>(null);
  if (!isWip || folder.parentId === null) return null;
  const teams = (roles ?? []).filter((r) => r.kind === "task_team");

  async function change(teamId: string) {
    setError(null);
    const before = value;
    setValue(teamId);
    try {
      await teamsApi.setOwnerTeam(project.id, folder.id, teamId || null);
      onChanged();
    } catch (e) {
      setValue(before);
      setError((e as Error).message);
    }
  }

  return (
    <>
      <label>{t("teams.ownerTeam.label")}</label>
      <select data-testid="owner-team" value={value} disabled={!project.isProjectAdmin} onChange={(e) => void change(e.target.value)}>
        <option value="">{t("teams.ownerTeam.none")}</option>
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.code ? `${team.name} (${team.code})` : team.name}
          </option>
        ))}
      </select>
      <p className="muted small" style={{ marginTop: 2 }}>
        {t("teams.ownerTeam.help")}
      </p>
      {error && <p className="error">{error}</p>}
    </>
  );
}
