import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useSearchParams } from "react-router-dom";
import type { ParseKeys } from "i18next";
import {
  PROJECT_MODULES,
  resolveModules,
  type NamingField,
  type NamingStandard,
  type NamingStandardDto,
  type ProjectModuleState,
  type UserPrefs,
} from "@sitekeep/shared";
import { api, formatDate } from "../../../shared/api/api";
import { useAuth } from "../../../app/context/auth";
import { useLoad, useProject } from "../../../app/context/project";
import { useAsk } from "../../../shared/ui/Ask";
import { Dialog } from "../../../shared/ui/Dialog";
import { WorkflowTemplates } from "./WorkflowTemplates";
import { WorkTypesSettings } from "./WorkTypes";

import { AttributeSettings } from "./ProjectSettingsDocs";

import { webCapability } from "../../../sdk/capabilities";
import { RoleChip, RolesSettings } from "./ProjectSettingsRoles";
import { LocationsPage } from "./Locations";
import { hubApi } from "../../../shared/api/api-hub";
import { SETTINGS_ADVANCED_LABEL, SETTINGS_TABS, type SettingsTabKey } from "../../../app/navigation/nav";
import { AdminStatusSection } from "../../admin/pages/AdminStatus";
import { i18n, useLabel } from "../../../i18n";

type ProjectSettingsKey = ParseKeys<"projectSettings">;


/**
 * Proje Ayarları (?sekme=…). Basic tabs are always visible; numbering, attributes, workflow design,
 * naming standards, trash and the activity log appear after "Gelişmiş Ayarları Göster" (remembered
 * per user on the server). Members who are not project administrators see only Konumlar.
 */
export function ProjectSettingsPage() {
  const { t: tp } = useTranslation("projectSettings");
  const { t: ts } = useTranslation("shell");
  const project = useProject();
  const { user } = useAuth();
  const admin = !!project.isProjectAdmin;
  const [search, setSearch] = useSearchParams();
  const { data: prefs, setData: setPrefs } = useLoad((): Promise<UserPrefs> => hubApi.prefs().catch(() => ({})), []);
  const advanced = !!prefs?.advancedSettings;
  // The project's AI settings tab is the AI module's.
  const ProjectAiSettings = webCapability("ai.ui")?.ProjectAiSettings;
  const settingsTabs = SETTINGS_TABS.filter((t) => t.key !== "yapay-zeka" || !!ProjectAiSettings);
  const visible = settingsTabs.filter((t) => {
    if (t.systemAdmin && !user?.isAdmin) return false;
    return admin ? !t.advanced || advanced : !!t.everyone;
  });
  const asked = search.get("sekme") as SettingsTabKey | null;
  // Autodesk lives on one page now (Forma Eşitleme); old links (and the sign-in return) go there.
  const autodesk = !!webCapability("connect.ui") && (asked === ("autodesk" as string) || asked === ("forma-esitleme" as string));
  // An advanced tab opened by its address shows even while the switch is off.
  const askedTab = settingsTabs.find((t) => t.key === asked && (t.systemAdmin ? !!user?.isAdmin : admin || t.everyone));
  const tab: SettingsTabKey = askedTab?.key ?? visible[0]?.key ?? "konumlar";
  const tabs = askedTab && !visible.includes(askedTab) ? [...visible, askedTab] : visible;
  const setTab = (k: SettingsTabKey) => setSearch({ sekme: k }, { replace: true });

  async function toggleAdvanced(on: boolean) {
    setPrefs({ ...(prefs ?? {}), advancedSettings: on });
    try {
      setPrefs(await hubApi.setPrefs({ advancedSettings: on }));
    } catch {
      // Not saved: the switch still works for this visit.
    }
  }

  if (autodesk) {
    const outcome = search.get("autodesk");
    return <Navigate to={`/projects/${project.id}/forma-esitleme${outcome ? `?autodesk=${outcome}` : ""}`} replace />;
  }

  return (
    <div className="page">
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>{tp("title")}</h1>
        <div className="spacer" />
        {admin && (
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={advanced} onChange={(e) => void toggleAdvanced(e.target.checked)} /> {ts(SETTINGS_ADVANCED_LABEL)}
          </label>
        )}
      </div>
      <div className="seg wrap settings-tabs" role="tablist" style={{ marginBottom: 16 }}>
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
            {ts(t.labelKey)}
          </button>
        ))}
      </div>
      {tab === "uyeler" && <Members />}
      {tab === "roller" && <RolesSettings advanced={advanced} />}
      {tab === "moduller" && <ModulesSettings />}
      {tab === "konumlar" && <LocationsPage embedded />}
      {tab === "sablon" && <TemplateExport />}
      {tab === "yapay-zeka" && ProjectAiSettings && <ProjectAiSettings />}
      {tab === "isimlendirme" && <Naming />}
      {tab === "is-akislari" && <WorkflowTemplates />}
      {tab === "is-tipleri" && <WorkTypesSettings />}
      {tab === "oznitelikler" && <AttributeSettings />}
      {tab === "aktivite" && <Activity />}
      {tab === "sistem-durumu" && user?.isAdmin && <AdminStatusSection />}
    </div>
  );
}

