import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ATTRIBUTE_TYPES,
  type AttributeDefinitionDto,
  type AttributeType,
} from "@sitekeep/shared";
import { documentsApi } from "../../documents/api";
import { useLoad, useProject } from "../../../app/context/project";
import { useAsk } from "../../../shared/ui/Ask";
import { Dialog } from "../../../shared/ui/Dialog";
import { useLabel } from "../../../i18n";

/** Project settings → Öznitelikler: typed attribute definitions (Forma custom attributes). */
export function AttributeSettings() {
  const { t } = useTranslation(["projectSettings", "common"]);
  const label = useLabel();
  const { confirm } = useAsk();
  const project = useProject();
  const { data: defs, error, reload } = useLoad(() => documentsApi.attributeDefinitions(project.id), [project.id]);
  const [editing, setEditing] = useState<AttributeDefinitionDto | "new" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function remove(d: AttributeDefinitionDto) {
    if (
      !(await confirm({
        title: t("attributes.remove.title"),
        message: t("attributes.remove.confirm", { name: d.name }),
        confirmLabel: t("common:actions.delete"),
        danger: true,
      }))
    )
      return;
    setMsg(null);
    try {
      await documentsApi.deleteAttributeDefinition(project.id, d.id);
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <p className="muted" style={{ margin: 0 }}>
          {t("attributes.description")}
        </p>
        <div className="spacer" />
        <button className="primary" onClick={() => setEditing("new")}>
          {t("attributes.actions.add")}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {msg && <p className="error">{msg}</p>}
      <div className="card" style={{ padding: 0 }}>
        <table className="phone-cards">
          <thead>
            <tr>
              <th>{t("attributes.columns.name")}</th>
              <th style={{ width: 130 }}>{t("attributes.columns.type")}</th>
              <th>{t("attributes.columns.options")}</th>
              <th style={{ width: 90 }}>{t("attributes.columns.required")}</th>
              <th style={{ width: 150 }} />
            </tr>
          </thead>
          <tbody>
            {defs?.map((d) => (
              <tr key={d.id}>
                <td>
                  <strong>{d.name}</strong>
                </td>
                <td>{label("attributeType", d.type)}</td>
                <td className="small">
                  {d.type === "list" ? (
                    <span className="row wrap" style={{ gap: 4 }}>
                      {d.options.map((o) => (
                        <span key={o} className="badge">
                          {o}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>{d.required ? <span className="badge warn">{t("attributes.badges.required")}</span> : <span className="muted small">{t("attributes.notRequired")}</span>}</td>
                <td style={{ textAlign: "right" }}>
                  <button className="small" onClick={() => setEditing(d)}>
                    {t("common:actions.edit")}
                  </button>{" "}
                  <button className="small danger" onClick={() => void remove(d)}>
                    {t("common:actions.delete")}
                  </button>
                </td>
              </tr>
            ))}
            {defs?.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  {t("attributes.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {editing && (
        <AttributeEditor
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

function AttributeEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: AttributeDefinitionDto | null;
  onClose(): void;
  onSaved(): void;
}) {
  const { t } = useTranslation(["projectSettings", "common"]);
  const label = useLabel();
  const project = useProject();
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<AttributeType>(initial?.type ?? "list");
  const [options, setOptions] = useState((initial?.options ?? []).join("\n"));
  const [required, setRequired] = useState(initial?.required ?? false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const def = {
      name,
      type,
      required,
      options: type === "list" ? options.split("\n").map((o) => o.trim()).filter(Boolean) : [],
    };
    try {
      if (initial) await documentsApi.updateAttributeDefinition(project.id, initial.id, def);
      else await documentsApi.createAttributeDefinition(project.id, def);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Dialog title={initial ? t("attributes.editor.editTitle") : t("attributes.editor.newTitle")} onClose={onClose}>
      <div className="row">
        <div style={{ flex: 1 }}>
          <label>{t("common:fields.name")}</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("attributes.editor.namePlaceholder")} />
        </div>
        <div style={{ width: 180 }}>
          <label>{t("common:fields.type")}</label>
          <select value={type} onChange={(e) => setType(e.target.value as AttributeType)}>
            {ATTRIBUTE_TYPES.map((at) => (
              <option key={at} value={at}>
                {label("attributeType", at)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {type === "list" && (
        <>
          <label>{t("attributes.editor.fields.options")}</label>
          <textarea className="mono" value={options} onChange={(e) => setOptions(e.target.value)} placeholder={"S0\nS1\nS2"} />
        </>
      )}
      <label className="row" style={{ color: "var(--text)", fontSize: 13 }}>
        <input type="checkbox" style={{ width: "auto" }} checked={required} onChange={(e) => setRequired(e.target.checked)} />
        {t("attributes.editor.options.required")}
      </label>
      {initial && name.trim() !== initial.name && (
        <p className="notice small">{t("attributes.editor.renameNotice")}</p>
      )}
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
