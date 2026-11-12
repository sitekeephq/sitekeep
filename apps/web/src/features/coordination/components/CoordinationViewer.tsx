/** Viewer side panels for model coordination: model set views and the clash detail. */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  type ModelSetDto,
  type ViewRule,
} from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { type ViewerEngine } from "@7dimensions-project/bim-viewer";
import { Dialog } from "../../../shared/ui/Dialog";

/** Model set header with its saved views (left panel). */
export function ModelSetPanel({
  projectId,
  set,
  viewId,
  onView,
  onSave,
  onClose,
}: {
  projectId: string;
  set: ModelSetDto;
  viewId: string | null;
  onView(id: string | null): void;
  onSave(): void;
  onClose(): void;
}) {
  const { t } = useTranslation(["coordination", "common"]);
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>▦ {set.name}</h3>
        <div className="spacer" />
        <button className="ghost small" onClick={onClose} title={t("setPanel.closeSet")}>✕</button>
      </div>
      <div className="muted small" style={{ margin: "2px 0 6px" }}>
        {t("setPanel.modelCount", { count: set.items.filter((i) => i.resolvedVersionId).length })} ·{" "}
        <Link to={`/projects/${projectId}/coordination/sets`}>{t("setPanel.coordination")}</Link>
      </div>
      {set.items
        .filter((i) => i.hidden || i.missing || (i.derivativeStatus && i.derivativeStatus !== "ready"))
        .map((i) => (
          <p key={i.fileId} className="notice small">
            {i.hidden ? t("setPanel.messages.hiddenModel") : i.missing ? t("setPanel.messages.missingFile") : t("setPanel.messages.derivative", { file: i.fileName, status: i.derivativeStatus })}
          </p>
        ))}
      <div className="small" style={{ fontWeight: 600, marginTop: 6 }}>{t("setPanel.views")}</div>
      {set.views.length === 0 && <div className="muted small">{t("setPanel.noViews")}</div>}
      {set.views.map((v) => (
        <div
          key={v.id}
          className="model-item small"
          style={{ cursor: "pointer", fontWeight: v.id === viewId ? 600 : undefined }}
          onClick={() => onView(v.id === viewId ? null : v.id)}
        >
          <span>{v.id === viewId ? "◉" : "○"}</span>
          <div>
            {v.name}
            <div className="muted">
              {t("setPanel.ruleCount", { count: v.state.rules.length })}
              {v.state.hiddenFileIds.length ? ` · ${t("setPanel.modelsOff", { count: v.state.hiddenFileIds.length })}` : ""}
              {v.createdByName ? ` · ${v.createdByName}` : ""}
            </div>
          </div>
        </div>
      ))}
      <button className="small" style={{ marginTop: 6 }} onClick={onSave}>
        {t("setPanel.actions.saveView")}
      </button>
    </div>
  );
}

/** Saves camera, switched-off models and class rules of the current viewer state to the set. */
export function SaveViewDialog({
  projectId,
  set,
  engine,
  loadedFileIds,
  initialRules,
  modelFiles,
  onClose,
  onSaved,
}: {
  projectId: string;
  set: ModelSetDto;
  engine: ViewerEngine;
  loadedFileIds: string[];
  initialRules: ViewRule[];
  modelFiles: Record<string, string>;
  onClose(): void;
  onSaved(viewId: string): void;
}) {
  const { t } = useTranslation(["coordination", "common"]);
  const [name, setName] = useState("");
  const [rules, setRules] = useState<ViewRule[]>(initialRules);
  const [error, setError] = useState<string | null>(null);
  const update = (i: number, r: Partial<ViewRule>) => setRules((list) => list.map((x, k) => (k === i ? { ...x, ...r } : x)));
  const hiddenFileIds = set.items.filter((i) => i.resolvedVersionId && !loadedFileIds.includes(i.fileId)).map((i) => i.fileId);

  async function save() {
    setError(null);
    try {
      const clean = rules.map((r) => ({ ...r, classes: r.classes.map((c) => c.trim()).filter(Boolean) }));
      // Section planes / box and measurements travel with the view (left out when there are none).
      const extras = await engine.extrasState();
      const v = await api.saveModelSetView(projectId, set.id, name.trim(), { camera: engine.cameraState(), hiddenFileIds, rules: clean, ...extras });
      onSaved(v.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Dialog title={t("saveView.title")} onClose={onClose} wide>
      <label>{t("common:fields.name")}</label>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("saveView.placeholder")} />
      <p className="muted small">
        {t("saveView.hint", { n: hiddenFileIds.length })}
      </p>
      <table className="props-table">
        <thead>
          <tr>
            <th>{t("saveView.columns.classes")}</th>
            <th style={{ width: 130 }}>{t("saveView.columns.action")}</th>
            <th style={{ width: 70 }}>{t("saveView.columns.colour")}</th>
            <th style={{ width: 30 }} />
          </tr>
        </thead>
        <tbody>
          {rules.map((r, i) => (
            <tr key={i}>
              <td>
                <input value={r.classes.join(", ")} onChange={(e) => update(i, { classes: e.target.value.split(",") })} placeholder="IfcDuctSegment, IfcPipeSegment" /* i18n-ok: IFC class names */ />
              </td>
              <td>
                <select value={r.action} onChange={(e) => update(i, { action: e.target.value as ViewRule["action"] })}>
                  <option value="color">{t("saveView.options.color")}</option>
                  <option value="hide">{t("saveView.options.hide")}</option>
                  <option value="isolate">{t("saveView.options.isolate")}</option>
                </select>
              </td>
              <td>
                {r.action === "color" && <input type="color" value={r.color ?? "#d92d20"} onChange={(e) => update(i, { color: e.target.value })} />}
              </td>
              <td>
                <button className="ghost small" onClick={() => setRules((l) => l.filter((_, k) => k !== i))}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 6 }}>
        <button className="small" onClick={() => setRules((l) => [...l, { classes: [], action: "color", color: "#d92d20" }])}>{t("saveView.actions.addRule")}</button>
        <button className="small ghost" onClick={() => void engine.applyRules(rules, modelFiles)}>{t("saveView.actions.preview")}</button>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button onClick={onClose}>{t("common:actions.cancel")}</button>
        <button className="primary" disabled={!name.trim()} onClick={() => void save()}>{t("common:actions.save")}</button>
      </div>
    </Dialog>
  );
}
