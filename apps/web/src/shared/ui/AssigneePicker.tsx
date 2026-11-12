import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  WORKFLOW_ROLES,
  type AssigneeType,
  type CompanyDto,
  type MemberDto,
  type ProjectRoleDto,
  type WorkflowAssignee,
  type WorkflowRole,
} from "@sitekeep/shared";
import { i18n, label } from "../../i18n";

const ASSIGNEE_TYPES: AssigneeType[] = ["user", "company", "role"];

export function assigneeLabel(a: WorkflowAssignee, names: Record<string, string>): string {
  if (a.type === "role") {
    if ((WORKFLOW_ROLES as readonly string[]).includes(a.id)) return label("workflowRole", a.id as WorkflowRole);
    return names[a.id] ?? i18n.t("shell:assignee.deletedRole");
  }
  return names[a.id] ?? "?";
}

export function namesFrom(
  members: MemberDto[] | null,
  companies: CompanyDto[] | null,
  roles?: ProjectRoleDto[] | null,
): Record<string, string> {
  return {
    ...Object.fromEntries((members ?? []).map((m) => [m.userId, m.name])),
    ...Object.fromEntries((companies ?? []).map((c) => [c.id, c.name])),
    ...Object.fromEntries((roles ?? []).map((r) => [r.id, r.name])),
  };
}

/** Chips for the chosen assignees plus a "type → who → add" row. */
export function AssigneePicker({
  value,
  onChange,
  members,
  companies,
  roles,
  extraNames,
}: {
  value: WorkflowAssignee[];
  onChange(v: WorkflowAssignee[]): void;
  /** Names for assignees outside the lists (e.g. a role named in a flow description, not created yet). */
  extraNames?: Record<string, string>;
  members: MemberDto[] | null;
  companies: CompanyDto[] | null;
  /** Project roles (teams); any member holding the role may answer the step on its behalf. */
  roles?: ProjectRoleDto[] | null;
}) {
  const { t } = useTranslation(["shell", "common"]);
  const [type, setType] = useState<AssigneeType>("company");
  const [id, setId] = useState("");
  const names = { ...extraNames, ...namesFrom(members, companies, roles) };
  const options: { id: string; label: string }[] =
    type === "user"
      ? (members ?? []).map((m) => ({ id: m.userId, label: `${m.name}${m.companyName ? ` (${m.companyName})` : ""}` }))
      : type === "company"
        ? (companies ?? []).map((c) => ({ id: c.id, label: c.name }))
        : [
            ...(roles ?? []).map((r) => ({ id: r.id, label: t("assignee.roleMembers", { name: r.name, count: r.memberIds.length }) })),
            ...WORKFLOW_ROLES.map((r) => ({ id: r, label: label("workflowRole", r) })),
          ];
  const taken = new Set(value.map((a) => `${a.type}:${a.id}`));

  return (
    <div>
      <div className="row wrap" style={{ gap: 4, minHeight: 24 }}>
        {value.length === 0 && <span className="muted small">{t("assignee.none")}</span>}
        {value.map((a) => (
          <span key={`${a.type}:${a.id}`} className="badge info" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <span className="muted">{t(`assignee.types.${a.type}`)}:</span> {assigneeLabel(a, names)}
            <button
              type="button"
              className="ghost small"
              style={{ padding: "0 2px" }}
              aria-label={t("assignee.remove")}
              onClick={() => onChange(value.filter((x) => !(x.type === a.type && x.id === a.id)))}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <select
          style={{ width: 100 }}
          value={type}
          onChange={(e) => {
            setType(e.target.value as AssigneeType);
            setId("");
          }}
        >
          {ASSIGNEE_TYPES.map((k) => (
            <option key={k} value={k}>
              {t(`assignee.types.${k}`)}
            </option>
          ))}
        </select>
        <select value={id} onChange={(e) => setId(e.target.value)}>
          <option value="">{t("assignee.choose")}</option>
          {options
            .filter((o) => !taken.has(`${type}:${o.id}`))
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
        </select>
        <button
          type="button"
          disabled={!id}
          onClick={() => {
            onChange([...value, { type, id }]);
            setId("");
          }}
        >
          {t("common:actions.add")}
        </button>
      </div>
    </div>
  );
}
