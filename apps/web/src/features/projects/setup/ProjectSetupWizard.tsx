/**
 * Project set-up wizard (docs/features/PROJECT_SETUP_WIZARD.md): eleven steps on top of a project
 * template. Every choice becomes an override of the template (draft.ts), each step checks its own
 * choices (steps.ts), the summary runs the server's dry run and the project is created in one
 * request; afterwards the per-part report shows what was applied, partly applied, skipped or failed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  applySetupOverrides,
  localizeTemplate,
  type CompanyDto,
  type ProjectSetupPreviewDto,
  type ProjectTemplate,
  type TemplatePartAvailabilityDto,
  type UserDto,
} from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { useAuth } from "../../../app/context/auth";
import { Icon } from "../../../shared/ui/Icon";
import { clearDraft, emptyDraft, loadDraft, saveDraft, toRequest, toSetup, withTemplate, type SetupDraft } from "./draft";
import { SETUP_STEPS, stepProblems, type StepProblem } from "./steps";
import { BasicsStep, LanguageStep, TemplateStep } from "./StartSteps";
import { PartiesStep, PeopleStep } from "./PartySteps";
import { CodesStep, FoldersStep, NamingStep } from "./StructureSteps";
import { RulesStep, WorkflowsStep } from "./ProcessSteps";
import { SetupReport, SummaryStep, type CreatedProject } from "./SummaryStep";

export interface StepProps {
  draft: SetupDraft;
  update(patch: Partial<SetupDraft> | ((d: SetupDraft) => Partial<SetupDraft>)): void;
  /** The chosen template in the project language, without the wizard's choices. */
  base: ProjectTemplate | null;
  /** The template with the wizard's choices applied (what the project will get). */
  template: ProjectTemplate | null;
  companies: CompanyDto[];
  setCompanies(list: CompanyDto[]): void;
  users: UserDto[];
  /** Availability of the template's v2 parts on this server (null while loading). */
  parts: TemplatePartAvailabilityDto[] | null;
  preview: ProjectSetupPreviewDto | null;
  refreshPreview(): void;
}

