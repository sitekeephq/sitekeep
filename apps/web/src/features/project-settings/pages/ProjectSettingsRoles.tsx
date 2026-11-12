import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  WRITING_ACTIONS,
  type FolderState,
  type ProjectRoleDto,
  type RolePackageAction,
  type RolePackageKey,
  type RolePackagePlanDto,
} from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { documentsApi } from "../../documents/api";
import { useLoad, useProject } from "../../../app/context/project";
import { useAsk } from "../../../shared/ui/Ask";
import { Dialog } from "../../../shared/ui/Dialog";
import { FolderTree } from "../../documents/components/FolderTree";
import { useLabel } from "../../../i18n";

/** Small coloured chip for a project role. */
export function RoleChip({ role }: { role: Pick<ProjectRoleDto, "name" | "color" | "description"> }) {
  return (
    <span
      className={`badge${role.color ? "" : " info"}`}
      title={role.description ?? undefined}
      style={role.color ? { background: role.color, color: "#fff", borderColor: "transparent" } : undefined}
    >
      {role.name}
    </span>
  );
}

/** Project settings tab "Roller": roles (teams), member matrix and role packages. */
/** `advanced`: also the role package wizard (fine folder permissions per company). */
export function RolesSettings({ advanced = true }: { advanced?: boolean }) {
  const { t } = useTranslation(["projectSettings", "common"]);
  const { confirm } = useAsk();
  const project = useProject();
  const { data: roles, error, reload } = useLoad(() => api.roles(project.id), [project.id]);
  const { data: members } = useLoad(() => api.members(project.id), [project.id]);
  const [editing, setEditing] = useState<ProjectRoleDto | "new" | null>(null);
  const [wizard, setWizard] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function remove(r: ProjectRoleDto) {
    if (
      !(await confirm({
        title: t("roles.remove.title"),
        message: t("roles.remove.confirm", { name: r.name }),
        confirmLabel: t("common:actions.delete"),
        danger: true,
      }))
    )
      return;
    await act(async () => {
      const res = await api.deleteRole(project.id, r.id);
      if (res.removedGrants) setMsg(t("roles.messages.grantsRemoved", { count: res.removedGrants }));
    });
  }

  return (
    <div className="stack">
      <div className="row">
        <p className="muted" style={{ margin: 0 }}>
          {t("roles.description")}
        </p>
        <div className="spacer" />
        {advanced && <button onClick={() => setWizard(true)}>{t("roles.actions.applyPackage")}</button>}
        <button className="primary" onClick={() => setEditing("new")}>
          {t("roles.actions.add")}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {msg && <p className="notice small">{msg}</p>}

      <div className="card" style={{ padding: 0 }}>
        <table className="phone-cards">
          <thead>
            <tr>
              <th style={{ width: 260 }}>{t("roles.columns.role")}</th>
              <th>{t("roles.columns.description")}</th>
              <th style={{ width: 90 }}>{t("roles.columns.members")}</th>
              <th style={{ width: 150 }} />
            </tr>
          </thead>
          <tbody>
            {roles?.map((r) => (
              <tr key={r.id}>
                <td className="pc-title">
                  <RoleChip role={r} />
                </td>
                <td className="muted small">{r.description}</td>
                <td className="pc-inline" data-label={t("roles.columns.members")}>{r.memberIds.length}</td>
                <td className="pc-actions">
                  <div className="row" style={{ gap: 4 }}>
                    <button className="small" onClick={() => setEditing(r)}>
                      {t("common:actions.edit")}
                    </button>
                    <button className="small danger" onClick={() => void remove(r)}>
                      {t("common:actions.delete")}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {roles?.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  {t("roles.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!!roles?.length && !!members?.length && (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <h3 style={{ padding: "12px 12px 0" }}>{t("roles.matrix.heading")}</h3>
          <table className="phone-cards">
            <thead>
              <tr>
                <th style={{ minWidth: 200 }}>{t("roles.matrix.columns.member")}</th>
                {roles.map((r) => (
                  <th key={r.id} style={{ textAlign: "center", minWidth: 110 }}>
                    <RoleChip role={r} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId}>
                  <td className="pc-title">
                    {m.name}
                    <div className="muted small">{m.companyName ?? t("roles.matrix.noCompany")}</div>
                  </td>
                  {roles.map((r) => {
                    const on = r.memberIds.includes(m.userId);
                    return (
                      <td key={r.id} style={{ textAlign: "center" }} className="pc-inline" data-label={r.name}>
                        <input
                          type="checkbox"
                          style={{ width: "auto" }}
                          aria-label={t("roles.matrix.cellLabel", { member: m.name, role: r.name })}
                          checked={on}
                          onChange={() =>
                            void act(() =>
                              on ? api.removeRoleMember(project.id, r.id, m.userId) : api.addRoleMember(project.id, r.id, m.userId),
                            )
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <RoleEditor
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {wizard && <RolePackageWizard onClose={() => setWizard(false)} />}
    </div>
  );
}

function RoleEditor({ initial, onClose, onSaved }: { initial: ProjectRoleDto | null; onClose(): void; onSaved(): void }) {
  const { t } = useTranslation(["projectSettings", "common"]);
  const project = useProject();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [color, setColor] = useState(initial?.color ?? "");
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const body = { name, description: description.trim() || null, color: color || null };
    try {
      if (initial) await api.updateRole(project.id, initial.id, body);
      else await api.createRole(project.id, body);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Dialog title={initial ? t("roles.editor.editTitle") : t("roles.editor.newTitle")} onClose={onClose}>
      <label>{t("common:fields.name")}</label>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("roles.editor.namePlaceholder")} />
      <label>{t("common:fields.description")}</label>
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("roles.editor.descriptionPlaceholder")} />
      <label>{t("common:fields.color")}</label>
      <div className="row">
        <input type="color" style={{ width: 60, padding: 2 }} value={color || "#1f4e79"} onChange={(e) => setColor(e.target.value)} />
        {color && (
          <button className="small" onClick={() => setColor("")}>
            {t("roles.editor.actions.defaultColour")}
          </button>
        )}
        <RoleChip role={{ name: name || t("roles.editor.previewName"), color: color || null, description: null }} />
      </div>
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button onClick={onClose}>{t("common:actions.cancel")}</button>
        <button className="primary" disabled={!name.trim()} onClick={() => void save()}>
          {t("common:actions.save")}
        </button>
      </div>
    </Dialog>
  );
}

const ACTION_TONE: Record<RolePackageAction, string> = {
  create: "ok",
  upgrade: "ok",
  unchanged: "",
  kept_higher: "info",
  covered_by_inherited: "",
  rejected_lower_than_inherited: "warn",
  no_grant: "",
};

/** "Firmaya rol paketi uygula": choose company + package (+ own area), preview, then apply. */
function RolePackageWizard({ onClose }: { onClose(): void }) {
  const { t } = useTranslation(["projectSettings", "common"]);
  const label = useLabel();
  const project = useProject();
  const { data: packages } = useLoad(() => api.rolePackages(project.id), [project.id]);
  const { data: companies } = useLoad(() => api.companies(), []);
  const [companyId, setCompanyId] = useState("");
  const [pkg, setPkg] = useState<RolePackageKey>("tasarimci");
  const [useArea, setUseArea] = useState(false);
  const [areaId, setAreaId] = useState<string | null>(null);
  const { data: area } = useLoad(
    () => (areaId ? documentsApi.folder(project.id, areaId) : Promise.resolve(null)),
    [project.id, areaId],
  );
  const [plan, setPlan] = useState<RolePackagePlanDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = packages?.find((p) => p.key === pkg);
  const input = { companyId, package: pkg, areaFolderId: useArea ? areaId : null };

  async function run(apply: boolean) {
    setError(null);
    setBusy(true);
    try {
      setPlan(apply ? await api.applyRolePackage(project.id, input) : await api.previewRolePackage(project.id, input));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Any change of the inputs invalidates the preview.
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPlan(null);
  };

  return (
    <Dialog title={t("rolePackage.title")} onClose={onClose} wide>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("rolePackage.description")}
      </p>
      <div className="row wrap" style={{ alignItems: "flex-end" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label>{t("common:fields.company")}</label>
          <select value={companyId} onChange={(e) => reset(setCompanyId)(e.target.value)}>
            <option value="">{t("rolePackage.options.choose")}</option>
            {companies?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div style={{ width: 200 }}>
          <label>{t("rolePackage.fields.package")}</label>
          <select value={pkg} onChange={(e) => reset(setPkg)(e.target.value as RolePackageKey)}>
            {packages?.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {selected && (
        <div className="card" style={{ padding: 10, marginTop: 10 }}>
          <div className="small">{selected.description}</div>
          <div className="row wrap small" style={{ gap: 6, marginTop: 6 }}>
            {(Object.keys(selected.states) as FolderState[]).map((s) => (
              <span key={s} className="badge">
                {t("rolePackage.stateLevel", {
                  state: label("folderState", s),
                  level: selected.states[s] === "none" ? t("rolePackage.noAccess") : label("level", selected.states[s]),
                })}
              </span>
            ))}
            <span className="badge info">{t("rolePackage.ownAreaLevel", { level: label("level", selected.ownArea) })}</span>
          </div>
        </div>
      )}
      <label className="row" style={{ color: "var(--text)", fontSize: 13, marginTop: 12 }}>
        <input type="checkbox" style={{ width: "auto" }} checked={useArea} onChange={(e) => reset(setUseArea)(e.target.checked)} />
        {t("rolePackage.options.hasOwnArea")}
      </label>
      {useArea && (
        <div className="row" style={{ alignItems: "stretch", gap: 12 }}>
          <div className="card" style={{ flex: 1, maxHeight: 220, overflow: "auto", padding: "8px 0" }}>
            <FolderTree
              projectId={project.id}
              rootId={project.rootFolderId}
              activeId={areaId ?? project.rootFolderId}
              version={0}
              onSelect={reset(setAreaId)}
            />
          </div>
          <div style={{ width: 240 }} className="small">
            <div className="muted">{t("rolePackage.fields.ownArea")}</div>
            <strong>{area ? area.path.map((p) => p.name).join(" / ") : t("rolePackage.notSelected")}</strong>
          </div>
        </div>
      )}

      {plan && (
        <>
          <h3 style={{ marginTop: 16 }}>
            {t("rolePackage.resultHeading", {
              status: plan.applied ? t("rolePackage.status.applied") : t("rolePackage.status.preview"),
              company: plan.companyName,
            })}
          </h3>
          <p className="small" style={{ marginTop: 0 }}>
            {plan.applied ? t("rolePackage.written", { count: plan.writes }) : t("rolePackage.toWrite", { count: plan.writes })}{" "}
            {plan.memberCount === 0 && (
              <span className="notice">{t("rolePackage.noMembers")}</span>
            )}
          </p>
          <table className="phone-cards">
            <thead>
              <tr>
                <th>{t("rolePackage.columns.folder")}</th>
                <th style={{ width: 120 }}>{t("rolePackage.columns.state")}</th>
                <th style={{ width: 170 }}>{t("rolePackage.columns.packageLevel")}</th>
                <th style={{ width: 150 }}>{t("rolePackage.columns.current")}</th>
                <th style={{ width: 220 }}>{t("rolePackage.columns.result")}</th>
              </tr>
            </thead>
            <tbody>
              {plan.entries.map((e) => (
                <tr key={e.folderId}>
                  <td className="small">
                    {e.folderPath}
                    {e.reason === "own_area" && <span className="badge info" style={{ marginLeft: 6 }}>{t("rolePackage.badges.ownArea")}</span>}
                  </td>
                  <td className="small muted">{e.state ? label("folderState", e.state) : "—"}</td>
                  <td className="small">{e.level === "none" ? "—" : label("level", e.level)}</td>
                  <td className="small muted">
                    {e.current ? label("level", e.current) : "—"}
                    {e.inherited !== "none" && <div>{t("rolePackage.inherited", { level: label("level", e.inherited) })}</div>}
                  </td>
                  <td>
                    <span className={`badge ${ACTION_TONE[e.action]}`}>{label("rolePackageAction", e.action)}</span>
                  </td>
                </tr>
              ))}
              {plan.entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    {t("rolePackage.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button onClick={onClose}>{plan?.applied ? t("common:actions.close") : t("common:actions.cancel")}</button>
        <button disabled={busy || !companyId || (useArea && !areaId)} onClick={() => void run(false)}>
          {t("rolePackage.actions.preview")}
        </button>
        <button
          className="primary"
          disabled={busy || !plan || plan.applied || !plan.entries.some((e) => WRITING_ACTIONS.includes(e.action))}
          onClick={() => void run(true)}
        >
          {t("rolePackage.actions.apply")}
        </button>
      </div>
    </Dialog>
  );
}
