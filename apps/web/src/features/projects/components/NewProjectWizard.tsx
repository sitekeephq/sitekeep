import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  type CompanyDto,
  type PreviewFolderDto,
  type ProjectTemplate,
  type TemplateDimensionDto,
  type TemplatePreviewDto,
  type TemplateSlot,
  asciiUpper,
  companyCodeInput,
} from "@sitekeep/shared";
import { api, dataLocale, intlLocale } from "../../../shared/api/api";
import { useLabel } from "../../../i18n";
import { Dialog } from "../../../shared/ui/Dialog";
import { Icon } from "../../../shared/ui/Icon";

type Choice = { kind: "blank" } | { kind: "builtin"; id: string } | { kind: "file"; fileName: string; template: ProjectTemplate };

const STEPS = ["template", "details", "companies", "preview"] as const;
const NEW_COMPANY = "__new__";

/** "Yeni proje": template → code/name → role slots to companies → preview → create. */
export function NewProjectWizard({ onClose, onCreated }: { onClose(): void; onCreated(): void }) {
  const { t } = useTranslation(["projects", "common"]);
  const label = useLabel();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [templates, setTemplates] = useState<Awaited<ReturnType<typeof api.templates>> | null>(null);
  const [companies, setCompanies] = useState<CompanyDto[]>([]);
  const [choice, setChoice] = useState<Choice>({ kind: "builtin", id: "iso19650-temel" });
  const [fileInfo, setFileInfo] = useState<{ slots: TemplateSlot[]; dimensions: TemplateDimensionDto[] } | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [slotCompanies, setSlotCompanies] = useState<Record<string, string>>({});
  const [slotCodes, setSlotCodes] = useState<Record<string, string>>({});
  const [newCompany, setNewCompany] = useState<Record<string, string>>({});
  const [newCompanyCode, setNewCompanyCode] = useState<Record<string, string>>({});
  const [dimText, setDimText] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<TemplatePreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.templates().then(setTemplates, (e: Error) => setError(e.message));
    api.companies().then(setCompanies, () => undefined);
  }, []);

  const selected = choice.kind === "builtin" ? templates?.find((t) => t.id === choice.id) : undefined;
  const slots = choice.kind === "builtin" ? (selected?.slots ?? []) : choice.kind === "file" ? (fileInfo?.slots ?? []) : [];
  const dimensions = choice.kind === "builtin" ? (selected?.dimensions ?? []) : (fileInfo?.dimensions ?? []);
  const steps = choice.kind === "blank" ? STEPS.slice(0, 2) : STEPS;

  const templateRef = useMemo(
    () => (choice.kind === "builtin" ? { templateId: choice.id } : choice.kind === "file" ? { template: choice.template } : {}),
    [choice],
  );

  function overrides(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const d of dimensions) {
      const text = dimText[d.name];
      if (!d.editable || text === undefined) continue;
      const values = text.split("\n").map((v) => v.trim()).filter(Boolean);
      if (values.join("\n") !== d.values.join("\n")) out[d.name] = values;
    }
    return out;
  }

  function request() {
    const mapped = Object.fromEntries(Object.entries(slotCompanies).filter(([, v]) => v && v !== NEW_COMPANY));
    const codes = Object.fromEntries(Object.entries(slotCodes).filter(([, v]) => v.trim()));
    return { ...templateRef, slotCompanies: mapped, slotCodes: codes, dimensions: overrides() };
  }

  async function runPreview() {
    setError(null);
    try {
      setPreview(await api.previewTemplate({ ...request(), code: code || undefined }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    if (step === 3) void runPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    try {
      const template = JSON.parse(await file.text()) as ProjectTemplate;
      const p = await api.previewTemplate({ template });
      setChoice({ kind: "file", fileName: file.name, template });
      setFileInfo({ slots: p.slots, dimensions: p.dimensions });
      if (!p.ok) setError(t("wizard.errors.templateProblem", { errors: p.errors.join(" ") }));
    } catch (err) {
      setError(err instanceof SyntaxError ? t("wizard.errors.invalidJson") : (err as Error).message);
    }
  }

  async function addCompany(slot: string) {
    const n = newCompany[slot]?.trim();
    if (!n) return;
    setError(null);
    try {
      const c = await api.createCompany(n, newCompanyCode[slot] || null);
      setCompanies((list) => [...list, c].sort((a, b) => a.name.localeCompare(b.name, dataLocale())));
      pickCompany(slot, c.id, [c]);
      setNewCompany((m) => ({ ...m, [slot]: "" }));
      setNewCompanyCode((m) => ({ ...m, [slot]: "" }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** Maps a slot to a company; the slot code follows the company's short code (template default if none). */
  function pickCompany(slot: string, companyId: string, extra: CompanyDto[] = []) {
    setSlotCompanies((m) => ({ ...m, [slot]: companyId }));
    const company = [...companies, ...extra].find((c) => c.id === companyId);
    setSlotCodes((m) => ({ ...m, [slot]: company?.code ?? "" }));
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const p =
        choice.kind === "blank"
          ? await api.createProject({ code, name, description: description || undefined, template: "empty" })
          : await api.createProjectFromTemplate({ ...request(), code, name, description: description || undefined });
      onCreated();
      navigate(`/projects/${p.id}/files`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const canNext =
    step === 0 ? choice.kind !== "builtin" || !!selected : step === 1 ? !!code.trim() && !!name.trim() : true;
  const last = step === steps.length - 1;

  return (
    <Dialog title={t("wizard.title")} onClose={onClose} wide>
      <ol className="wizard-steps">
        {steps.map((s, i) => (
          <li key={s} className={i === step ? "active" : i < step ? "done" : undefined}>
            <span className="wizard-step-dot">{i < step ? <Icon name="tick" size={12} /> : i + 1}</span>
            <span className="wizard-step-label">{t(`wizard.steps.${s}`)}</span>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="stack">
          <p className="wizard-lead">
            {t("wizard.template.lead")}
          </p>
          <div className="tpl-grid">
            {templates?.map((tpl) => {
              const active = choice.kind === "builtin" && choice.id === tpl.id;
              return (
                <button
                  key={tpl.id}
                  type="button"
                  className={`tpl-card${active ? " selected" : ""}`}
                  aria-pressed={active}
                  onClick={() => setChoice({ kind: "builtin", id: tpl.id })}
                >
                  <span className="tpl-card-head">
                    <strong>{tpl.name}</strong>
                    <span className="tpl-radio" aria-hidden="true" />
                  </span>
                  <span className="tpl-card-desc" title={tpl.description}>
                    {tpl.description}
                  </span>
                  <span className="tpl-card-meta">
                    <span><Icon name="folder" size={13} /> {t("wizard.template.folders", { count: tpl.counts.folders })}</span>
                    {tpl.counts.virtualFolders > 0 && <span>{t("wizard.template.onDemand", { count: tpl.counts.virtualFolders })}</span>}
                    <span><Icon name="flag" size={13} /> {t("wizard.template.workflows", { count: tpl.counts.workflows })}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="tpl-alt-grid">
            <label className={`tpl-alt${choice.kind === "file" ? " selected" : ""}`}>
              <input type="file" accept=".json,application/json" className="visually-hidden" onChange={(e) => void onFile(e)} />
              <span className="tpl-alt-icon"><Icon name="upload" size={18} /></span>
              <span className="tpl-alt-text">
                <strong>{t("wizard.template.fromFile.title")}</strong>
                <span className="muted">
                  {choice.kind === "file" ? choice.fileName : t("wizard.template.fromFile.description")}
                </span>
              </span>
              <span className="btn small">{choice.kind === "file" ? t("wizard.template.fromFile.actions.change") : t("wizard.template.fromFile.actions.choose")}</span>
            </label>
            <button
              type="button"
              className={`tpl-alt${choice.kind === "blank" ? " selected" : ""}`}
              aria-pressed={choice.kind === "blank"}
              onClick={() => setChoice({ kind: "blank" })}
            >
              <span className="tpl-alt-icon"><Icon name="plus" size={18} /></span>
              <span className="tpl-alt-text">
                <strong>{t("wizard.template.blank.title")}</strong>
                <span className="muted">{t("wizard.template.blank.description")}</span>
              </span>
              <span className="tpl-radio" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="wizard-form">
          <div>
            <label htmlFor="np-code">{t("wizard.details.fields.code")}</label>
            <input id="np-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ZAVM" maxLength={40} autoFocus />
            <p className="field-hint">{t("wizard.details.codeHint")}</p>
          </div>
          <div>
            <label htmlFor="np-name">{t("wizard.details.fields.name")}</label>
            <input id="np-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder={t("wizard.details.namePlaceholder")} />
          </div>
          <div className="wizard-form-full">
            <label htmlFor="np-desc">{t("common:fields.description")} <span className="muted">({t("common:status.optional")})</span></label>
            <textarea id="np-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <p className="wizard-lead">
            {t("wizard.companies.lead")}
          </p>
          {!slots.length && <p className="muted">{t("wizard.companies.empty")}</p>}
          <table className="data-table wizard-table phone-cards">
            <thead>
              <tr>
                <th style={{ width: 200 }}>{t("wizard.companies.columns.role")}</th>
                <th>{t("wizard.companies.columns.company")}</th>
                <th style={{ width: 110 }}>{t("wizard.companies.columns.code")}</th>
              </tr>
            </thead>
            <tbody>
              {slots.map((s) => (
                <tr key={s.key}>
                  <td className="pc-title">
                    <strong>{s.label}</strong>
                    {s.party && <div className="muted small">{label("party", s.party)}</div>}
                  </td>
                  <td data-label={t("wizard.companies.columns.company")}>
                    <select
                      value={slotCompanies[s.key] ?? ""}
                      onChange={(e) => pickCompany(s.key, e.target.value)}
                    >
                      <option value="">{t("wizard.companies.options.leaveEmpty")}</option>
                      {companies.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                      <option value={NEW_COMPANY}>{t("wizard.companies.options.newCompany")}</option>
                    </select>
                    {slotCompanies[s.key] === NEW_COMPANY && (
                      <div className="row wrap" style={{ marginTop: 6 }}>
                        <input
                          placeholder={t("wizard.companies.companyNamePlaceholder")}
                          value={newCompany[s.key] ?? ""}
                          onChange={(e) => setNewCompany((m) => ({ ...m, [s.key]: e.target.value }))}
                          onKeyDown={(e) => e.key === "Enter" && void addCompany(s.key)}
                          autoFocus
                        />
                        <input
                          placeholder={t("wizard.companies.columns.code")}
                          title={t("wizard.companies.companyCodeHint")}
                          style={{ width: 80 }}
                          maxLength={8}
                          value={newCompanyCode[s.key] ?? ""}
                          onChange={(e) => setNewCompanyCode((m) => ({ ...m, [s.key]: companyCodeInput(e.target.value) }))}
                          onKeyDown={(e) => e.key === "Enter" && void addCompany(s.key)}
                        />
                        <button type="button" onClick={() => void addCompany(s.key)}>
                          {t("common:actions.add")}
                        </button>
                      </div>
                    )}
                    {s.description && <div className="muted small">{s.description}</div>}
                  </td>
                  <td data-label={t("wizard.companies.columns.code")}>
                    <input
                      value={slotCodes[s.key] ?? ""}
                      placeholder={s.code ?? ""}
                      maxLength={20}
                      onChange={(e) => setSlotCodes((m) => ({ ...m, [s.key]: asciiUpper(e.target.value) }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {step === 3 && (
        <div className="stack">
          {dimensions.some((d) => d.editable) && (
            <div className="card">
              <strong>{t("wizard.preview.dimensions.heading")}</strong>
              <p className="muted small" style={{ margin: "4px 0 8px" }}>
                {t("wizard.preview.dimensions.hint")}
              </p>
              <div className="choices">
                {dimensions
                  .filter((d) => d.editable)
                  .map((d) => (
                    <div key={d.name}>
                      <label style={{ marginTop: 0 }}>{d.name}</label>
                      <textarea
                        rows={Math.min(8, Math.max(3, d.values.length))}
                        value={dimText[d.name] ?? d.values.join("\n")}
                        onChange={(e) => setDimText((m) => ({ ...m, [d.name]: e.target.value }))}
                      />
                    </div>
                  ))}
              </div>
              <button type="button" style={{ marginTop: 8 }} onClick={() => void runPreview()}>
                {t("wizard.preview.actions.refresh")}
              </button>
            </div>
          )}
          {!preview && <p className="muted">{t("wizard.preview.loading")}</p>}
          {preview && (
            <>
              <div className="wizard-stats">
                {(
                  [
                    [preview.counts.folders, "foldersNow"],
                    [preview.counts.virtualFolders, "foldersOnDemand"],
                    [preview.counts.grants, "grants"],
                    [preview.counts.workflows, "workflows"],
                    [preview.counts.namingStandards, "namingStandards"],
                    [preview.counts.attributes, "attributes"],
                  ] as const
                ).map(([n, key]) => (
                  <div key={key}>
                    <strong>{n}</strong>
                    <span>{t(`wizard.preview.stats.${key}`, { count: n })}</span>
                  </div>
                ))}
              </div>
              {preview.errors.length > 0 && (
                <div className="error">
                  {preview.errors.map((e) => (
                    <div key={e}>{e}</div>
                  ))}
                </div>
              )}
              {preview.warnings.length > 0 && (
                <ul className="notice wizard-warnings">
                  {preview.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              <div className="card" style={{ maxHeight: 360, overflow: "auto", padding: 8 }}>
                {preview.tree.map((n) => (
                  <PreviewNode key={n.name} node={n} depth={0} slots={preview.slots} />
                ))}
              </div>
              <p className="muted small" style={{ margin: 0 }}>
                {t("wizard.preview.onDemandHint")}
              </p>
            </>
          )}
        </div>
      )}

      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <span className="wizard-progress">
          {t("wizard.progress", { current: step + 1, total: steps.length })}
        </span>
        <button type="button" onClick={step === 0 ? onClose : () => setStep(step - 1)}>
          {step === 0 ? t("common:actions.cancel") : t("common:actions.back")}
        </button>
        {last ? (
          <button
            className="primary"
            disabled={busy || !code.trim() || !name.trim() || (step === 3 && (!preview || !preview.ok))}
            onClick={() => void create()}
          >
            {busy ? t("wizard.creating") : t("wizard.actions.create")}
          </button>
        ) : (
          <button className="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
            {t("common:actions.next")}
          </button>
        )}
      </div>
    </Dialog>
  );
}

function PreviewNode({ node, depth, slots }: { node: PreviewFolderDto; depth: number; slots: TemplateSlot[] }) {
  const { t } = useTranslation(["projects", "common"]);
  const levelLabel = useLabel();
  const [open, setOpen] = useState(depth < 1);
  const hasKids = !!node.children?.length;
  const label = (key: string) => (key === "*" ? t("wizard.preview.allRoles") : (slots.find((s) => s.key === key)?.label ?? key));
  return (
    <div>
      <div className="row" style={{ gap: 6, paddingLeft: depth * 16, minHeight: 26, flexWrap: "wrap" }}>
        <span className="tree-toggle" style={{ cursor: hasKids ? "pointer" : "default" }} onClick={() => setOpen(!open)}>
          {hasKids ? (open ? "▾" : "▸") : ""}
        </span>
        <span className="row"><Icon name="folder" size={15} /> {node.name}</span>
        {node.state && <span className="badge info">{node.stateLabel ?? levelLabel("folderState", node.state)}</span>}
        {node.naming && <span className="badge" title={t("wizard.preview.namingStandard")}>{node.naming}</span>}
        {node.gate && <span className="badge warn">{t("wizard.preview.badges.gate")}</span>}
        {node.grants?.map((g) => (
          <span key={g.slot} className="badge ok" title={levelLabel("level", g.level)}>
            {t("wizard.preview.grant", { role: label(g.slot), level: levelLabel("level", g.level) })}
          </span>
        ))}
        {!!node.onDemandTotal && (
          <span className="muted small" title={node.onDemand?.join(", ")}>
            {t("wizard.template.onDemand", { count: node.onDemandTotal })}
          </span>
        )}
      </div>
      {open && node.children?.map((c) => <PreviewNode key={c.name} node={c} depth={depth + 1} slots={slots} />)}
    </div>
  );
}