export function ProjectSetupWizard({ onCancel, onCreated }: { onCancel(): void; onCreated(project: { id: string }): void }) {
  const { t, i18n } = useTranslation(["projects", "common"]);
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const uiLanguage = i18n.language.slice(0, 2) === "tr" ? "tr" : "en";
  const [restored] = useState<SetupDraft | null>(() => loadDraft(userId));
  const [draft, setDraft] = useState<SetupDraft>(() => restored ?? emptyDraft(uiLanguage));
  const [showRestored, setShowRestored] = useState(!!restored && restored.step > 0);
  const [base, setBase] = useState<ProjectTemplate | null>(null);
  const [parts, setParts] = useState<TemplatePartAvailabilityDto[] | null>(null);
  const [companies, setCompanies] = useState<CompanyDto[]>([]);
  const [users, setUsers] = useState<UserDto[]>([]);
  const [preview, setPreview] = useState<ProjectSetupPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedProject | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const update = useCallback<StepProps["update"]>((patch) => setDraft((d) => ({ ...d, ...(typeof patch === "function" ? patch(d) : patch) })), []);

  useEffect(() => {
    if (!created) saveDraft(userId, draft);
  }, [draft, userId, created]);

  useEffect(() => {
    api.companies().then(setCompanies, () => undefined);
    api.users().then(setUsers, () => undefined);
  }, []);

  // The chosen template in the project language.
  const choice = draft.template;
  const choiceKey = choice ? (choice.kind === "builtin" ? `b:${choice.id}` : `f:${choice.fileName}`) : "";
  useEffect(() => {
    setBase(null);
    setParts(null);
    if (!choice) return;
    let live = true;
    const load = async () => {
      const template = choice.kind === "builtin" ? await api.template(choice.id, draft.language) : localizeTemplate(choice.json as ProjectTemplate, draft.language);
      const ref = choice.kind === "builtin" ? { templateId: choice.id } : { template: choice.json as ProjectTemplate };
      const p = await api.previewTemplate({ ...ref, language: draft.language });
      if (!live) return;
      setBase(template);
      setParts(p.parts);
    };
    load().catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choiceKey, draft.language]);

  const template = useMemo(() => (base ? applySetupOverrides(base, toSetup(draft, base), uiLanguage).template : null), [base, draft, uiLanguage]);

  const step = SETUP_STEPS[draft.step] ?? "language";
  const problems: StepProblem[] = useMemo(() => stepProblems(step, draft, base, uiLanguage), [step, draft, base, uiLanguage]);

  const refreshPreview = useCallback(() => {
    if (!base || !draft.template) return;
    setPreview(null);
    const { name: _name, ...body } = toRequest(draft, base);
    api.setupPreview({ ...body, code: body.code || undefined }).then(setPreview, (e: Error) => setError(e.message));
  }, [base, draft]);

  // The dry run on entering the folder and summary steps.
  useEffect(() => {
    if (step === "folders" || step === "summary") refreshPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, base]);

  useEffect(() => {
    heading.current?.focus();
  }, [draft.step]);

  const go = (index: number) => {
    setError(null);
    update({ step: Math.max(0, Math.min(SETUP_STEPS.length - 1, index)) });
  };

  async function create() {
    if (!base) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.createProjectFromTemplate(toRequest(draft, base));
      clearDraft(userId);
      setCreated(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    clearDraft(userId);
    setDraft(emptyDraft(uiLanguage));
    setShowRestored(false);
    setPreview(null);
  }

  if (created) return <SetupReport project={created} onOpen={() => onCreated(created)} />;

  const props: StepProps = { draft, update, base, template, companies, setCompanies, users, parts, preview, refreshPreview };
  const last = draft.step === SETUP_STEPS.length - 1;
  const blocked = problems.length > 0;

  return (
    <div className="setup-wizard">
      {showRestored && (
        <div className="notice setup-restored" role="status">
          <span>{t("setup.restored")}</span>
          <button type="button" className="small" onClick={startOver}>
            {t("setup.actions.startOver")}
          </button>
        </div>
      )}
      <nav aria-label={t("setup.stepsLabel")}>
        <ol className="wizard-steps compact">
          {SETUP_STEPS.map((s, i) => (
            <li key={s} className={i === draft.step ? "active" : i < draft.step ? "done" : undefined}>
              <button
                type="button"
                className="wizard-step-button"
                aria-current={i === draft.step ? "step" : undefined}
                disabled={i > draft.step}
                onClick={() => go(i)}
                title={t(`setup.steps.${s}`)}
              >
                <span className="wizard-step-dot">{i < draft.step ? <Icon name="tick" size={12} /> : i + 1}</span>
                <span className="wizard-step-label">{t(`setup.steps.${s}`)}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <section className="setup-step" aria-labelledby="setup-step-heading">
        <h3 id="setup-step-heading" ref={heading} tabIndex={-1} className="setup-step-heading">
          {t("setup.stepHeading", { current: draft.step + 1, total: SETUP_STEPS.length, name: t(`setup.steps.${step}`) })}
        </h3>
        <p className="wizard-lead">{t(`setup.leads.${step}`)}</p>
        {step === "language" && <LanguageStep {...props} />}
        {step === "template" && (
          <TemplateStep
            {...props}
            choose={(next) => {
              setPreview(null);
              setDraft((d) => withTemplate(d, next));
            }}
          />
        )}
        {step === "basics" && <BasicsStep {...props} />}
        {step === "parties" && <PartiesStep {...props} />}
        {step === "people" && <PeopleStep {...props} />}
        {step === "folders" && <FoldersStep {...props} />}
        {step === "naming" && <NamingStep {...props} />}
        {step === "codes" && <CodesStep {...props} />}
        {step === "workflows" && <WorkflowsStep {...props} />}
        {step === "rules" && <RulesStep {...props} />}
        {step === "summary" && <SummaryStep {...props} />}
      </section>

      {blocked && (
        <ul className="error setup-problems" aria-live="polite" data-testid="setup-problems">
          {problems.map((p, i) => (
            <li key={i}>{"text" in p ? p.text : t(`setup.problems.${p.key}`, p.params ?? {})}</li>
          ))}
        </ul>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <span className="wizard-progress">{t("wizard.progress", { current: draft.step + 1, total: SETUP_STEPS.length })}</span>
        <button type="button" onClick={draft.step === 0 ? onCancel : () => go(draft.step - 1)}>
          {t("common:actions.back")}
        </button>
        {last ? (
          <button type="button" className="primary" disabled={busy || blocked || !preview?.ok} onClick={() => void create()}>
            {busy ? t("wizard.creating") : t("wizard.actions.create")}
          </button>
        ) : (
          <button type="button" className="primary" disabled={blocked} onClick={() => go(draft.step + 1)}>
            {t("common:actions.next")}
          </button>
        )}
      </div>
    </div>
  );
}
