import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PERMISSION_LEVELS, type FolderDto, type PermissionLevel, type SubjectType } from "@sitekeep/shared";
import { useLabel } from "../../../i18n";
import { api } from "../../../shared/api/api";
import { documentsApi } from "../api";
import { useLoad } from "../../../app/context/project";
import { Dialog } from "../../../shared/ui/Dialog";
import { WhoCanSeeDialog } from "./WhoCanSeeDialog";

const LEVELS = PERMISSION_LEVELS.filter((l) => l !== "none");

/** Result statuses with a sentence of their own (permissions.status.*); others show the raw status. */
const KNOWN_STATUSES = new Set(["ok", "skipped_existing"]);

export function PermissionsDialog({
  projectId,
  folder,
  onClose,
}: {
  projectId: string;
  folder: FolderDto;
  onClose(): void;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const label = useLabel();
  const { data: grants, error, setData } = useLoad(() => documentsApi.permissions(projectId, folder.id), [projectId, folder.id]);
  const { data: members } = useLoad(() => api.members(projectId), [projectId]);
  const { data: companies } = useLoad(() => api.companies(), []);
  const { data: roles } = useLoad(() => api.roles(projectId), [projectId]);
  const [whoOpen, setWhoOpen] = useState(false);
  const [subjectType, setSubjectType] = useState<SubjectType>("user");
  const [subjectId, setSubjectId] = useState("");
  const [level, setLevel] = useState<PermissionLevel>("view_download");
  const [msg, setMsg] = useState<string | null>(null);

  async function save(entries: { subjectType: SubjectType; subjectId: string; level: PermissionLevel }[]) {
    setMsg(null);
    try {
      const r = await documentsApi.setPermissions(projectId, folder.id, entries, "replace");
      setData(r.grants);
      const problems = r.results.filter((x) => x.status !== "ok");
      if (problems.length)
        setMsg(
          problems
            .map((p) =>
              p.status.startsWith("rejected_lower_than_inherited")
                ? t("permissions.errors.lowerThanInherited", { level: label("level", p.status.split(":")[1]!) })
                : KNOWN_STATUSES.has(p.status)
                  ? t(`permissions.status.${p.status as "ok" | "skipped_existing"}`)
                  : p.status,
            )
            .join(" "),
        );
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  const options =
    subjectType === "user"
      ? (members ?? []).map((m) => ({ id: m.userId, label: `${m.name} (${m.email})` }))
      : subjectType === "company"
        ? (companies ?? []).map((c) => ({ id: c.id, label: c.name }))
        : (roles ?? []).map((r) => ({ id: r.id, label: t("permissions.roleOption", { name: r.name, count: r.memberIds.length }) }));

  return (
    <Dialog title={t("permissions.title", { folder: folder.name })} onClose={onClose} wide>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("permissions.help")}
      </p>
      {error && <p className="error">{error}</p>}
      <table className="phone-cards">
        <thead>
          <tr>
            <th>{t("permissions.columns.who")}</th>
            <th style={{ width: 90 }}>{t("common:fields.type")}</th>
            <th style={{ width: 230 }}>{t("permissions.columns.level")}</th>
            <th style={{ width: 90 }} />
          </tr>
        </thead>
        <tbody>
          {grants?.map((g) => (
            <tr key={`${g.subjectType}:${g.subjectId}`}>
              <td className="pc-title">
                {g.subjectName ?? g.subjectId}
                {g.inherited && <span className="badge" style={{ marginLeft: 6 }}>{t("permissions.inherited")}</span>}
              </td>
              <td className="muted" data-label={t("common:fields.type")}>{g.subjectType === "user" ? t("permissions.subjects.user") : g.subjectType === "company" ? t("common:fields.company") : t("permissions.subjects.role")}</td>
              <td data-label={t("permissions.columns.level")}>
                <select
                  value={g.level}
                  onChange={(e) => void save([{ subjectType: g.subjectType, subjectId: g.subjectId, level: e.target.value as PermissionLevel }])}
                >
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {label("level", l)}
                    </option>
                  ))}
                </select>
              </td>
              <td className="pc-actions">
                {!g.inherited && (
                  <button
                    className="small danger"
                    onClick={() => void save([{ subjectType: g.subjectType, subjectId: g.subjectId, level: "none" }])}
                  >
                    {t("common:actions.remove")}
                  </button>
                )}
              </td>
            </tr>
          ))}
          {grants && grants.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">{t("permissions.empty")}</td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 style={{ marginTop: 16 }}>{t("permissions.addHeading")}</h3>
      <div className="row wrap">
        <select style={{ width: "min(120px, 100%)", flex: "1 1 100px" }} value={subjectType} onChange={(e) => { setSubjectType(e.target.value as SubjectType); setSubjectId(""); }}>
          <option value="user">{t("permissions.subjects.user")}</option>
          <option value="company">{t("common:fields.company")}</option>
          <option value="role">{t("permissions.subjects.roleTeam")}</option>
        </select>
        <select style={{ flex: "1 1 180px", minWidth: 0, width: "min(220px, 100%)" }} value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
          <option value="">{t("permissions.choose")}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <select style={{ width: "min(230px, 100%)", flex: "1 1 160px" }} value={level} onChange={(e) => setLevel(e.target.value as PermissionLevel)}>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {label("level", l)}
            </option>
          ))}
        </select>
        <button className="primary" disabled={!subjectId} onClick={() => void save([{ subjectType, subjectId, level }])}>
          {t("common:actions.add")}
        </button>
      </div>
      {subjectType === "role" && roles?.length === 0 && (
        <p className="muted small">{t("permissions.noRoles")}</p>
      )}
      {msg && <p className="notice small">{msg}</p>}
      <div className="dialog-actions">
        <button style={{ marginRight: "auto" }} onClick={() => setWhoOpen(true)}>
          {t("permissions.actions.whoCanSee")}
        </button>
        <button onClick={onClose}>{t("common:actions.close")}</button>
      </div>
      {whoOpen && <WhoCanSeeDialog projectId={projectId} folderId={folder.id} onClose={() => setWhoOpen(false)} />}
    </Dialog>
  );
}
