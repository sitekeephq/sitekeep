/** Wizard steps 1–3: project language, template (what it brings, which parts need a module), basics. */
import { useEffect, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { TEMPLATE_PARTS, type TemplateSummaryDto } from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { useLabel } from "../../../i18n";
import { languageMeta } from "../../../i18n/languages";
import { Icon } from "../../../shared/ui/Icon";
import { suggestCode, type SetupTemplateChoice } from "./draft";
import { PROJECT_LANGUAGES } from "./steps";
import type { StepProps } from "./ProjectSetupWizard";

export function LanguageStep({ draft, update }: StepProps) {
  const { t } = useTranslation("projects");
  return (
    <fieldset className="setup-fieldset">
      <legend className="visually-hidden">{t("setup.language.legend")}</legend>
      <div className="choices">
        {PROJECT_LANGUAGES.map((code) => (
          <label key={code} className={`choice${draft.language === code ? " selected" : ""}`}>
            <input type="radio" name="setup-language" value={code} checked={draft.language === code} onChange={() => update({ language: code })} />
            <strong>{languageMeta(code).name}</strong>
            <span className="muted">{t(`setup.language.hint.${code}`)}</span>
          </label>
        ))}
      </div>
      <p className="field-hint">{t("setup.language.uiNote")}</p>
    </fieldset>
  );
}

/** Templates offered in the project language: one per family, the family member in that language. */
export function forLanguage(list: TemplateSummaryDto[], language: string): TemplateSummaryDto[] {
  return list.filter((tpl) => {
    if (!tpl.family || !tpl.language) return true;
    const siblings = list.filter((other) => other.family === tpl.family);
    return tpl.language === language || !siblings.some((other) => other.language === language);
  });
}

export function TemplateStep({ draft, base, parts, choose, update }: StepProps & { choose(next: SetupTemplateChoice | null): void }) {
  const { t } = useTranslation(["projects", "common"]);
  const label = useLabel();
  const [list, setList] = useState<TemplateSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.templates(draft.language).then(setList, (e: Error) => setError(e.message));
  }, [draft.language]);

  const offered = list ? forLanguage(list, draft.language) : [];
  const chosen = draft.template;

  // A family template chosen in another language follows the project language.
  useEffect(() => {
    if (!list || chosen?.kind !== "builtin" || offered.some((tpl) => tpl.id === chosen.id)) return;
    const current = list.find((tpl) => tpl.id === chosen.id);
    const sibling = current?.family ? offered.find((tpl) => tpl.family === current.family) : undefined;
    if (sibling) choose({ kind: "builtin", id: sibling.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, chosen]);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    try {
      const json = JSON.parse(await file.text()) as unknown;
      const p = await api.previewTemplate({ template: json as never, language: draft.language });
      if (!p.ok) setError(t("wizard.errors.templateProblem", { errors: p.errors.join(" ") }));
      else choose({ kind: "file", fileName: file.name, json });
    } catch (err) {
      setError(err instanceof SyntaxError ? t("wizard.errors.invalidJson") : (err as Error).message);
    }
  }

  return (
    <div className="stack">
      {!list && !error && <p className="muted">{t("common:status.loading")}</p>}
      <div className="tpl-grid" role="radiogroup" aria-label={t("setup.template.listLabel")}>
        {offered.map((tpl) => {
          const active = chosen?.kind === "builtin" && chosen.id === tpl.id;
          return (
            <button
              key={tpl.id}
              type="button"
              role="radio"
              aria-checked={active}
              className={`tpl-card${active ? " selected" : ""}`}
              data-template={tpl.id}
              onClick={() => choose({ kind: "builtin", id: tpl.id })}
            >
              <span className="tpl-card-head">
                <strong>{tpl.name}</strong>
                <span className="tpl-radio" aria-hidden="true" />
              </span>
              <span className="tpl-card-desc">{tpl.description}</span>
              <span className="tpl-card-meta">
                <span>
                  <Icon name="folder" size={13} /> {t("wizard.template.folders", { count: tpl.counts.folders })}
                </span>
                <span>
                  <Icon name="flag" size={13} /> {t("wizard.template.workflows", { count: tpl.counts.workflows })}
                </span>
                {tpl.parts.length > 0 && <span>{t("setup.template.partCount", { count: tpl.parts.length })}</span>}
              </span>
            </button>
          );
        })}
      </div>
      <label className={`tpl-alt${chosen?.kind === "file" ? " selected" : ""}`}>
        <input type="file" accept=".json,application/json" className="visually-hidden" onChange={(e) => void onFile(e)} />
        <span className="tpl-alt-icon">
          <Icon name="upload" size={18} />
        </span>
        <span className="tpl-alt-text">
          <strong>{t("wizard.template.fromFile.title")}</strong>
          <span className="muted">{chosen?.kind === "file" ? chosen.fileName : t("wizard.template.fromFile.description")}</span>
        </span>
        <span className="btn small">{chosen?.kind === "file" ? t("wizard.template.fromFile.actions.change") : t("wizard.template.fromFile.actions.choose")}</span>
      </label>
      {error && <p className="error">{error}</p>}

      {chosen && base && (
        <div className="card setup-brings" data-testid="setup-template-parts">
          <h4>{t("setup.template.brings", { name: base.name })}</h4>
          <ul className="setup-brings-list">
            <li>{t("setup.template.slots", { count: base.slots.length, names: base.slots.map((s) => s.label).join(", ") })}</li>
            <li>{t("setup.template.naming", { count: base.namingStandards?.length ?? 0 })}</li>
            <li>{t("setup.template.workflowList", { count: base.workflows?.length ?? 0 })}</li>
            {base.cde?.enforceTransitions && <li>{t("setup.template.isoRules")}</li>}
          </ul>
          {parts && parts.length > 0 && (
            <table className="data-table phone-cards setup-parts">
              <thead>
                <tr>
                  <th>{t("setup.parts.part")}</th>
                  <th>{t("setup.parts.appliedBy")}</th>
                  <th>{t("setup.parts.include")}</th>
                </tr>
              </thead>
              <tbody>
                {parts.map((p) => {
                  const info = TEMPLATE_PARTS.find((x) => x.part === p.part)!;
                  const switchKey = info.projectModule;
                  const on = switchKey ? (draft.modules[switchKey] ?? base.modules?.[switchKey] ?? true) : true;
                  return (
                    <tr key={p.part} data-part={p.part}>
                      <td className="pc-title">{t(`setup.parts.names.${p.part}`)}</td>
                      <td data-label={t("setup.parts.appliedBy")}>
                        {!p.module ? (
                          <span className="badge ok">{t("setup.parts.core")}</span>
                        ) : p.available ? (
                          <span className="badge ok">{t("setup.parts.byModule", { module: moduleName(p.module) })}</span>
                        ) : (
                          <span className="badge warn" data-testid="part-requires-module">
                            {t("setup.parts.requiresModule", { module: moduleName(p.module) })}
                          </span>
                        )}
                        {p.module && !p.available && <div className="muted small">{t("setup.parts.willSkip")}</div>}
                      </td>
                      <td data-label={t("setup.parts.include")}>
                        {switchKey ? (
                          <label className="check">
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={(e) => update((d) => ({ modules: { ...d.modules, [switchKey]: e.target.checked } }))}
                            />
                            {label("projectModule", switchKey)}
                          </label>
                        ) : (
                          <span className="muted">{t("setup.parts.always")}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

/** "manage" → "Manage": the Enterprise module's product name. */
export function moduleName(module: string): string {
  return module.charAt(0).toUpperCase() + module.slice(1);
}

export function BasicsStep({ draft, update, base }: StepProps) {
  const { t } = useTranslation(["projects", "common"]);
  const [codeTouched, setCodeTouched] = useState(!!draft.code);
  const delimiter = base?.namingStandards?.[0]?.delimiter;
  return (
    <div className="wizard-form">
      <label htmlFor="setup-name">{t("wizard.details.fields.name")}</label>
      <div>
        <input
          id="setup-name"
          value={draft.name}
          maxLength={200}
          placeholder={t("wizard.details.namePlaceholder")}
          onChange={(e) => update({ name: e.target.value, ...(codeTouched ? {} : { code: suggestCode(e.target.value) }) })}
        />
      </div>
      <label htmlFor="setup-code">{t("wizard.details.fields.code")}</label>
      <div>
        <input
          id="setup-code"
          value={draft.code}
          maxLength={40}
          aria-describedby="setup-code-hint"
          onChange={(e) => {
            setCodeTouched(true);
            update({ code: e.target.value.toUpperCase() });
          }}
        />
        <p className="field-hint" id="setup-code-hint">
          {delimiter ? t("setup.basics.codeHint", { delimiter }) : t("setup.basics.codeHintPlain")}
        </p>
      </div>
      <label htmlFor="setup-desc">
        {t("common:fields.description")} <span className="muted">({t("common:status.optional")})</span>
      </label>
      <textarea id="setup-desc" rows={2} value={draft.description} onChange={(e) => update({ description: e.target.value })} />
      <label htmlFor="setup-start">{t("setup.basics.startDate")}</label>
      <input id="setup-start" type="date" value={draft.startDate} onChange={(e) => update({ startDate: e.target.value })} />
      <label htmlFor="setup-end">{t("setup.basics.endDate")}</label>
      <input id="setup-end" type="date" value={draft.endDate} min={draft.startDate || undefined} onChange={(e) => update({ endDate: e.target.value })} />
      <label htmlFor="setup-location">{t("setup.basics.location")}</label>
      <input id="setup-location" value={draft.location} maxLength={200} placeholder={t("setup.basics.locationPlaceholder")} onChange={(e) => update({ location: e.target.value })} />
      <label htmlFor="setup-client">{t("setup.basics.client")}</label>
      <input id="setup-client" value={draft.client} maxLength={200} onChange={(e) => update({ client: e.target.value })} />
    </div>
  );
}
