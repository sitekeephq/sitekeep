import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CdeSettingsDto, CdeWipPolicy, ProjectRoleDto } from "@sitekeep/shared";
import { CDE_WIP_POLICIES } from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { cdeApi } from "../../../shared/api/api-cde";
import { teamsApi } from "../../../shared/api/api-teams";
import { useLoad, useProject } from "../../../app/context/project";
import { useAsk } from "../../../shared/ui/Ask";

/**
 * Proje Ayarları → CDE → Task teams (ISO-5, docs/features/TASK_TEAMS.md): who sees WIP, the
 * project's task teams (project roles of kind 'task_team') and their members. Project
 * administrators edit; everyone else reads.
 */
export function TaskTeamsSection({ settings, onSettings }: { settings: CdeSettingsDto; onSettings(s: CdeSettingsDto): void }) {
  const { t } = useTranslation(["cde", "common"]);
  const project = useProject();
  const admin = !!project.isProjectAdmin;
  const { confirm } = useAsk();
  const { data: roles, reload, error: rolesError } = useLoad(() => api.roles(project.id), [project.id]);
  const { data: members } = useLoad(() => api.members(project.id), [project.id]);
  const { data: companies } = useLoad(() => api.projectCompanies(project.id).catch(() => []), [project.id]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", code: "", companyId: "" });
  const teams = (roles ?? []).filter((r) => r.kind === "task_team");
  const companyName = (id: string | null | undefined) => (id ? (companies?.find((c) => c.id === id)?.name ?? "") : "");
  const memberName = (uid: string) => members?.find((m) => m.userId === uid)?.name ?? uid.slice(0, 8);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    setNotice(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const saveSettings = (input: { wipPolicy?: CdeWipPolicy; adminSeesWip?: boolean }) =>
    run(async () => onSettings(await cdeApi.saveSettings(project.id, input)));

  async function remove(team: ProjectRoleDto) {
    const ok = await confirm({
      title: t("teams.actions.delete"),
      message: t("teams.deleteConfirm", { name: team.name }),
      confirmLabel: t("common:actions.delete"),
      danger: true,
    });
    if (ok) await run(() => teamsApi.remove(project.id, team.id));
  }

  return (
    <section className="card stack" data-section="teams" data-testid="task-teams">
      <h3 style={{ margin: 0 }}>{t("settings.teams.heading")}</h3>
      <p className="muted small" style={{ margin: 0 }}>
        {t("teams.description")}
      </p>
      <table className="props-table">
        <tbody>
          <tr>
            <td>{t("settings.teams.wipPolicy")}</td>
            <td>
              {admin ? (
                <select
                  data-testid="wip-policy"
                  value={settings.wipPolicy}
                  onChange={(e) => void saveSettings({ wipPolicy: e.target.value as CdeWipPolicy })}
                >
                  {CDE_WIP_POLICIES.map((p) => (
                    <option key={p} value={p}>
                      {t(`wipPolicies.${p}`)}
                    </option>
                  ))}
                </select>
              ) : (
                t(`wipPolicies.${settings.wipPolicy}`)
              )}
              <div className="muted small">{t(`teams.policyHelp.${settings.wipPolicy}`)}</div>
            </td>
          </tr>
          <tr>
            <td>{t("settings.teams.adminSeesWip")}</td>
            <td>
              <label className="row" style={{ margin: 0, color: "var(--text)", fontSize: 13 }}>
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  disabled={!admin}
                  checked={settings.adminSeesWip}
                  onChange={(e) => void saveSettings({ adminSeesWip: e.target.checked })}
                />
                {settings.adminSeesWip ? t("settings.yes") : t("settings.no")}
              </label>
            </td>
          </tr>
        </tbody>
      </table>

      {rolesError && <p className="error">{rolesError}</p>}
      {teams.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          {t("teams.empty")}
        </p>
      ) : (
        <table className="phone-cards">
          <thead>
            <tr>
              <th>{t("teams.columns.team")}</th>
              <th>{t("teams.columns.code")}</th>
              <th>{t("teams.columns.company")}</th>
              <th>{t("teams.columns.members")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {teams.map((team) => (
              <tr key={team.id} data-team={team.name}>
                <td className="pc-title">
                  {team.name}
                  {team.isLead && (
                    <span className="badge info" style={{ marginLeft: 6 }}>
                      {t("teams.lead")}
                    </span>
                  )}
                </td>
                <td data-label={t("teams.columns.code")} className="mono small">
                  {team.code ?? "—"}
                </td>
                <td data-label={t("teams.columns.company")}>{companyName(team.companyId) || "—"}</td>
                <td data-label={t("teams.columns.members")}>
                  <div className="row wrap" style={{ gap: 4 }}>
                    {team.memberIds.map((uid) => (
                      <span key={uid} className="badge">
                        {memberName(uid)}
                        {admin && (
                          <button
                            className="small link"
                            aria-label={t("teams.actions.removeMember", { name: memberName(uid) })}
                            onClick={() => void run(() => teamsApi.removeMember(project.id, team.id, uid))}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    ))}
                    {admin && (
                      <select
                        aria-label={t("teams.actions.addMember")}
                        value=""
                        style={{ width: "auto" }}
                        onChange={(e) => e.target.value && void run(() => teamsApi.addMember(project.id, team.id, e.target.value))}
                      >
                        <option value="">{t("teams.actions.addMember")}</option>
                        {(members ?? [])
                          .filter((m) => !team.memberIds.includes(m.userId))
                          .map((m) => (
                            <option key={m.userId} value={m.userId}>
                              {m.name}
                            </option>
                          ))}
                      </select>
                    )}
                  </div>
                </td>
                <td className="pc-actions">
                  {admin && (
                    <>
                      <button className="small" onClick={() => void run(() => teamsApi.update(project.id, team.id, { isLead: !team.isLead }))}>
                        {team.isLead ? t("teams.actions.unsetLead") : t("teams.actions.setLead")}
                      </button>
                      <button className="small danger" onClick={() => void remove(team)}>
                        {t("common:actions.delete")}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {admin && (
        <>
          <div className="row wrap">
            <input
              style={{ flex: "2 1 180px" }}
              placeholder={t("teams.fields.name")}
              aria-label={t("teams.fields.name")}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <input
              style={{ flex: "1 1 80px" }}
              placeholder={t("teams.fields.code")}
              aria-label={t("teams.fields.code")}
              value={draft.code}
              onChange={(e) => setDraft({ ...draft, code: e.target.value })}
            />
            <select
              style={{ flex: "2 1 160px" }}
              aria-label={t("teams.fields.company")}
              value={draft.companyId}
              onChange={(e) => {
                const c = companies?.find((x) => x.id === e.target.value);
                setDraft({ name: draft.name || c?.name || "", code: draft.code || c?.code || "", companyId: e.target.value });
              }}
            >
              <option value="">{t("teams.fields.noCompany")}</option>
              {(companies ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              className="primary"
              disabled={!draft.name.trim()}
              onClick={() =>
                void run(async () => {
                  await teamsApi.create(project.id, {
                    name: draft.name.trim(),
                    code: draft.code.trim() || null,
                    companyId: draft.companyId || null,
                  });
                  setDraft({ name: "", code: "", companyId: "" });
                })
              }
            >
              {t("teams.actions.create")}
            </button>
          </div>
          <div>
            <button
              className="small"
              onClick={() =>
                void run(async () => {
                  const r = await teamsApi.seed(project.id);
                  setNotice(t("teams.seeded", { count: r.created, folders: r.foldersOwned }));
                })
              }
            >
              {t("teams.actions.seed")}
            </button>
          </div>
        </>
      )}
      {notice && <p className="notice small">{notice}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
