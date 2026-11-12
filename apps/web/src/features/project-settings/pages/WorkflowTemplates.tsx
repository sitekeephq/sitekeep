import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  OUTCOME_CODES,
  OUTCOME_CODE_KIND,
  OUTCOME_KINDS,
  OUTCOME_KIND_CODE,
  REVIEW_PARTIES,
  partyOutcomeOptions,
  type AttributeAssigneeRule,
  type CopyTargetRule,
  type FinalOutcomeMap,
  type OutcomeCode,
  type OutcomeKind,
  type OutcomeOption,
  type ReviewParty,
  type ReviewStage,
  type StageReviseRule,
  type StepRule,
  type WorkflowKind,
  type WorkflowAssignee,
  type WorkflowStep,
  type WorkflowTemplateDto,
} from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { documentsApi } from "../../documents/api";
import { useLoad, useProject } from "../../../app/context/project";
import { useAsk } from "../../../shared/ui/Ask";
import { Dialog } from "../../../shared/ui/Dialog";
import { AssigneePicker, assigneeLabel, namesFrom } from "../../../shared/ui/AssigneePicker";
import { FolderTree } from "../../documents/components/FolderTree";
import { label as labelOf, labelEntries, useLabel } from "../../../i18n";

/** Project settings tab: workflow (review) templates. */
export function WorkflowTemplates() {
  const { t: tr } = useTranslation(["projectSettings", "common"]);
  const label = useLabel();
  const { confirm } = useAsk();
  const project = useProject();
  const { data: templates, error, reload } = useLoad(() => api.workflowTemplates(project.id), [project.id]);
  const { data: members } = useLoad(() => api.members(project.id), [project.id]);
  const { data: companies } = useLoad(() => api.companies(), []);
  const { data: roles } = useLoad(() => api.roles(project.id), [project.id]);
  const [editing, setEditing] = useState<WorkflowTemplateDto | "new" | null>(null);
  const names = namesFrom(members, companies, roles);

  async function remove(t: WorkflowTemplateDto) {
    if (
      !(await confirm({
        title: tr("workflows.remove.title"),
        message: tr("workflows.remove.confirm", { name: t.name }),
        confirmLabel: tr("common:actions.delete"),
        danger: true,
      }))
    )
      return;
    await api.deleteWorkflowTemplate(project.id, t.id);
    reload();
  }

  const stepAssignees = (s: WorkflowStep) =>
    [
      ...s.assignees.map((a) => assigneeLabel(a, names)),
      ...(s.assigneeRule ? [tr("workflows.byAttribute", { attribute: s.assigneeRule.attribute })] : []),
    ].join(", ");

  return (
    <div className="stack">
      <div className="row">
        <p className="muted" style={{ margin: 0 }}>
          {tr("workflows.description")}
        </p>
        <div className="spacer" />
        <button className="primary" onClick={() => setEditing("new")}>
          {tr("workflows.actions.add")}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {templates?.map((t) => (
        <div key={t.id} className="card">
          <div className="row">
            <h3 style={{ margin: 0 }}>{t.name}</h3>
            <span className="badge">{label("workflowKind", t.kind)}</span>
            {t.chain?.namePattern && <span className="badge mono">{t.chain.namePattern}</span>}
            <div className="spacer" />
            <button className="small" onClick={() => setEditing(t)}>
              {tr("common:actions.edit")}
            </button>
            <button className="small danger" onClick={() => void remove(t)}>
              {tr("common:actions.delete")}
            </button>
          </div>
          {t.chain?.stages?.length ? (
            <div className="row wrap small" style={{ marginTop: 8, gap: 6 }}>
              {t.chain.originParty && (
                <span className="badge ok">{tr("workflows.originBadge", { party: label("reviewParty", t.chain.originParty) })}</span>
              )}
              {t.chain.stages.map((st, k) => (
                <span key={k} className="row" style={{ gap: 6 }}>
                  <span className="muted">→</span>
                  <span className="badge info" title={label("stageRevise", st.onRevise)}>
                    {st.name || label("reviewParty", st.party)}
                    {st.days ? tr("workflows.days", { count: st.days }) : ""}
                    {st.onRevise === "stop" ? tr("workflows.stopBadge") : ""}
                  </span>
                  <span className="muted">
                    {t.steps
                      .filter((s) => (s.stage ?? 0) === k)
                      .map((s) => tr("workflows.stepSummary", { name: s.name, assignees: stepAssignees(s) }))
                      .join(", ")}
                  </span>
                </span>
              ))}
            </div>
          ) : (
            <div className="row wrap small" style={{ marginTop: 8, gap: 6 }}>
              {t.steps.map((s, i) => (
                <span key={i} className="row" style={{ gap: 6 }}>
                  {i > 0 && <span className="muted">→</span>}
                  <span className="badge info" title={stepAssignees(s)}>
                    {tr("workflows.stepBadge", { n: i + 1, name: s.name })}
                  </span>
                  <span className="muted">
                    {tr("workflows.stepRule", { assignees: stepAssignees(s), rule: label("stepRule", s.rule) })}
                    {s.days ? tr("workflows.days", { count: s.days }) : ""}
                  </span>
                </span>
              ))}
            </div>
          )}
          {t.chain?.copyTarget?.pattern && (
            <div className="small muted" style={{ marginTop: 4 }}>
              <Trans
                t={tr}
                i18nKey="workflows.copySubfolder"
                values={{ pattern: t.chain.copyTarget.pattern }}
                components={{ code: <span className="mono" /> }}
              />
            </div>
          )}
        </div>
      ))}
      {templates?.length === 0 && <div className="card muted">{tr("workflows.empty")}</div>}
      {editing && (
        <TemplateEditor
          initial={editing === "new" ? null : editing}
          members={members}
          companies={companies}
          roles={roles}
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

const DEFAULT_OUTCOMES: OutcomeCode[] = ["approved", "approved_with_comments", "revise_resubmit", "rejected"];

function emptyStep(stage?: number): WorkflowStep {
  return { name: "", assignees: [], rule: "any", days: 5, outcomes: [...DEFAULT_OUTCOMES], ...(stage !== undefined ? { stage } : {}) };
}

type Pickers = Pick<Parameters<typeof AssigneePicker>[0], "members" | "companies" | "roles">;

function TemplateEditor({
  initial,
  members,
  companies,
  roles,
  onClose,
  onSaved,
}: {
  initial: WorkflowTemplateDto | null;
  members: Pickers["members"];
  companies: Pickers["companies"];
  roles: Pickers["roles"];
  onClose(): void;
  onSaved(): void;
}) {
  const { t } = useTranslation(["projectSettings", "common"]);
  const label = useLabel();
  const project = useProject();
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<WorkflowKind>(initial?.kind ?? "review");
  const [steps, setSteps] = useState<WorkflowStep[]>(initial?.steps ?? [emptyStep()]);
  const [finalOutcomes, setFinalOutcomes] = useState<FinalOutcomeMap>(initial?.finalOutcomes ?? {});
  const [stages, setStages] = useState<ReviewStage[]>(initial?.chain?.stages ?? []);
  const [originParty, setOriginParty] = useState<ReviewParty | "">(initial?.chain?.originParty ?? "");
  const [namePattern, setNamePattern] = useState(initial?.chain?.namePattern ?? "");
  const [copyTarget, setCopyTarget] = useState<CopyTargetRule>(initial?.chain?.copyTarget ?? { folderId: null, pattern: "" });
  const [pickFolder, setPickFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: targetFolder } = useLoad(
    () => (copyTarget.folderId ? documentsApi.folder(project.id, copyTarget.folderId) : Promise.resolve(null)),
    [project.id, copyTarget.folderId],
  );

  const setStep = (i: number, patch: Partial<WorkflowStep>) =>
    setSteps((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: number) =>
    setSteps((list) => {
      const n = [...list];
      const [s] = n.splice(i, 1);
      n.splice(i + d, 0, s!);
      return n;
    });
  const setStage = (k: number, patch: Partial<ReviewStage>) =>
    setStages((list) => list.map((s, j) => (j === k ? { ...s, ...patch } : s)));
  const lastOutcomes = steps[steps.length - 1]?.outcomes ?? [];

  async function save() {
    setError(null);
    const body = {
      kind,
      name,
      steps: steps.map((s) => (stages.length ? { ...s, stage: s.stage ?? 0 } : { ...s, stage: undefined })),
      finalOutcomes,
      chain: {
        stages: stages.length ? stages : undefined,
        originParty: originParty || null,
        namePattern: namePattern.trim() || null,
        copyTarget: copyTarget.folderId || copyTarget.pattern.trim() ? { ...copyTarget, pattern: copyTarget.pattern.trim() } : null,
        // Form flows (Formlar → Onay Akışı): fillers and info recipients are kept as they are.
        form: initial?.chain?.form,
      },
    };
    try {
      if (initial) await api.updateWorkflowTemplate(project.id, initial.id, body);
      else await api.createWorkflowTemplate(project.id, body);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Dialog title={initial ? t("workflows.editor.editTitle") : t("workflows.editor.newTitle")} onClose={onClose} wide>
      <label>{t("common:fields.name")}</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("workflows.editor.namePlaceholder")} />
      <label>{t("workflows.editor.fields.kind")}</label>
      <select value={kind} disabled={!!initial} onChange={(e) => setKind(e.target.value as WorkflowKind)}>
        <option value="review">{label("workflowKind", "review")}</option>
        <option value="form">{label("workflowKind", "form")}</option>
        <option value="progress_payment">{label("workflowKind", "progress_payment")}</option>
      </select>

      <h3 style={{ marginTop: 16 }}>{t("workflows.editor.stagesHeading")}</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("workflows.editor.stagesHint")}
      </p>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div style={{ width: 220 }}>
          <label>{t("workflows.editor.fields.originParty")}</label>
          <select value={originParty} onChange={(e) => setOriginParty(e.target.value as ReviewParty | "")}>
            <option value="">—</option>
            {REVIEW_PARTIES.map((p) => (
              <option key={p} value={p}>
                {label("reviewParty", p)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {stages.map((st, k) => (
        <div key={k} className="row" style={{ alignItems: "flex-end", marginTop: 6 }}>
          <strong style={{ width: 70 }}>{t("workflows.editor.stageN", { n: k + 1 })}</strong>
          <div style={{ width: 150 }}>
            <label>{t("workflows.editor.fields.party")}</label>
            <select value={st.party} onChange={(e) => setStage(k, { party: e.target.value as ReviewParty })}>
              {REVIEW_PARTIES.map((p) => (
                <option key={p} value={p}>
                  {label("reviewParty", p)}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label>{t("workflows.editor.fields.displayName")}</label>
            <input value={st.name} placeholder={label("reviewParty", st.party)} onChange={(e) => setStage(k, { name: e.target.value })} />
          </div>
          <div style={{ width: 100 }}>
            <label>{t("workflows.editor.fields.days")}</label>
            <input
              type="number"
              min={0}
              max={365}
              value={st.days}
              onChange={(e) => setStage(k, { days: Math.max(0, Math.min(365, Number(e.target.value) || 0)) })}
            />
          </div>
          <div style={{ width: 300 }}>
            <label>{t("workflows.editor.fields.onRevise")}</label>
            <select value={st.onRevise} onChange={(e) => setStage(k, { onRevise: e.target.value as StageReviseRule })}>
              {labelEntries("stageRevise").map(([r, text]) => (
                <option key={r} value={r}>
                  {text}
                </option>
              ))}
            </select>
          </div>
          <button
            className="small danger"
            onClick={() => {
              setStages((list) => list.filter((_, j) => j !== k));
              setSteps((list) =>
                list.map((s) => ({ ...s, stage: s.stage === undefined ? undefined : Math.max(0, s.stage > k ? s.stage - 1 : s.stage === k ? 0 : s.stage) })),
              );
            }}
          >
            {t("workflows.editor.actions.remove")}
          </button>
        </div>
      ))}
      <button
        className="small"
        style={{ marginTop: 6 }}
        onClick={() => setStages((list) => [...list, { name: "", party: (REVIEW_PARTIES[list.length + 1] ?? "other") as ReviewParty, days: 0, onRevise: "stop" }])}
      >
        {t("workflows.editor.actions.addStage")}
      </button>

      <h3 style={{ marginTop: 16 }}>{t("workflows.editor.stepsHeading")}</h3>
      {steps.map((s, i) => (
        <StepEditor
          key={i}
          index={i}
          step={s}
          count={steps.length}
          stages={stages}
          members={members}
          companies={companies}
          roles={roles}
          onChange={(patch) => setStep(i, patch)}
          onMove={(d) => move(i, d)}
          onRemove={() => setSteps((list) => list.filter((_, j) => j !== i))}
        />
      ))}
      <button style={{ marginTop: 12 }} onClick={() => setSteps((list) => [...list, emptyStep(stages.length ? stages.length - 1 : undefined)])}>
        {t("workflows.editor.actions.addStep")}
      </button>

      <h3 style={{ marginTop: 16 }}>{t("workflows.editor.numberHeading")}</h3>
      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <label>{t("workflows.editor.fields.namePattern")}</label>
          <input className="mono" value={namePattern} onChange={(e) => setNamePattern(e.target.value)} placeholder="{Proje}-{Tip}-{0000}" />{/* i18n-ok: pattern tokens */}
          <p className="muted small">
            {t("workflows.editor.namePatternHint")}
          </p>
        </div>
        <div style={{ flex: 1 }}>
          <label>{t("workflows.editor.fields.copyFolder")}</label>
          <div className="row">
            <span className="small" style={{ flex: 1 }}>
              {targetFolder ? targetFolder.path.map((p) => p.name).join(" / ") : <span className="muted">{t("workflows.editor.copyFolderNotSet")}</span>}
            </span>
            <button className="small" onClick={() => setPickFolder((x) => !x)}>
              {pickFolder ? t("common:actions.close") : t("workflows.editor.actions.choose")}
            </button>
            {copyTarget.folderId && (
              <button className="small" onClick={() => setCopyTarget((c) => ({ ...c, folderId: null }))}>
                {t("common:actions.clear")}
              </button>
            )}
          </div>
          {pickFolder && (
            <div className="card" style={{ maxHeight: 220, overflow: "auto", padding: "8px 0", marginTop: 6 }}>
              <FolderTree
                projectId={project.id}
                rootId={project.rootFolderId}
                activeId={copyTarget.folderId ?? project.rootFolderId}
                version={0}
                onSelect={(id) => setCopyTarget((c) => ({ ...c, folderId: id }))}
              />
            </div>
          )}
          <label>{t("workflows.editor.fields.subfolderPattern")}</label>
          <input
            className="mono"
            value={copyTarget.pattern}
            onChange={(e) => setCopyTarget((c) => ({ ...c, pattern: e.target.value }))}
            placeholder="{Bölge}/{Disiplin}/{Tip}" // i18n-ok: pattern tokens (field names)
          />
          <label className="row" style={{ color: "var(--text)", fontSize: 12 }}>
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={copyTarget.onUnresolved === "base"}
              onChange={(e) => setCopyTarget((c) => ({ ...c, onUnresolved: e.target.checked ? "base" : "fail" }))}
            />
            {t("workflows.editor.options.copyToBase")}
          </label>
        </div>
      </div>

      <h3 style={{ marginTop: 16 }}>{t("workflows.editor.finalHeading")}</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("workflows.editor.finalHint")}
      </p>
      <div className="row wrap">
        {lastOutcomes.map((o) => (
          <div key={o} className="row" style={{ gap: 4 }}>
            <span className="small">{t("workflows.editor.finalMap", { outcome: label("outcome", o) })}</span>
            <select
              style={{ width: 190 }}
              value={finalOutcomes[o] ?? o}
              onChange={(e) => {
                const v = e.target.value as OutcomeCode;
                setFinalOutcomes((m) => {
                  const n = { ...m };
                  if (v === o) delete n[o];
                  else n[o] = v;
                  return n;
                });
              }}
            >
              {OUTCOME_CODES.map((x) => (
                <option key={x} value={x}>
                  {label("outcome", x)}
                </option>
              ))}
            </select>
          </div>
        ))}
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

function StepEditor({
  index: i,
  step: s,
  count,
  stages,
  members,
  companies,
  roles,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  step: WorkflowStep;
  count: number;
  stages: ReviewStage[];
  members: Pickers["members"];
  companies: Pickers["companies"];
  roles: Pickers["roles"];
  onChange(patch: Partial<WorkflowStep>): void;
  onMove(d: number): void;
  onRemove(): void;
}) {
  const { t, i18n } = useTranslation(["projectSettings", "common"]);
  const label = useLabel();
  const custom = !!s.outcomeOptions;
  const stage = stages[s.stage ?? 0];
  const setOptions = (outcomeOptions: OutcomeOption[]) =>
    onChange({ outcomeOptions, outcomes: [...new Set(outcomeOptions.map((o) => OUTCOME_KIND_CODE[o.kind]))] });

  return (
    <div className="card" style={{ marginTop: 12, padding: 12 }}>
      <div className="row">
        <strong>{t("workflows.step.heading", { n: i + 1 })}</strong>
        <div className="spacer" />
        <button className="small" disabled={i === 0} onClick={() => onMove(-1)} aria-label={t("workflows.step.actions.up")}>
          ↑
        </button>
        <button className="small" disabled={i === count - 1} onClick={() => onMove(1)} aria-label={t("workflows.step.actions.down")}>
          ↓
        </button>
        <button className="small danger" disabled={count === 1} onClick={onRemove}>
          {t("workflows.editor.actions.remove")}
        </button>
      </div>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}>
          <label>{t("workflows.step.fields.name")}</label>
          <input value={s.name} onChange={(e) => onChange({ name: e.target.value })} placeholder={t("workflows.step.namePlaceholder")} />
        </div>
        {stages.length > 0 && (
          <div style={{ width: 170 }}>
            <label>{t("workflows.step.fields.stage")}</label>
            <select value={s.stage ?? 0} onChange={(e) => onChange({ stage: Number(e.target.value) })}>
              {stages.map((st, k) => (
                <option key={k} value={k}>
                  {t("workflows.step.stageOption", { n: k + 1, name: st.name || label("reviewParty", st.party) })}
                </option>
              ))}
            </select>
          </div>
        )}
        <div style={{ width: 190 }}>
          <label>{t("workflows.step.fields.rule")}</label>
          <select value={s.rule} onChange={(e) => onChange({ rule: e.target.value as StepRule })}>
            {labelEntries("stepRule").map(([r, text]) => (
              <option key={r} value={r}>
                {text}
              </option>
            ))}
          </select>
        </div>
        <div style={{ width: 110 }}>
          <label>{t("workflows.editor.fields.days")}</label>
          <input
            type="number"
            min={0}
            max={365}
            value={s.days}
            onChange={(e) => onChange({ days: Math.max(0, Math.min(365, Number(e.target.value) || 0)) })}
          />
        </div>
      </div>
      <label>{t("workflows.step.fields.assignees")}</label>
      <AssigneePicker value={s.assignees} onChange={(assignees) => onChange({ assignees })} members={members} companies={companies} roles={roles} />
      <p className="muted small" style={{ margin: "4px 0 0" }}>
        {t("workflows.step.assigneesHint")}
      </p>
      <label className="row" style={{ color: "var(--text)", fontSize: 13 }}>
        <input
          type="checkbox"
          style={{ width: "auto" }}
          checked={!!s.assigneeRule}
          onChange={(e) =>
            onChange({ assigneeRule: e.target.checked ? { type: "by_attribute", attribute: "Disiplin", map: {} } : undefined })
          }
        />
        {t("workflows.step.options.byAttribute")}
      </label>
      {s.assigneeRule && (
        <RuleEditor rule={s.assigneeRule} members={members} companies={companies} roles={roles} onChange={(assigneeRule) => onChange({ assigneeRule })} />
      )}

      <label className="row" style={{ color: "var(--text)", fontSize: 13 }}>
        <input
          type="checkbox"
          style={{ width: "auto" }}
          checked={custom}
          onChange={(e) =>
            e.target.checked
              ? setOptions(stage ? partyOutcomeOptions(stage.party, undefined, i18n.language) : s.outcomes.map((c) => ({ code: c, label: labelOf("outcome", c), kind: OUTCOME_CODE_KIND[c] })))
              : onChange({ outcomeOptions: undefined, outcomes: [...DEFAULT_OUTCOMES] })
          }
        />
        {t("workflows.step.options.customOutcomes")}
      </label>
      {custom ? (
        <div>
          {s.outcomeOptions!.map((o, k) => (
            <div key={k} className="row" style={{ marginTop: 4 }}>
              <input
                className="mono"
                style={{ width: 90 }}
                value={o.code}
                onChange={(e) => setOptions(s.outcomeOptions!.map((x, j) => (j === k ? { ...x, code: e.target.value } : x)))}
                placeholder={t("workflows.step.codePlaceholder")}
              />
              <input
                style={{ flex: 1 }}
                value={o.label}
                onChange={(e) => setOptions(s.outcomeOptions!.map((x, j) => (j === k ? { ...x, label: e.target.value } : x)))}
                placeholder={t("workflows.step.labelPlaceholder")}
              />
              <select
                style={{ width: 190 }}
                value={o.kind}
                onChange={(e) => setOptions(s.outcomeOptions!.map((x, j) => (j === k ? { ...x, kind: e.target.value as OutcomeKind } : x)))}
              >
                {OUTCOME_KINDS.map((kd) => (
                  <option key={kd} value={kd}>
                    {label("outcomeKind", kd)}
                  </option>
                ))}
              </select>
              <button
                className="small danger"
                aria-label={t("workflows.step.actions.removeOutcome")}
                onClick={() => setOptions(s.outcomeOptions!.filter((_, j) => j !== k))}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="row" style={{ marginTop: 4 }}>
            <button className="small" onClick={() => setOptions([...s.outcomeOptions!, { code: "", label: "", kind: "approved" }])}>
              {t("workflows.step.actions.addOutcome")}
            </button>
            {stage && (
              <button className="small" onClick={() => setOptions(partyOutcomeOptions(stage.party, ["approved", "approved_with_comments", "info", "revise", "rejected"], i18n.language))}>
                {t("workflows.step.actions.fillParty", { party: label("reviewParty", stage.party) })}
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <label>{t("workflows.step.fields.outcomes")}</label>
          <div className="row wrap">
            {OUTCOME_CODES.map((o) => (
              <label key={o} className="row" style={{ margin: 0, color: "var(--text)", fontSize: 13, gap: 4 }}>
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={s.outcomes.includes(o)}
                  onChange={(e) =>
                    onChange({
                      outcomes: e.target.checked ? OUTCOME_CODES.filter((x) => x === o || s.outcomes.includes(x)) : s.outcomes.filter((x) => x !== o),
                    })
                  }
                />
                {label("outcome", o)}
              </label>
            ))}
          </div>
        </>
      )}
      <label>{t("workflows.step.fields.requiredAttributes")}</label>
      <input
        value={(s.requiredAttributes ?? []).join(", ")}
        placeholder={t("workflows.step.requiredAttributesPlaceholder")}
        onChange={(e) => {
          const list = e.target.value
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
          onChange({ requiredAttributes: list.length ? list : undefined });
        }}
      />
    </div>
  );
}

function RuleEditor({
  rule,
  members,
  companies,
  roles,
  onChange,
}: {
  rule: AttributeAssigneeRule;
  members: Pickers["members"];
  companies: Pickers["companies"];
  roles: Pickers["roles"];
  onChange(rule: AttributeAssigneeRule): void;
}) {
  const { t } = useTranslation("projectSettings");
  const [newValue, setNewValue] = useState("");
  const setMap = (value: string, list: WorkflowAssignee[] | null) => {
    const map = { ...rule.map };
    if (list) map[value] = list;
    else delete map[value];
    onChange({ ...rule, map });
  };
  return (
    <div className="card" style={{ padding: 8, marginTop: 4 }}>
      <div className="row">
        <label style={{ margin: 0 }}>{t("workflows.rule.fields.attribute")}</label>
        <input style={{ width: 200 }} value={rule.attribute} onChange={(e) => onChange({ ...rule, attribute: e.target.value })} />
        <span className="muted small">{t("workflows.rule.attributeHint")}</span>
      </div>
      {Object.entries(rule.map).map(([value, list]) => (
        <div key={value} className="row" style={{ alignItems: "flex-start", marginTop: 6 }}>
          <span className="badge mono" style={{ minWidth: 60 }}>
            {value}
          </span>
          <div style={{ flex: 1 }}>
            <AssigneePicker value={list} onChange={(v) => setMap(value, v)} members={members} companies={companies} roles={roles} />
          </div>
          <button className="small danger" aria-label={t("workflows.rule.actions.removeValue")} onClick={() => setMap(value, null)}>
            ✕
          </button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 6 }}>
        <input style={{ width: 160 }} value={newValue} placeholder={t("workflows.rule.valuePlaceholder")} onChange={(e) => setNewValue(e.target.value)} />
        <button
          className="small"
          disabled={!newValue.trim() || newValue.trim() in rule.map}
          onClick={() => {
            setMap(newValue.trim(), []);
            setNewValue("");
          }}
        >
          {t("workflows.rule.actions.addValue")}
        </button>
      </div>
      <label>{t("workflows.rule.fields.fallback")}</label>
      <AssigneePicker
        value={rule.fallback ?? []}
        onChange={(v) => onChange({ ...rule, fallback: v.length ? v : undefined })}
        members={members}
        companies={companies}
        roles={roles}
      />
    </div>
  );
}