/**
 * Modüller: a project administrator turns modules off. Off = hidden from the menu, İşler, "+ Yeni",
 * the Model tabs, the "Sor" assistant and the report builder; the data is kept and existing records
 * still open, only new records are refused.
 */
/** Switches of Manage's categories (apps/server/src/projects/modules.ts PRODUCT_SWITCHES): off without Manage. */
const MANAGE_SWITCHES: readonly string[] = ["correspondence", "rfi", "submittals", "meetings", "spec"];

function ModulesSettings() {
  const { t } = useTranslation("projectSettings");
  const shown = PROJECT_MODULES.filter((m) => !MANAGE_SWITCHES.includes(m) || !!webCapability("manage.ui"));
  const label = useLabel();
  const project = useProject();
  const [modules, setModules] = useState<ProjectModuleState>(project.modules ?? resolveModules(null));
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    hubApi.modules(project.id).then(setModules, () => undefined);
  }, [project.id]);

  async function toggle(m: (typeof PROJECT_MODULES)[number], on: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      setModules(await hubApi.setModules(project.id, { [m]: on }));
      window.dispatchEvent(new Event("cde:project-changed"));
      setMsg(t("modules.messages.saved"));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <p className="muted" style={{ margin: 0 }}>
        {t("modules.description")}
      </p>
      <div className="modules-grid">
        {shown.map((m) => (
          <label key={m} className={`choice${modules[m] ? " selected" : ""}`}>
            <input type="checkbox" checked={modules[m]} disabled={busy} onChange={(e) => void toggle(m, e.target.checked)} />
            <strong>{label("projectModule", m)}</strong>
            <span className="muted">{t(`modules.help.${m}`)}</span>
          </label>
        ))}
      </div>
      {msg && <p className="notice small">{msg}</p>}
    </div>
  );
}

