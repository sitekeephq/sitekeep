/**
 * "New Project": quick create (a template, a name and a code) or the set-up wizard
 * (docs/features/PROJECT_SETUP_WIZARD.md). A wizard draft kept in the browser opens the wizard.
 */
import { useEffect, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { ProjectTemplate, TemplateSummaryDto } from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { useAuth } from "../../../app/context/auth";
import { Dialog } from "../../../shared/ui/Dialog";
import { Icon } from "../../../shared/ui/Icon";
import { loadDraft, suggestCode } from "../setup/draft";
import { ProjectSetupWizard } from "../setup/ProjectSetupWizard";
import { forLanguage } from "../setup/StartSteps";

type Mode = "choose" | "quick" | "wizard";
type Choice = { kind: "blank" } | { kind: "builtin"; id: string } | { kind: "file"; fileName: string; template: ProjectTemplate };

export function NewProjectWizard({ onClose, onCreated }: { onClose(): void; onCreated(): void }) {
  const { t } = useTranslation(["projects", "common"]);
  const { user } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>(() => (user && loadDraft(user.id)?.step ? "wizard" : "choose"));

  const open = (id: string) => {
    onCreated();
    navigate(`/projects/${id}/files`);
  };

  return (
    <Dialog title={t("wizard.title")} onClose={onClose} wide>
      {mode === "choose" && (
        <div className="stack">
          <p className="wizard-lead">{t("setup.entry.lead")}</p>
          <div className="tpl-alt-grid">
            <button type="button" className="tpl-alt" onClick={() => setMode("wizard")} data-testid="new-project-wizard">
              <span className="tpl-alt-icon">
                <Icon name="settings" size={18} />
              </span>
              <span className="tpl-alt-text">
                <strong>{t("setup.entry.wizard")}</strong>
                <span className="muted">{t("setup.entry.wizardHint")}</span>
              </span>
            </button>
            <button type="button" className="tpl-alt" onClick={() => setMode("quick")} data-testid="new-project-quick">
              <span className="tpl-alt-icon">
                <Icon name="plus" size={18} />
              </span>
              <span className="tpl-alt-text">
                <strong>{t("setup.entry.quick")}</strong>
                <span className="muted">{t("setup.entry.quickHint")}</span>
              </span>
            </button>
          </div>
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              {t("common:actions.cancel")}
            </button>
          </div>
        </div>
      )}
      {mode === "quick" && <QuickCreate onBack={() => setMode("choose")} onCreated={(id) => open(id)} />}
      {mode === "wizard" && <ProjectSetupWizard onCancel={() => setMode("choose")} onCreated={(p) => open(p.id)} />}
    </Dialog>
  );
}

/** Quick create: a template (or a blank project), a name and a code; everything else as the template says. */
function QuickCreate({ onBack, onCreated }: { onBack(): void; onCreated(id: string): void }) {
  const { t, i18n } = useTranslation(["projects", "common"]);
  const language = i18n.language.slice(0, 2) === "tr" ? "tr" : "en";
  const [templates, setTemplates] = useState<TemplateSummaryDto[] | null>(null);
  const [choice, setChoice] = useState<Choice>({ kind: "builtin", id: "iso19650-temel" });
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.templates(language).then((list) => setTemplates(forLanguage(list, language)), (e: Error) => setError(e.message));
  }, [language]);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    try {
      const template = JSON.parse(await file.text()) as ProjectTemplate;
      const p = await api.previewTemplate({ template, language });
      setChoice({ kind: "file", fileName: file.name, template });
      if (!p.ok) setError(t("wizard.errors.templateProblem", { errors: p.errors.join(" ") }));
    } catch (err) {
      setError(err instanceof SyntaxError ? t("wizard.errors.invalidJson") : (err as Error).message);
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const body = { code: code.trim(), name: name.trim() };
      const p =
        choice.kind === "blank"
          ? await api.createProject({ ...body, template: "empty" })
          : await api.createProjectFromTemplate({
              ...body,
              language,
              ...(choice.kind === "builtin" ? { templateId: choice.id } : { template: choice.template }),
            });
      onCreated(p.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="wizard-lead">{t("wizard.template.lead")}</p>
      <div className="wizard-form">
        <label htmlFor="np-template">{t("setup.quick.template")}</label>
        <select
          id="np-template"
          value={choice.kind === "builtin" ? choice.id : choice.kind}
          onChange={(e) => setChoice(e.target.value === "blank" ? { kind: "blank" } : { kind: "builtin", id: e.target.value })}
        >
          {templates?.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.name}
            </option>
          ))}
          {choice.kind === "file" && <option value="file">{choice.fileName}</option>}
          <option value="blank">{t("wizard.template.blank.title")}</option>
        </select>
        <span />
        <label className="btn small setup-file-button">
          <input type="file" accept=".json,application/json" className="visually-hidden" onChange={(e) => void onFile(e)} />
          {t("wizard.template.fromFile.title")}
        </label>
        <label htmlFor="np-name">{t("wizard.details.fields.name")}</label>
        <input
          id="np-name"
          value={name}
          maxLength={200}
          placeholder={t("wizard.details.namePlaceholder")}
          onChange={(e) => {
            setName(e.target.value);
            if (!codeTouched) setCode(suggestCode(e.target.value));
          }}
          autoFocus
        />
        <label htmlFor="np-code">{t("wizard.details.fields.code")}</label>
        <div>
          <input
            id="np-code"
            value={code}
            maxLength={40}
            onChange={(e) => {
              setCodeTouched(true);
              setCode(e.target.value.toUpperCase());
            }}
          />
          <p className="field-hint">{t("wizard.details.codeHint")}</p>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onBack}>
          {t("common:actions.back")}
        </button>
        <button type="button" className="primary" disabled={busy || !code.trim() || !name.trim()} onClick={() => void create()}>
          {busy ? t("wizard.creating") : t("wizard.actions.create")}
        </button>
      </div>
    </div>
  );
}
