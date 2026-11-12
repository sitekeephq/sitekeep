import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  TRANSMITTAL_PURPOSES,
  WORK_CATEGORIES,
  WORK_FIELD_TYPES,
  checkNumberingPattern,
  numberingTokens,
  BUILD_NUMBERING_PRESETS,
  type BuildNumberingPreset,
  type TransmittalPurpose,
  type WorkAutomationDto,
  type WorkCategory,
  type WorkFieldDef,
  type WorkFieldType,
  type WorkTypeDto,
} from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { buildApi, worksApi, type WorkTypeInput } from "../../../shared/api/api-works";
import { Dialog } from "../../../shared/ui/Dialog";
import { useLoad, useProject } from "../../../app/context/project";
import { useLabel } from "../../../i18n";

/** Project settings → "İş tipleri": types (fields, numbering) and review → transmittal automation. */
export function WorkTypesSettings() {
  const { t: tr, i18n } = useTranslation(["projectSettings", "common"]);
  const label = useLabel();
  const project = useProject();
  const { data: types, error, reload } = useLoad(() => worksApi.types(project.id, true), [project.id]);
  const [editing, setEditing] = useState<WorkTypeDto | "new" | null>(null);
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

  return (
    <div className="stack">
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{tr("workTypes.heading")}</h2>
          <div className="spacer" />
          <button className="primary" onClick={() => setEditing("new")}>
            {tr("workTypes.actions.add")}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {msg && <p className="error">{msg}</p>}
        <table className="phone-cards">
          <thead>
            <tr>
              <th>{tr("workTypes.columns.name")}</th>
              <th style={{ width: 120 }}>{tr("workTypes.columns.category")}</th>
              <th>{tr("workTypes.columns.pattern")}</th>
              <th style={{ width: 70 }}>{tr("workTypes.columns.fields")}</th>
              <th style={{ width: 180 }} />
            </tr>
          </thead>
          <tbody>
            {types?.map((t) => (
              <tr key={t.id} style={t.archived ? { opacity: 0.55 } : undefined}>
                <td>
                  {t.name} {t.builtIn && <span className="badge">{tr("workTypes.badges.builtIn")}</span>}
                  {t.archived && <span className="badge">{tr("workTypes.badges.archived")}</span>}
                  <div className="muted small mono">{t.key}</div>
                </td>
                <td className="muted">{label("workCategory", t.category)}</td>
                <td className="mono">{t.numberingPattern}</td>
                <td className="muted">{t.fields.length}</td>
                <td>
                  <div className="row">
                    <button className="small" onClick={() => setEditing(t)}>
                      {tr("common:actions.edit")}
                    </button>
                    {t.archived ? (
                      <button className="small" onClick={() => void act(() => worksApi.restoreType(project.id, t.id))}>
                        {tr("workTypes.actions.restore")}
                      </button>
                    ) : (
                      <button className="small danger" onClick={() => void act(() => worksApi.archiveType(project.id, t.id))}>
                        {tr("workTypes.actions.archive")}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          {tr("workTypes.tokensHint", {
            tokens: numberingTokens(i18n.language)
              .map(([tok, d]) => `${tok} ${d}`)
              .join(" · "),
          })}
        </p>
      </div>
      <NumberingPresets onDone={reload} />
      <AutomationSettings />
      {editing && (
        <TypeEditor
          type={editing === "new" ? null : editing}
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

function TypeEditor({ type, onClose, onSaved }: { type: WorkTypeDto | null; onClose(): void; onSaved(): void }) {
  const { t: tr, i18n } = useTranslation(["projectSettings", "common"]);
  const label = useLabel();
  const project = useProject();
  const { data: templates } = useLoad(() => api.workflowTemplates(project.id), [project.id]);
  const [key, setKey] = useState(type?.key ?? "");
  const [name, setName] = useState(type?.name ?? "");
  const [category, setCategory] = useState<WorkCategory>(type?.category ?? "generic");
  const [pattern, setPattern] = useState(type?.numberingPattern ?? "{Proje}-{Tip}-{YYYY}-{0000}");
  const [counterGroup, setCounterGroup] = useState(type?.counterGroup ?? "");
  const [icon, setIcon] = useState(type?.icon ?? "");
  const [color, setColor] = useState(type?.color ?? "#1f4e79");
  const [workflowId, setWorkflowId] = useState(type?.defaultWorkflowTemplateId ?? "");
  const [incoming, setIncoming] = useState(!!type?.settings.incoming);
  const [fields, setFields] = useState<WorkFieldDef[]>(type?.fields ?? []);
  const [msg, setMsg] = useState<string | null>(null);
  const [dueDays, setDueDays] = useState(type?.settings.dueDays ? String(type.settings.dueDays) : "");
  const problems = checkNumberingPattern(pattern, fields, i18n.language);

  function setField(i: number, patch: Partial<WorkFieldDef>) {
    setFields(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  }

  async function save() {
    setMsg(null);
    const body: WorkTypeInput = {
      key,
      name,
      category,
      numberingPattern: pattern,
      counterGroup: counterGroup.trim() || null,
      fields: fields.map((f) => ({ ...f, options: f.type === "list" ? (f.options ?? []).filter((o) => o.trim()) : undefined })),
      settings: { ...(type?.settings ?? {}), incoming, dueDays: dueDays ? Number(dueDays) : null },
      defaultWorkflowTemplateId: workflowId || null,
      icon: icon || null,
      color: color || null,
    };
    try {
      if (type) {
        const { key: _k, category: _c, ...rest } = body;
        await worksApi.updateType(project.id, type.id, rest);
      } else await worksApi.createType(project.id, body);
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <Dialog title={type ? tr("workTypes.editor.editTitle", { name: type.name }) : tr("workTypes.editor.newTitle")} onClose={onClose} wide>
      <div className="row">
        <div style={{ flex: 2 }}>
          <label>{tr("common:fields.name")}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label>{tr("workTypes.editor.fields.key")}</label>
          <input disabled={!!type} value={key} onChange={(e) => setKey(e.target.value)} placeholder="rfi" />{/* i18n-ok: example key */}
        </div>
        <div style={{ flex: 1 }}>
          <label>{tr("workTypes.editor.fields.category")}</label>
          <select disabled={!!type} value={category} onChange={(e) => setCategory(e.target.value as WorkCategory)}>
            {WORK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {label("workCategory", c)}
              </option>
            ))}
          </select>
        </div>
        <div style={{ width: 70 }}>
          <label>{tr("workTypes.editor.fields.icon")}</label>
          <input value={icon} onChange={(e) => setIcon(e.target.value)} />
        </div>
        <div style={{ width: 70 }}>
          <label>{tr("common:fields.color")}</label>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ padding: 2, height: 32 }} />
        </div>
      </div>
      <div className="row">
        <div style={{ flex: 2 }}>
          <label>{tr("workTypes.editor.fields.pattern")}</label>
          <input className="mono" value={pattern} onChange={(e) => setPattern(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label>{tr("workTypes.editor.fields.counterGroup")}</label>
          <input value={counterGroup} onChange={(e) => setCounterGroup(e.target.value)} placeholder={tr("workTypes.editor.counterGroupPlaceholder")} />
        </div>
        <div style={{ flex: 1 }}>
          <label>{tr("workTypes.editor.fields.workflow")}</label>
          <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
            <option value="">—</option>
            {templates?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {problems.length > 0 && <p className="error small">{problems.join(" ")}</p>}
      {(category === "rfi" || category === "submittal" || !!workflowId) && (
        <div className="row">
          <label style={{ margin: 0 }}>{tr("workTypes.editor.fields.dueDays")}</label>
          <input type="number" min={0} max={365} style={{ width: 90 }} value={dueDays} onChange={(e) => setDueDays(e.target.value)} />
          <span className="muted small">{tr("workTypes.editor.dueDaysHint")}</span>
        </div>
      )}
      {category === "correspondence" && (
        <label className="check">
          <input type="checkbox" checked={incoming} onChange={(e) => setIncoming(e.target.checked)} /> {tr("workTypes.editor.options.incoming")}
        </label>
      )}

      <h3 style={{ marginTop: 16 }}>{tr("workTypes.editor.fieldsHeading")}</h3>
      <table className="phone-cards">
        <thead>
          <tr>
            <th style={{ width: 130 }}>{tr("workTypes.editor.columns.key")}</th>
            <th>{tr("workTypes.editor.columns.label")}</th>
            <th style={{ width: 130 }}>{tr("workTypes.editor.columns.type")}</th>
            <th>{tr("workTypes.editor.columns.options")}</th>
            <th style={{ width: 70 }}>{tr("workTypes.editor.columns.required")}</th>
            <th style={{ width: 40 }} />
          </tr>
        </thead>
        <tbody>
          {fields.map((f, i) => (
            <tr key={i}>
              <td>
                <input className="mono" value={f.key} onChange={(e) => setField(i, { key: e.target.value })} />
              </td>
              <td>
                <input value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
              </td>
              <td>
                <select value={f.type} onChange={(e) => setField(i, { type: e.target.value as WorkFieldType })}>
                  {WORK_FIELD_TYPES.map((ft) => (
                    <option key={ft} value={ft}>
                      {label("workFieldType", ft)}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                {f.type === "list" && (
                  <input
                    value={(f.options ?? []).join(", ")}
                    onChange={(e) => setField(i, { options: e.target.value.split(",").map((o) => o.trim()) })}
                  />
                )}
              </td>
              <td>
                <input type="checkbox" style={{ width: "auto" }} checked={!!f.required} onChange={(e) => setField(i, { required: e.target.checked })} />
              </td>
              <td>
                <button
                  className="ghost small"
                  aria-label={tr("workTypes.editor.removeField")}
                  onClick={() => setFields(fields.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        className="small"
        style={{ marginTop: 8 }}
        onClick={() => setFields([...fields, { key: `alan${fields.length + 1}`, label: "", type: "text" }])}
      >
        {tr("workTypes.editor.actions.addField")}
      </button>
      {msg && <p className="error">{msg}</p>}
      <div className="dialog-actions">
        <button onClick={onClose}>{tr("common:actions.cancel")}</button>
        <button className="primary" disabled={!name.trim() || !key.trim() || problems.length > 0} onClick={() => void save()}>
          {tr("common:actions.save")}
        </button>
      </div>
    </Dialog>
  );
}

function AutomationSettings() {
  const { t } = useTranslation("projectSettings");
  const label = useLabel();
  const project = useProject();
  const { data: rows, reload } = useLoad(() => worksApi.automation(project.id), [project.id]);
  const { data: companies } = useLoad(() => api.companies(), []);
  const [msg, setMsg] = useState<string | null>(null);

  async function save(r: WorkAutomationDto, patch: Partial<WorkAutomationDto>) {
    setMsg(null);
    const next = { ...r, ...patch };
    try {
      await worksApi.setAutomation(project.id, r.templateId, {
        autoTransmittal: next.autoTransmittal,
        recipientCompanyIds: next.recipientCompanyIds,
        purpose: next.purpose,
        send: next.send,
        include: next.include,
      });
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="card">
      <h2>{t("automation.heading")}</h2>
      <p className="muted small">
        {t("automation.description")}
      </p>
      {msg && <p className="error">{msg}</p>}
      <table className="phone-cards">
        <thead>
          <tr>
            <th>{t("automation.columns.template")}</th>
            <th style={{ width: 80 }}>{t("automation.columns.on")}</th>
            <th>{t("automation.columns.recipients")}</th>
            <th style={{ width: 150 }}>{t("automation.columns.purpose")}</th>
            <th style={{ width: 150 }}>{t("automation.columns.files")}</th>
            <th style={{ width: 120 }}>{t("automation.columns.sendNow")}</th>
          </tr>
        </thead>
        <tbody>
          {rows?.map((r) => (
            <tr key={r.templateId}>
              <td>{r.templateName}</td>
              <td>
                <input type="checkbox" style={{ width: "auto" }} checked={r.autoTransmittal} onChange={(e) => void save(r, { autoTransmittal: e.target.checked })} />
              </td>
              <td>
                <div className="row wrap">
                  {companies?.map((c) => {
                    const on = r.recipientCompanyIds.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        className={on ? "primary small" : "small"}
                        onClick={() =>
                          void save(r, {
                            recipientCompanyIds: on ? r.recipientCompanyIds.filter((x) => x !== c.id) : [...r.recipientCompanyIds, c.id],
                          })
                        }
                      >
                        {c.name}
                      </button>
                    );
                  })}
                </div>
              </td>
              <td>
                <select value={r.purpose} onChange={(e) => void save(r, { purpose: e.target.value as TransmittalPurpose })}>
                  {TRANSMITTAL_PURPOSES.map((p) => (
                    <option key={p} value={p}>
                      {label("transmittalPurpose", p)}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select value={r.include} onChange={(e) => void save(r, { include: e.target.value as "approved" | "all" })}>
                  <option value="approved">{t("automation.options.approved")}</option>
                  <option value="all">{t("automation.options.all")}</option>
                </select>
              </td>
              <td>
                <input type="checkbox" style={{ width: "auto" }} checked={r.send} onChange={(e) => void save(r, { send: e.target.checked })} />
              </td>
            </tr>
          ))}
          {rows?.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                {t("automation.empty")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** RFI / submittal numbering presets (standard or the ZAVM pattern from the Forma setup). */
function NumberingPresets({ onDone }: { onDone(): void }) {
  const { t } = useTranslation("projectSettings");
  const presetLabel = (k: BuildNumberingPreset) =>
    k === "standart" ? t("numbering.presets.standart") : BUILD_NUMBERING_PRESETS[k].label;
  const project = useProject();
  const [msg, setMsg] = useState<string | null>(null);
  async function apply(preset: BuildNumberingPreset) {
    setMsg(null);
    try {
      await buildApi.numberingPreset(project.id, preset);
      setMsg(t("numbering.applied", { preset: presetLabel(preset) }));
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{t("numbering.heading")}</h2>
      <div className="row wrap">
        {(Object.keys(BUILD_NUMBERING_PRESETS) as BuildNumberingPreset[]).map((k) => (
          <button key={k} onClick={() => void apply(k)}>
            {presetLabel(k)}
          </button>
        ))}
      </div>
      <p className="muted small">
        <Trans
          t={t}
          i18nKey="numbering.hint"
          values={{ standard: BUILD_NUMBERING_PRESETS.standart.patterns.rfi, zavm: BUILD_NUMBERING_PRESETS.zavm.patterns.rfi }}
          components={{ code: <span className="mono" /> }}
        />
      </p>
      {msg && <p className="small">{msg}</p>}
    </div>
  );
}
