/** Wizard steps 6–8: folder structure, naming / document code standard, code profile and suitability lists. */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CDE_STATES,
  FOLDER_NAME_FORBIDDEN,
  PROJECT_SETUP_CODE_SCHEMES,
  REVISION_FORM_EXAMPLES,
  allowedRevisionForms,
  allowedSuitability,
  codeProfile,
  digitRange,
  nameFields,
  resolveNamingTokens,
  setupFolderOptions,
  validateName,
  type NamingStandard,
  type ProjectTemplate,
} from "@sitekeep/shared";
import { NEW_COMPANY, namingKey } from "./draft";
import type { SetupDraft } from "./draft";
import type { StepProps } from "./ProjectSetupWizard";
import { PreviewNode } from "../components/PreviewNode";

export function FoldersStep({ draft, update, base, preview, refreshPreview }: StepProps) {
  const { t } = useTranslation(["projects", "common"]);
  const options = useMemo(() => (base ? setupFolderOptions(base) : { parents: [], removable: [] }), [base]);
  const [parent, setParent] = useState("");
  const [name, setName] = useState("");
  const [remove, setRemove] = useState("");
  if (!base) return null;
  const dimensions = Object.entries(base.dimensions ?? {}).filter(([, values]) => values.every((v) => typeof v === "string"));
  const nameOk = !!name.trim() && name === name.trim() && !FOLDER_NAME_FORBIDDEN.test(name);
  const removable = options.removable.filter((p) => !draft.folderRemoves.some((r) => p === r || p.startsWith(`${r}/`)));
  return (
    <div className="stack">
      {dimensions.length > 0 && (
        <div className="card">
          <h4>{t("wizard.preview.dimensions.heading")}</h4>
          <p className="muted small">{t("wizard.preview.dimensions.hint")}</p>
          <div className="choices">
            {dimensions.map(([dim, values]) => (
              <div key={dim}>
                <label htmlFor={`setup-dim-${dim}`}>{dim}</label>
                <textarea
                  id={`setup-dim-${dim}`}
                  rows={Math.min(8, Math.max(3, values.length))}
                  value={draft.dimensions[dim] ?? (values as string[]).join("\n")}
                  onChange={(e) => update((d) => ({ dimensions: { ...d.dimensions, [dim]: e.target.value } }))}
                />
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="setup-two-col">
        <fieldset className="card setup-fieldset">
          <legend>{t("setup.folders.addHeading")}</legend>
          <label htmlFor="setup-folder-parent">{t("setup.folders.parent")}</label>
          <select id="setup-folder-parent" value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">{t("setup.folders.chooseParent")}</option>
            {options.parents.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <label htmlFor="setup-folder-name">{t("setup.folders.name")}</label>
          <input id="setup-folder-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          <button
            type="button"
            disabled={!parent || !nameOk}
            onClick={() => {
              update((d) => ({ folderAdds: [...d.folderAdds, { parent, name }] }));
              setName("");
            }}
          >
            {t("setup.folders.add")}
          </button>
          {draft.folderAdds.length > 0 && (
            <ul className="setup-edit-list">
              {draft.folderAdds.map((a, i) => (
                <li key={`${a.parent}/${a.name}`}>
                  <span>
                    + {a.parent}/<strong>{a.name}</strong>
                  </span>
                  <button type="button" className="ghost small" onClick={() => update((d) => ({ folderAdds: d.folderAdds.filter((_, j) => j !== i) }))}>
                    {t("common:actions.remove")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        <fieldset className="card setup-fieldset">
          <legend>{t("setup.folders.removeHeading")}</legend>
          <label htmlFor="setup-folder-remove">{t("setup.folders.removeLabel")}</label>
          <select id="setup-folder-remove" value={remove} onChange={(e) => setRemove(e.target.value)}>
            <option value="">{t("setup.folders.chooseRemove")}</option>
            {removable.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!remove}
            onClick={() => {
              update((d) => ({ folderRemoves: [...d.folderRemoves.filter((r) => !r.startsWith(`${remove}/`)), remove] }));
              setRemove("");
            }}
          >
            {t("setup.folders.leaveOut")}
          </button>
          <p className="field-hint">{t("setup.folders.limits")}</p>
          {draft.folderRemoves.length > 0 && (
            <ul className="setup-edit-list">
              {draft.folderRemoves.map((r) => (
                <li key={r}>
                  <span>
                    − <s>{r}</s>
                  </span>
                  <button type="button" className="ghost small" onClick={() => update((d) => ({ folderRemoves: d.folderRemoves.filter((x) => x !== r) }))}>
                    {t("setup.folders.keep")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      </div>
      <div className="row">
        <h4 className="spacer-right">{t("setup.folders.preview")}</h4>
        <button type="button" className="small" onClick={refreshPreview}>
          {t("wizard.preview.actions.refresh")}
        </button>
      </div>
      {!preview && <p className="muted">{t("wizard.preview.loading")}</p>}
      {preview && (
        <>
          <p className="muted small">
            {t("setup.folders.counts", { now: preview.counts.folders, later: preview.counts.virtualFolders })}
          </p>
          <div className="card setup-tree" data-testid="setup-folder-tree">
            {preview.tree.map((n) => (
              <PreviewNode key={n.name} node={n} depth={0} slots={preview.slots} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Token context of the draft: project code and the party codes, as the server resolves them. */
function tokenContext(draft: SetupDraft, template: ProjectTemplate, companies: StepProps["companies"]) {
  const slotCodes: Record<string, string | undefined> = {};
  const slotNames: Record<string, string | undefined> = {};
  for (const slot of template.slots) {
    const companyId = draft.slotCompanies[slot.key];
    const company = companyId && companyId !== NEW_COMPANY ? companies.find((c) => c.id === companyId) : undefined;
    slotCodes[slot.key] = draft.slotCodes[slot.key]?.trim() || company?.code || slot.code;
    slotNames[slot.key] = company?.name ?? slot.label;
  }
  return { projectCode: draft.code.trim() || "PROJ", slotCodes, slotNames };
}

/** A name that should pass the standard: the first code of each list, 1 for numbers. */
export function sampleName(standard: NamingStandard): string {
  return nameFields(standard)
    .map((f) => (f.type === "list" ? (f.values[0]?.code ?? "") : f.type === "number" ? "1".padStart(digitRange(f).min, "0") : "X".repeat(Math.max(1, f.minLength ?? 1))))
    .join(standard.delimiter);
}

const hasToken = (text: string) => /\{(PROJE|slot:|firma:)/.test(text);

export function NamingStep({ draft, update, base, template, companies }: StepProps) {
  const { t, i18n } = useTranslation(["projects", "cde", "common"]);
  const standards = template?.namingStandards ?? [];
  const current = draft.containerStandard ?? template?.cde?.containerStandard ?? "";
  const [open, setOpen] = useState(current || standards[0]?.name || "");
  const resolved = useMemo(() => {
    if (!template) return [];
    const ctx = tokenContext(draft, template, companies);
    return standards.map((s) => resolveNamingTokens(s, ctx));
  }, [draft, template, companies, standards]);
  const shown = resolved.find((s) => s.name === open);
  const [sample, setSample] = useState<string | null>(null);
  if (!template || !base) return null;
  if (!standards.length) return <p className="muted">{t("setup.naming.none")}</p>;
  const sampleText = sample ?? (shown ? sampleName(shown) : "");
  const result = shown && sampleText.trim() ? validateName(shown, sampleText, i18n.language) : null;
  const original = base.namingStandards?.find((s) => s.name === open);
  return (
    <div className="stack">
      <fieldset className="setup-fieldset">
        <legend>{t("cde:documentCode.standard.label")}</legend>
        <p className="field-hint">{t("cde:documentCode.standard.help")}</p>
        <div className="choices">
          {standards.map((s) => (
            <label key={s.name} className={`choice${current === s.name ? " selected" : ""}`}>
              <input
                type="radio"
                name="setup-container-standard"
                checked={current === s.name}
                onChange={() => {
                  update({ containerStandard: s.name });
                  setOpen(s.name);
                  setSample(null);
                }}
              />
              <strong>{s.name}</strong>
              <span className="muted">{t("setup.naming.fields", { count: s.fields.length, delimiter: s.delimiter })}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {standards.length > 1 && (
        <div className="row wrap">
          <label htmlFor="setup-naming-open">{t("setup.naming.show")}</label>
          <select
            id="setup-naming-open"
            value={open}
            onChange={(e) => {
              setOpen(e.target.value);
              setSample(null);
            }}
          >
            {standards.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {shown && original && (
        <table className="data-table phone-cards setup-naming">
          <thead>
            <tr>
              <th>{t("setup.naming.field")}</th>
              <th>{t("setup.naming.type")}</th>
              <th>{t("setup.naming.values")}</th>
            </tr>
          </thead>
          <tbody>
            {original.fields.map((field) => {
              const live = shown.fields.find((f) => f.name === field.name)!;
              const key = namingKey(original.name, field.name);
              const tokens = field.type === "list" && field.values.some((v) => hasToken(v.code));
              return (
                <tr key={field.name}>
                  <td className="pc-title">{field.name}</td>
                  <td data-label={t("setup.naming.type")}>{t(`setup.naming.types.${field.type}`)}</td>
                  <td data-label={t("setup.naming.values")}>
                    {field.type === "list" && !tokens && (
                      <>
                        <textarea
                          aria-label={t("setup.naming.codesOf", { field: field.name })}
                          rows={Math.min(6, Math.max(2, field.values.length))}
                          value={draft.naming[key] ?? field.values.map((v) => (v.description ? `${v.code} ${v.description}` : v.code)).join("\n")}
                          onChange={(e) => update((d) => ({ naming: { ...d.naming, [key]: e.target.value } }))}
                        />
                        <div className="muted small">{t("setup.naming.codesHint", { count: live.type === "list" ? live.values.length : 0 })}</div>
                      </>
                    )}
                    {field.type === "list" && tokens && (
                      <span>
                        {live.type === "list" && live.values.map((v) => v.code).join(", ")}
                        <span className="muted small"> · {t("setup.naming.fromParties")}</span>
                      </span>
                    )}
                    {field.type === "number" && <span>{t("setup.naming.digits", { count: digitRange(field).min })}</span>}
                    {field.type === "text" && <span className="muted">{t("setup.naming.freeText")}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {shown && (
        <div className="card">
          <label htmlFor="setup-sample">{t("setup.naming.sample")}</label>
          <input id="setup-sample" className="mono" value={sampleText} onChange={(e) => setSample(e.target.value)} aria-describedby="setup-sample-result" />
          <div id="setup-sample-result" aria-live="polite" data-testid="setup-sample-result">
            {result?.ok && <p className="ok-text small">{t("setup.naming.sampleOk")}</p>}
            {result && !result.ok && (
              <ul className="error small">
                {result.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function CodesStep({ draft, update, template }: StepProps) {
  const { t } = useTranslation(["projects", "cde"]);
  if (!template) return null;
  const scheme = draft.codeScheme ?? (template.cde?.codeScheme === "legacy_r" ? "legacy_r" : "iso_uk_na");
  const profile = codeProfile({ codeScheme: scheme });
  return (
    <div className="stack">
      <fieldset className="setup-fieldset">
        <legend className="visually-hidden">{t("cde:settings.codes.scheme")}</legend>
        <div className="choices">
          {PROJECT_SETUP_CODE_SCHEMES.map((s) => (
            <label key={s} className={`choice${scheme === s ? " selected" : ""}`}>
              <input type="radio" name="setup-code-scheme" value={s} checked={scheme === s} onChange={() => update({ codeScheme: s })} />
              <strong>{t(`cde:schemes.${s}`)}</strong>
              <span className="muted">{t(`cde:codes.settings.schemeHelp.${s}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <table className="data-table phone-cards setup-codes">
        <caption className="setup-caption">{t("cde:codes.settings.allowedHeading")}</caption>
        <thead>
          <tr>
            <th>{t("cde:codes.settings.state")}</th>
            <th>{t("setup.codes.suitability")}</th>
            <th>{t("setup.codes.revision")}</th>
          </tr>
        </thead>
        <tbody>
          {CDE_STATES.map((state) => (
            <tr key={state}>
              <td className="pc-title">{t(`cde:states.${state}`)}</td>
              <td data-label={t("setup.codes.suitability")}>{allowedSuitability(profile, state).join(", ")}</td>
              <td data-label={t("setup.codes.revision")}>{allowedRevisionForms(profile, state).map((f) => REVISION_FORM_EXAMPLES[f]).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="field-hint">{t("setup.codes.customHint")}</p>
    </div>
  );
}
