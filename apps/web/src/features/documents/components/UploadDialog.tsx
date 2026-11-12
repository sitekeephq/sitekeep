import { Fragment, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  validateAttributes,
  validateName,
  type EffectiveAttributeDto,
  type FolderDto,
  type SuggestFileResultDto,
} from "@sitekeep/shared";
import { formatSize } from "../../../shared/api/api";
import { documentsApi, type DocIntelSuggestResult, type UploadResult } from "../api";
import { AttributeInput } from "../../../shared/ui/AttributeInput";
import { ConfidenceBadge } from "./AntetPanel";
import { Dialog } from "../../../shared/ui/Dialog";
import { LoadingSpinner } from "../../../shared/ui/LoadingIndicator";

/** PDFs up to this size are sent for a title-block suggestion (server limit, nothing is stored). */
const SUGGEST_MAX_BYTES = 30 * 1024 * 1024;

interface Plan {
  accept: boolean;
  name: string;
  attrs: Record<string, string>;
  open: boolean;
}

const isPdf = (f: File) => /\.pdf$/i.test(f.name);

/**
 * Checks names against the folder's naming standard first, then uploads the valid files.
 * Same flow the AECPilot delivery uses: validate → upload → report.
 * PDFs get an "Antetten öneri": a name and attributes read from the title block, which the user
 * accepts per file or for all files at once.
 */
