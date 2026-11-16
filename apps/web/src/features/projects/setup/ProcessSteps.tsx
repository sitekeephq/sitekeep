/** Wizard steps 9–10: workflows (approvers per step, the D-7 transitions) and the ISO 19650 rules. */
import { useTranslation } from "react-i18next";
import {
  CDE_WIP_POLICIES,
  DEFAULT_CDE_TRANSITIONS,
  cdeTransitionKey,
  type StepRule,
  type TemplateAssignee,
  type TemplateCdeTransition,
  type TemplateWorkflow,
} from "@sitekeep/shared";
import { useLabel } from "../../../i18n";
import { stepKey, type SetupStepChoice } from "./draft";
import type { StepProps } from "./ProjectSetupWizard";

const assigneeValue = (a: TemplateAssignee) => ("slot" in a ? `slot:${a.slot}` : "projectRole" in a ? `projectRole:${a.projectRole}` : `role:${a.role}`);
function assigneeOf(value: string): TemplateAssignee {
  const [kind, key] = [value.slice(0, value.indexOf(":")), value.slice(value.indexOf(":") + 1)];
  return kind === "slot" ? { slot: key } : kind === "projectRole" ? { projectRole: key } : { role: key as "project_admin" };
}

export function WorkflowsStep({ draft, update, template, base }: StepProps) {
  const { t } = useTranslation(["projects", "cde", "common"]);
  const label = useLabel();
  if (!template || !base) return null;
  const options: { value: string; text: string }[] = [
    ...template.slots.map((s) => ({ value: `slot:${s.key}`, text: t("setup.workflows.team", { name: s.label }) })),
    ...(template.roles ?? []).map((r) => ({ value: `projectRole:${r.key}`, text: t("setup.workflows.role", { name: r.name }) })),
    { value: "role:project_admin", text: label("workflowRole", "project_admin") },
  ];
  const textOf = (a: TemplateAssignee) => options.find((o) => o.value === assigneeValue(a))?.text ?? assigneeValue(a);
  const setStep = (w: TemplateWorkflow, index: number, patch: SetupStepChoice) =>
    update((d) => {
      const key = stepKey(w.name, index);
      return { steps: { ...d.steps, [key]: { ...d.steps[key], ...patch } } };
    });
  const transitions: TemplateCdeTransition[] =
    template.cde?.transitions ?? DEFAULT_CDE_TRANSITIONS.map((r) => ({ from: r.fromState, to: r.toState, mode: r.mode }) as TemplateCdeTransition);
  const reviewFlows = (template.workflows ?? []).filter((w) => (w.kind ?? "review") === "review");
  const stateName = (s: string | null) => (s ? t(`cde:states.${s}` as "cde:states.wip") : t("cde:settings.transitions.upload"));

  return (
    <div className="stack">
      <table className="data-table phone-cards setup-transitions">
        <caption className="setup-caption">{t("setup.workflows.transitions")}</caption>
        <thead>
          <tr>
            <th>{t("cde:settings.transitions.from")}</th>
            <th>{t("cde:settings.transitions.to")}</th>
            <th>{t("cde:settings.transitions.mode")}</th>
            <th>{t("cde:settings.transitions.workflow")}</th>
          </tr>
        </thead>
        <tbody>
          {transitions.map((tr) => {
            const key = cdeTransitionKey(tr.from, tr.to);
            return (
              <tr key={key} data-transition={key}>
                <td className="pc-title">
                  {stateName(tr.from)}
                  <span className="setup-phone-only"> → {stateName(tr.to)}</span>
                </td>
                <td className="setup-desktop-only">{stateName(tr.to)}</td>
                <td data-label={t("cde:settings.transitions.mode")}>{t(`cde:modes.${tr.mode}`)}</td>
                <td data-label={t("cde:settings.transitions.workflow")}>
                  {tr.mode === "review" && template.cde?.transitions ? (
                    <select
                      aria-label={t("setup.workflows.transitionWorkflow", { transition: `${stateName(tr.from)} → ${stateName(tr.to)}` })}
                      value={tr.workflow ?? ""}
                      onChange={(e) => update((d) => ({ transitions: { ...d.transitions, [key]: e.target.value || null } }))}
                    >
                      <option value="">{t("cde:settings.transitions.anyReview")}</option>
                      {reviewFlows.map((w) => (
                        <option key={w.name} value={w.name}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  ) : tr.mode === "review" ? (
                    t("cde:settings.transitions.anyReview")
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!template.cde?.transitions && <p className="field-hint">{t("cde:transitionEditor.defaultsNote")}</p>}

      {(template.workflows ?? []).map((w) => (
        <details key={w.name} className="card setup-workflow" open={(w.kind ?? "review") === "review"}>
          <summary>
            <strong>{w.name}</strong> <span className="badge">{label("workflowKind", w.kind ?? "review")}</span>
          </summary>
          <ol className="setup-workflow-steps">
            {w.steps.map((s, index) => {
              const chosen = s.assignees;
              const free = options.filter((o) => !chosen.some((a) => assigneeValue(a) === o.value));
              const idBase = `setup-wf-${(template.workflows ?? []).indexOf(w)}-${index}`;
              return (
                <li key={index} className="setup-workflow-step" data-step={s.name}>
                  <div className="row wrap">
                    <strong>{s.name}</strong>
                    <label htmlFor={`${idBase}-days`} className="setup-inline-label">
                      {t("setup.workflows.days")}
                    </label>
                    <input
                      id={`${idBase}-days`}
                      type="number"
                      min={0}
                      max={365}
                      className="setup-days"
                      value={s.days}
                      onChange={(e) => setStep(w, index, { days: Math.max(0, Math.min(365, Number(e.target.value) || 0)) })}
                    />
                    {chosen.length > 1 && (
                      <>
                        <label htmlFor={`${idBase}-rule`} className="setup-inline-label">
                          {t("setup.workflows.rule")}
                        </label>
                        <select id={`${idBase}-rule`} value={s.rule} onChange={(e) => setStep(w, index, { rule: e.target.value as StepRule })}>
                          {(["any", "all"] as const).map((r) => (
                            <option key={r} value={r}>
                              {label("stepRule", r)}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>
                  <ul className="setup-chips" aria-label={t("setup.workflows.approvers")}>
                    {chosen.map((a) => (
                      <li key={assigneeValue(a)} className="setup-chip">
                        {textOf(a)}
                        <button
                          type="button"
                          className="ghost small"
                          aria-label={t("setup.workflows.removeApprover", { name: textOf(a) })}
                          disabled={chosen.length === 1 && !s.assigneeRule}
                          onClick={() => setStep(w, index, { assignees: chosen.filter((x) => assigneeValue(x) !== assigneeValue(a)) })}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                    {s.assigneeRule && <li className="muted small">{t("setup.workflows.byAttribute", { attribute: s.assigneeRule.attribute })}</li>}
                  </ul>
                  {free.length > 0 && (
                    <select
                      aria-label={t("setup.workflows.addApproverTo", { step: s.name })}
                      value=""
                      onChange={(e) => e.target.value && setStep(w, index, { assignees: [...chosen, assigneeOf(e.target.value)] })}
                    >
                      <option value="">{t("setup.workflows.addApprover")}</option>
                      {free.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.text}
                        </option>
                      ))}
                    </select>
                  )}
                </li>
              );
            })}
          </ol>
        </details>
      ))}
    </div>
  );
}

export function RulesStep({ draft, update, template }: StepProps) {
  const { t } = useTranslation(["projects", "cde"]);
  if (!template) return null;
  const enforce = draft.enforceTransitions ?? template.cde?.enforceTransitions ?? false;
  const policy = draft.wipPolicy ?? template.cde?.wipPolicy ?? "grants";
  const adminSees = draft.adminSeesWip ?? template.cde?.adminSeesWip ?? true;
  return (
    <div className="stack">
      <div className="card">
        <label className="check">
          <input type="checkbox" checked={enforce} onChange={(e) => update({ enforceTransitions: e.target.checked })} />
          {t("cde:transitionEditor.enforce")}
        </label>
        <p className="field-hint">{t("cde:transitionEditor.enforceHelp")}</p>
        {!enforce && <p className="field-hint warn-text">{t("setup.rules.enforceOff")}</p>}
      </div>
      <fieldset className="card setup-fieldset">
        <legend>{t("cde:settings.teams.wipPolicy")}</legend>
        <div className="choices">
          {CDE_WIP_POLICIES.map((p) => (
            <label key={p} className={`choice${policy === p ? " selected" : ""}`}>
              <input type="radio" name="setup-wip-policy" value={p} checked={policy === p} onChange={() => update({ wipPolicy: p })} />
              <strong>{t(`cde:wipPolicies.${p}`)}</strong>
              <span className="muted">{t(`cde:teams.policyHelp.${p}`)}</span>
            </label>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={adminSees} disabled={policy !== "team_only"} onChange={(e) => update({ adminSeesWip: e.target.checked })} />
          {t("cde:settings.teams.adminSeesWip")}
        </label>
        <p className="field-hint">{t("setup.rules.adminSeesWipHint")}</p>
      </fieldset>
    </div>
  );
}