function Members() {
  const { t } = useTranslation(["projectSettings", "common"]);
  const { confirm } = useAsk();
  const project = useProject();
  const { data: members, error, reload } = useLoad(() => api.members(project.id), [project.id]);
  const { data: users } = useLoad(() => api.users(), []);
  const { data: companies } = useLoad(() => api.companies(), []);
  const { data: roles, reload: reloadRoles } = useLoad(() => api.roles(project.id), [project.id]);
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const memberIds = new Set(members?.map((m) => m.userId));
  const viewerRole = roles?.find((r) => r.name === "Görüntüleyici"); // i18n-ok: built-in role name (data)
  const chosenRole = roles?.find((r) => r.id === roleId) ?? viewerRole;
  const effectiveRoleId = roleId || viewerRole?.id || "";

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="card">
      {error && <p className="error">{error}</p>}
      <table className="phone-cards">
        <thead>
          <tr>
            <th>{t("members.columns.name")}</th>
            <th>{t("members.columns.email")}</th>
            <th style={{ width: 220 }}>{t("members.columns.company")}</th>
            <th>{t("members.columns.roles")}</th>
            <th style={{ width: 130 }}>{t("members.columns.projectAdmin")}</th>
            <th style={{ width: 80 }} />
          </tr>
        </thead>
        <tbody>
          {members?.map((m) => (
            <tr key={m.userId}>
              <td className="pc-title">{m.name}</td>
              <td className="muted">{m.email}</td>
              <td data-label={t("members.columns.company")}>
                <select
                  value={m.companyId ?? ""}
                  onChange={(e) => void act(() => api.updateMember(project.id, m.userId, { companyId: e.target.value || null }))}
                >
                  <option value="">—</option>
                  {companies?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </td>
              <td data-label={t("members.columns.roles")}>
                <div className="row wrap" style={{ gap: 4 }}>
                  {roles
                    ?.filter((r) => m.roleIds?.includes(r.id))
                    .map((r) => <RoleChip key={r.id} role={r} />)}
                  {!m.roleIds?.length && <span className="muted small">—</span>}
                </div>
              </td>
              <td className="pc-inline" data-label={t("members.columns.projectAdmin")}>
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  aria-label={t("members.projectAdminLabel", { name: m.name })}
                  checked={m.isProjectAdmin}
                  onChange={(e) => void act(() => api.updateMember(project.id, m.userId, { isProjectAdmin: e.target.checked }))}
                />
              </td>
              <td className="pc-actions">
                <button
                  className="small danger"
                  onClick={() =>
                    void confirm({
                      title: t("members.remove.title"),
                      message: t("members.remove.confirm", { name: m.name }),
                      confirmLabel: t("members.actions.remove"),
                      danger: true,
                    }).then((ok) => {
                      if (ok) return act(() => api.removeMember(project.id, m.userId));
                    })
                  }
                >
                  {t("members.actions.remove")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 style={{ marginTop: 16 }}>{t("members.add.heading")}</h3>
      <div className="row wrap">
        <select style={{ flex: 1, minWidth: 240 }} value={email} onChange={(e) => setEmail(e.target.value)}>
          <option value="">{t("members.add.options.chooseUser")}</option>
          {users
            ?.filter((u) => !memberIds.has(u.id))
            .map((u) => (
              <option key={u.id} value={u.email}>
                {u.name} ({u.email})
              </option>
            ))}
        </select>
        <select
          style={{ minWidth: 180 }}
          value={effectiveRoleId}
          onChange={(e) => setRoleId(e.target.value)}
          aria-label={t("members.add.roleLabel")}
        >
          {(roles ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <button
          className="primary"
          disabled={!email || !effectiveRoleId}
          onClick={() =>
            void act(async () => {
              await api.addMember(project.id, {
                email,
                isProjectAdmin: chosenRole?.name === "Yönetici", // i18n-ok: built-in role name (data)
                roleId: effectiveRoleId,
              });
              setEmail("");
              reloadRoles();
            })
          }
        >
          {t("common:actions.add")}
        </button>
      </div>
      <p className="muted small">{t("members.add.hint")}</p>
      {msg && <p className="error">{msg}</p>}
    </div>
  );
}

function Naming() {
  const { t } = useTranslation(["projectSettings", "common"]);
  const project = useProject();
  const { data: standards, reload } = useLoad(() => api.namingStandards(project.id), [project.id]);
  const [editing, setEditing] = useState<NamingStandardDto | "new" | null>(null);
  return (
    <div className="stack">
      <div className="row">
        <p className="muted" style={{ margin: 0 }}>
          {t("naming.description")}
        </p>
        <div className="spacer" />
        <button className="primary" onClick={() => setEditing("new")}>
          {t("naming.actions.add")}
        </button>
      </div>
      {standards?.map((s) => (
        <div key={s.id} className="card">
          <div className="row">
            <h3 style={{ margin: 0 }}>{s.definition.name}</h3>
            <span className="badge">{t("naming.badges.delimiter", { delimiter: s.definition.delimiter })}</span>
            <div className="spacer" />
            <button className="small" onClick={() => setEditing(s)}>
              {t("common:actions.edit")}
            </button>
          </div>
          <div className="mono" style={{ marginTop: 8 }}>
            {s.definition.fields.map((f) => f.name).join(` ${s.definition.delimiter} `)}
          </div>
          <div className="muted small" style={{ marginTop: 4 }}>
            {t("naming.example", { example: example(s.definition) })}
          </div>
        </div>
      ))}
      {standards?.length === 0 && <div className="card muted">{t("naming.empty")}</div>}
      {editing && (
        <NamingEditor
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function example(s: NamingStandard): string {
  return s.fields
    .filter((f) => f.inName !== false)
    .map((f) => (f.type === "list" ? (f.values[0]?.code ?? "?") : f.type === "number" ? "1".padStart(f.digits, "0") : i18n.t("projectSettings:naming.exampleText")))
    .join(s.delimiter);
}

/**
 * One field per line: "Ad | list | KOD=Açıklama, KOD2" · "Ad | number | 4" (or "2-3" digits) · "Ad | text".
 * A trailing "| meta" marks a field that is not part of the name (e.g. Revizyon).
 */
function toText(fields: NamingField[]): string {
  return fields
    .map((f) => {
      const line =
        f.type === "list"
          ? `${f.name} | list | ${f.values.map((v) => (v.description ? `${v.code}=${v.description}` : v.code)).join(", ")}`
          : f.type === "number"
            ? `${f.name} | number | ${
                f.minDigits !== undefined || f.maxDigits !== undefined
                  ? `${f.minDigits ?? f.digits}-${f.maxDigits ?? f.digits}`
                  : f.digits
              }`
            : `${f.name} | text`;
      return f.inName === false ? `${line}${f.type === "text" ? " |" : ""} | meta` : line;
    })
    .join("\n");
}

function fromText(text: string): NamingField[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line): NamingField => {
      const [name = "", type = "text", rest = "", flag = ""] = line.split("|").map((x) => x.trim());
      const meta = flag === "meta" ? { inName: false } : {};
      if (type === "list")
        return {
          ...meta,
          name,
          type: "list",
          values: rest
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean)
            .map((v) => {
              const [code = "", description] = v.split("=").map((x) => x.trim());
              return description ? { code, description } : { code };
            }),
        };
      if (type === "number") {
        const range = /^(\d+)\s*-\s*(\d+)$/.exec(rest);
        if (range) {
          const [min, max] = [Number(range[1]), Number(range[2])];
          return { ...meta, name, type: "number", digits: max, minDigits: min, maxDigits: max };
        }
        return { ...meta, name, type: "number", digits: Number(rest) || 4 };
      }
      return { ...meta, name, type: "text" };
    });
}

function NamingEditor({ initial, onClose, onSaved }: { initial: NamingStandardDto | null; onClose(): void; onSaved(): void }) {
  const { t } = useTranslation(["projectSettings", "common"]);
  const project = useProject();
  const [name, setName] = useState(initial?.definition.name ?? "");
  const [delimiter, setDelimiter] = useState(initial?.definition.delimiter ?? "-");
  const [fields, setFields] = useState(
    initial
      ? toText(initial.definition.fields)
      : t("naming.editor.defaultFields"),
  );
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const def: NamingStandard = {
      ...(initial?.definition.allowSuffix ? { allowSuffix: true } : {}),
      ...(initial?.definition.allowDelimiterInCodes ? { allowDelimiterInCodes: true } : {}),
      name,
      delimiter,
      fields: fromText(fields),
    };
    try {
      if (initial) await api.updateNamingStandard(project.id, initial.id, def);
      else await api.createNamingStandard(project.id, def);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Dialog title={initial ? t("naming.editor.editTitle") : t("naming.editor.newTitle")} onClose={onClose} wide>
      <div className="row">
        <div style={{ flex: 1 }}>
          <label>{t("common:fields.name")}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div style={{ width: 120 }}>
          <label>{t("naming.editor.fields.delimiter")}</label>
          <input value={delimiter} maxLength={1} onChange={(e) => setDelimiter(e.target.value)} />
        </div>
      </div>
      <label>{t("naming.editor.fields.fields")}</label>
      <textarea className="mono" style={{ minHeight: 220 }} value={fields} onChange={(e) => setFields(e.target.value)} />
      <p className="muted small">{t("naming.editor.exampleName", { example: example({ name, delimiter, fields: fromText(fields) }) })}</p>
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button onClick={onClose}>{t("common:actions.cancel")}</button>
        <button className="primary" onClick={() => void save()}>
          {t("common:actions.save")}
        </button>
      </div>
    </Dialog>
  );
}


function Activity() {
  const { t } = useTranslation("projectSettings");
  const project = useProject();
  const { data, error } = useLoad(() => api.activity(project.id), [project.id]);
  return (
    <div className="card" style={{ padding: 0 }}>
      {error && <p className="error">{error}</p>}
      <table className="phone-cards">
        <thead>
          <tr>
            <th style={{ width: 140 }}>{t("activity.columns.time")}</th>
            <th style={{ width: 160 }}>{t("activity.columns.person")}</th>
            <th style={{ width: 220 }}>{t("activity.columns.action")}</th>
            <th>{t("activity.columns.details")}</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((e) => (
            <tr key={e.id}>
              <td className="muted small">{formatDate(e.at)}</td>
              <td>{e.userName ?? "—"}</td>
              <td>{t(`activity.events.${e.action}` as ProjectSettingsKey, { defaultValue: e.action })}</td>
              <td
                className="muted small mono"
                style={{ maxWidth: 480, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {summary(e.details)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function summary(d: Record<string, unknown> | null): string {
  if (!d) return "";
  const parts: string[] = [];
  for (const k of ["tool", "name", "title", "number", "version", "email", "count"]) if (d[k] !== undefined) parts.push(`${k}: ${String(d[k])}`);
  return parts.length ? parts.join(" · ") : JSON.stringify(d).slice(0, 200);
}

/** Downloads the project's structure as a template JSON (no files, records or people). */
function TemplateExport() {
  const { t } = useTranslation("projectSettings");
  const project = useProject();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function download() {
    setMsg(null);
    setBusy(true);
    try {
      const tpl = await api.exportTemplate(project.id);
      const blob = new Blob([JSON.stringify(tpl, null, 2)], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `${project.code}-sablon.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      if (tpl.notes?.length) setMsg(tpl.notes.join(" "));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>{t("templateExport.heading")}</h3>
      <p className="muted" style={{ margin: 0 }}>
        {t("templateExport.description")}
      </p>
      <div>
        <button className="primary" disabled={busy} onClick={() => void download()}>
          {busy ? t("templateExport.preparing") : t("templateExport.actions.export")}
        </button>
      </div>
      {msg && <p className="notice">{msg}</p>}
    </div>
  );
}