export function UploadDialog({
  projectId,
  folder,
  attributes = [],
  files,
  existing = [],
  onClose,
  onDone,
}: {
  projectId: string;
  folder: FolderDto;
  /** Attribute definitions that apply to the folder. */
  attributes?: EffectiveAttributeDto[];
  files: File[];
  /** Files already in the folder: an upload with the same name becomes their next version. */
  existing?: { name: string; currentVersion: number }[];
  onClose(): void;
  onDone(): void;
}) {
  const { t, i18n } = useTranslation(["documents", "common"]);
  const [checks, setChecks] = useState<Record<string, string[]> | null>(null);
  const [standard, setStandard] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [intel, setIntel] = useState<DocIntelSuggestResult | null>(null);
  const [intelBusy, setIntelBusy] = useState<"read" | "ai" | null>(null);
  const [intelError, setIntelError] = useState<string | null>(null);
  const [plans, setPlans] = useState<Record<string, Plan>>({});

  useEffect(() => {
    documentsApi
      .validateNames(projectId, folder.id, files.map((f) => f.name))
      .then((r) => {
        setStandard(r.standard);
        setChecks(Object.fromEntries(r.results.map((x) => [x.name, x.errors])));
      })
      .catch((e: Error) => setError(e.message));
  }, [projectId, folder.id, files]);

  const pdfs = files.filter((f) => isPdf(f) && f.size <= SUGGEST_MAX_BYTES);

  function applyIntel(r: DocIntelSuggestResult, keepAccepted: boolean) {
    setIntel((cur) => {
      if (!cur) return r;
      const byName = new Map(r.results.map((x) => [x.name, x]));
      return { ...r, results: cur.results.map((x) => byName.get(x.name) ?? x) };
    });
    setPlans((cur) => {
      const next = { ...cur };
      for (const x of r.results) {
        const s = x.suggestion;
        const prev = cur[x.name];
        next[x.name] = {
          accept: keepAccepted && prev ? prev.accept : false,
          name: s?.name ?? prev?.name ?? x.name,
          attrs: Object.fromEntries((s?.attributes ?? []).map((a) => [a.name, a.value])),
          open: prev?.open ?? false,
        };
      }
      return next;
    });
  }

  async function readTitleBlocks(ai: boolean, only?: File[]) {
    const list = only ?? pdfs;
    if (!list.length) return;
    setIntelBusy(ai ? "ai" : "read");
    setIntelError(null);
    try {
      applyIntel(await documentsApi.docIntelSuggest(projectId, folder.id, list, ai), ai);
    } catch (e) {
      setIntelError((e as Error).message);
    } finally {
      setIntelBusy(null);
    }
  }

  useEffect(() => {
    void readTitleBlocks(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, folder.id, files]);

  const intelOf = (f: File): SuggestFileResultDto | undefined => intel?.results.find((r) => r.name === f.name);
  const nameProblems = (name: string): string[] => (intel?.standard ? validateName(intel.standard, name, i18n.language).errors : []);
  const planOf = (f: File) => (plans[f.name]?.accept ? plans[f.name] : undefined);
  const effectiveName = (f: File) => planOf(f)?.name ?? f.name;
  const prior = (name: string) => existing.find((e) => e.name.normalize("NFC") === name.normalize("NFC"));
  const fileErrors = (f: File): string[] | undefined => {
    const p = planOf(f);
    if (p) return nameProblems(p.name);
    return checks?.[f.name];
  };
  const valid = files.filter((f) => checks && !fileErrors(f)?.length);
  const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
  // Required values may already be on the file when a new version is uploaded; the server
  // has the final word, so only invalid values block the button here.
  const attrErrors = validateAttributes(attributes, filled, { partial: true, lang: i18n.language });
  const planAttrErrors = files.flatMap((f) => {
    const p = planOf(f);
    if (!p) return [];
    const own = Object.fromEntries(Object.entries(p.attrs).filter(([, v]) => v.trim()));
    return validateAttributes(attributes, own, { partial: true, lang: i18n.language }).map((e) => `${f.name}: ${e.message}`);
  });
  const missingRequired = attributes.filter((d) => d.required && !filled[d.name]);
  const suggestable = files.filter((f) => {
    const s = intelOf(f)?.suggestion;
    return !!s?.name && !s.unchanged;
  });
  const openFields = intel?.results.filter((r) => r.suggestion && !r.suggestion.ok && r.antet) ?? [];

  function setPlan(name: string, patch: Partial<Plan>) {
    setPlans((cur) => ({ ...cur, [name]: { ...cur[name]!, ...patch } }));
  }

  async function upload() {
    setTouched(true);
    if (attrErrors.length || planAttrErrors.length) return;
    setBusy(true);
    setError(null);
    try {
      const plain = valid.filter((f) => !planOf(f));
      const planned = valid.filter((f) => planOf(f));
      const all: UploadResult["results"] = [];
      let std: string | null = null;
      if (plain.length) {
        const r = await documentsApi.upload(projectId, folder.id, plain, comment || undefined, filled);
        std = r.standard;
        all.push(...(r.results ?? []));
      }
      // Files with an accepted suggestion are sent one by one: own name and own attributes
      // (values typed in the common form take precedence).
      for (const f of planned) {
        const p = planOf(f)!;
        const own = Object.fromEntries(Object.entries(p.attrs).filter(([, v]) => v.trim()));
        const renamed = new File([f], p.name, { type: f.type, lastModified: f.lastModified });
        const r = await documentsApi.upload(projectId, folder.id, [renamed], comment || undefined, { ...own, ...filled });
        std = r.standard;
        all.push(...(r.results ?? []));
      }
      if (all.some((x) => x.ok)) {
        setResult({ standard: std, results: all });
        onDone();
      } else {
        // Nothing was stored: keep the form so the values can be fixed and sent again.
        setError(all.map((x) => `${x.name}: ${x.errors.join("; ")}`).join(" · ") || t("upload.errors.failed"));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t("upload.title", { folder: folder.name })} onClose={onClose} wide>
      {standard ? (
        <p className="notice small">
          <Trans t={t} i18nKey="upload.standardRequired" values={{ standard }} components={{ b: <strong /> }} />
        </p>
      ) : (
        <p className="muted small">{t("upload.noStandard")}</p>
      )}
      {pdfs.length > 0 && !result && (
        <div className="row wrap small" style={{ marginBottom: 8 }}>
          {intelBusy === "read" ? (
            <span className="muted">{t("upload.readingTitleBlocks")}</span>
          ) : intel ? (
            <span className="muted">{t("upload.suggestionsFound", { count: suggestable.length })}</span>
          ) : null}
          {intelError && <span className="error">{t("upload.errors.titleBlock", { error: intelError })}</span>}
          <div className="spacer" />
          {intel?.aiAvailable && openFields.length > 0 && (
            <button
              className="small"
              disabled={!!intelBusy}
              title={t("upload.aiHint")}
              onClick={() => void readTitleBlocks(true, files.filter((f) => openFields.some((o) => o.name === f.name)))}
            >
              {intelBusy === "ai" ? t("upload.status.aiThinking") : t("upload.actions.refineWithAi", { count: openFields.length })}
            </button>
          )}
          {suggestable.length > 0 && (
            <button
              className="small primary"
              disabled={!!intelBusy}
              onClick={() => {
                for (const f of suggestable) setPlan(f.name, { accept: true });
              }}
            >
              {t("upload.actions.applyAll")}
            </button>
          )}
        </div>
      )}
      <table className="phone-cards">
        <thead>
          <tr>
            <th>{t("common:fields.file")}</th>
            <th style={{ width: 90 }}>{t("common:fields.size")}</th>
            <th>{t("upload.columns.check")}</th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => {
            const errs = fileErrors(f);
            const shown = effectiveName(f);
            const res = result?.results.find((r) => r.name === shown);
            const info = intelOf(f);
            const plan = plans[f.name];
            return (
              <Fragment key={f.name}>
                <tr>
                  <td className="mono pc-title">
                    {plan?.accept ? (
                      <>
                        <div className="muted" style={{ textDecoration: "line-through" }}>
                          {f.name}
                        </div>
                        <div>{shown}</div>
                      </>
                    ) : (
                      f.name
                    )}
                  </td>
                  <td className="muted" data-label={t("common:fields.size")}>{formatSize(f.size)}</td>
                  <td data-label={t("upload.columns.check")}>
                    {res ? (
                      res.ok ? (
                        <span className="badge ok">{t("upload.uploadedVersion", { version: res.version })}</span>
                      ) : (
                        <span className="badge danger">{res.errors.join("; ")}</span>
                      )
                    ) : !checks ? (
                      <span className="muted small">{t("upload.checking")}</span>
                    ) : errs?.length ? (
                      <span className="small" style={{ color: "var(--danger)" }}>{errs.join(" · ")}</span>
                    ) : prior(shown) ? (
                      <span className="badge info" title={t("upload.newVersionHint")}>
                        {t("upload.newVersion", { version: prior(shown)!.currentVersion + 1 })}
                      </span>
                    ) : (
                      <span className="badge ok">{t("upload.newFile")}</span>
                    )}
                  </td>
                </tr>
                {!result && info && plan && (
                  <tr className="pc-detail">
                    <td colSpan={3} style={{ paddingTop: 0 }}>
                      <SuggestionRow
                        info={info}
                        plan={plan}
                        attributes={attributes}
                        problems={plan.accept ? nameProblems(plan.name) : []}
                        onChange={(p) => setPlan(f.name, p)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {!result && attributes.length > 0 && (
        <div className="card" style={{ padding: 12, marginTop: 12 }}>
          <h3>{t("upload.attributes.heading")}</h3>
          <p className="muted small" style={{ marginTop: 0 }}>
            {t("upload.attributes.help")}
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "0 12px" }}>
            {attributes.map((d) => (
              <div key={d.id}>
                <label>
                  {d.name}
                  {d.required && <span style={{ color: "var(--danger)" }}> *</span>}
                </label>
                <AttributeInput
                  def={d}
                  value={values[d.name] ?? ""}
                  onChange={(v) => setValues((s) => ({ ...s, [d.name]: v }))}
                  emptyLabel={t("upload.attributes.choose")}
                />
              </div>
            ))}
          </div>
          {(touched || Object.keys(filled).length > 0) && attrErrors.length > 0 && (
            <p className="error small">{attrErrors.map((e) => e.message).join(" ")}</p>
          )}
          {missingRequired.length > 0 && (
            <p className="muted small">
              {t("upload.attributes.missingRequired", { names: missingRequired.map((d) => d.name).join(", ") })}
            </p>
          )}
        </div>
      )}
      {planAttrErrors.length > 0 && <p className="error small">{planAttrErrors.join(" ")}</p>}
      {!result && (
        <>
          <label>{t("upload.fields.comment")}</label>
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("upload.commentPlaceholder")} />
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        {result ? (
          <button className="primary" onClick={onClose}>
            {t("common:actions.close")}
          </button>
        ) : (
          <>
            <button onClick={onClose}>{t("common:actions.cancel")}</button>
            <button
              className="primary"
              disabled={busy || !valid.length || attrErrors.length > 0 || planAttrErrors.length > 0}
              onClick={() => void upload()}
            >
              {busy ? <LoadingSpinner className="small" /> : t("upload.actions.upload", { count: valid.length })}
            </button>
          </>
        )}
      </div>
    </Dialog>
  );
}

function SuggestionRow({
  info,
  plan,
  attributes,
  problems,
  onChange,
}: {
  info: SuggestFileResultDto;
  plan: Plan;
  attributes: EffectiveAttributeDto[];
  problems: string[];
  onChange(p: Partial<Plan>): void;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const s = info.suggestion;
  if (info.error) return <div className="muted small">{t("upload.suggestion.error", { error: info.error })}</div>;
  if (!s || !info.antet) return null;
  const rev = info.revision?.value;
  return (
    <div className="card small" style={{ padding: "6px 10px" }}>
      <div className="row wrap">
        <strong>{t("upload.suggestion.label")}</strong>
        {s.name ? (
          s.unchanged ? (
            <span className="muted">{t("upload.suggestion.alreadyValid")}</span>
          ) : (
            <span className="mono">{s.name}</span>
          )
        ) : (
          <span className="muted">{s.errors.length ? t("upload.suggestion.noNameWithErrors", { errors: s.errors.join("; ") }) : t("upload.suggestion.noName")}</span>
        )}
        {rev && <span className="badge info">{t("upload.suggestion.rev", { rev })}</span>}
        {s.ai?.used && (
          <span className={`badge ${s.ai.accepted ? "ok" : "warn"}`} title={s.ai.note}>
            {s.ai.accepted ? t("upload.suggestion.withAi") : t("upload.suggestion.aiRejected")}
          </span>
        )}
        <div className="spacer" />
        {s.name && !s.unchanged && (
          <button className={plan.accept ? "small" : "small primary"} onClick={() => onChange({ accept: !plan.accept })}>
            {plan.accept ? t("upload.suggestion.actions.undo") : t("common:actions.apply")}
          </button>
        )}
        <button className="small ghost" onClick={() => onChange({ open: !plan.open })}>
          {plan.open ? t("common:actions.hide") : t("upload.suggestion.actions.details")}
        </button>
      </div>
      {plan.open && (
        <div className="stack" style={{ marginTop: 6 }}>
          {plan.accept && (
            <div>
              <label>{t("upload.suggestion.fields.name")}</label>
              <input className="mono" value={plan.name} onChange={(e) => onChange({ name: e.target.value })} />
              {problems.length > 0 && <p className="error small">{problems.join(" · ")}</p>}
            </div>
          )}
          {s.fields.length > 0 && (
            <table className="props-table">
              <tbody>
                {s.fields.map((f) => (
                  <tr key={f.field}>
                    <td>{f.field}</td>
                    <td className="mono" style={{ whiteSpace: "nowrap" }}>
                      {f.value ?? <span className="muted">—</span>}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <ConfidenceBadge value={f.confidence} ambiguous={f.ambiguous} />
                    </td>
                    <td className="muted">
                      {f.explanation}
                      {f.alternatives.length > 0 && t("upload.suggestion.alternatives", { values: f.alternatives.join(", ") })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {s.attributes.length > 0 && (
            <div>
              <div className="muted">{t("upload.suggestion.attributes")}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "0 12px" }}>
                {s.attributes.map((a) => {
                  const def = attributes.find((d) => d.name === a.name);
                  const set = (v: string) => onChange({ attrs: { ...plan.attrs, [a.name]: v } });
                  return (
                    <div key={a.name} title={a.explanation}>
                      <label>
                        {a.name}
                        {a.freeForm && <span className="muted"> {t("upload.suggestion.freeForm")}</span>}
                      </label>
                      {def ? (
                        <AttributeInput def={def} value={plan.attrs[a.name] ?? ""} onChange={set} />
                      ) : (
                        <input value={plan.attrs[a.name] ?? ""} onChange={(e) => set(e.target.value)} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {info.antet.note && <div className="muted">{info.antet.note}</div>}
        </div>
      )}
    </div>
  );
}
