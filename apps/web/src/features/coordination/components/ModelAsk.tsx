import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  ifcClassLabel,
  MODEL_CHANGE_LABELS_TR,
  MODEL_QUERY_OPS,
  modelFieldLabel,
  modelQueryChips,
  type ModelAskResultDto,
  type ModelChangeKind,
  type ModelQuery,
  type ModelQueryOp,
  type ModelQueryResultDto,
  type ModelVocabDto,
} from "@sitekeep/shared";
import { ApiError, api, formatNumber, type AiProviderSelection, type ProjectAiDto } from "../../../shared/api/api";
import type { ViewerEngine } from "@7dimensions-project/bim-viewer";
import { useLabel } from "../../../i18n";
import { AiTaskButton } from "../../../shared/ai/AiTaskButton";
import { webModules } from "../../../app/modules";

type Result = ModelQueryResultDto & Partial<Pick<ModelAskResultDto, "source" | "model" | "aiError" | "cached" | "question" | "ms">>;
type Mode = "color" | "isolate" | "none";

/** Example questions (keys in "ai"); shown and sent in the interface language. */
const EXAMPLES = ["modelAsk.examples.notEi60", "modelAsk.examples.slabArea", "modelAsk.examples.wallsByStorey", "modelAsk.examples.fireDoors"] as const;
const COMPARE_EXAMPLES = ["modelAsk.compareExamples.changedDoors", "modelAsk.compareExamples.deletedWalls", "modelAsk.compareExamples.addedByStorey"] as const;

const BUILTIN_FIELDS = [
  { key: "type", labelKey: "modelAsk.fields.type" },
  { key: "name", labelKey: "modelAsk.fields.name" },
  { key: "material", labelKey: "modelAsk.fields.material" },
  { key: "storey", labelKey: "modelAsk.fields.storey" },
  { key: "class", labelKey: "modelAsk.fields.class" },
] as const;

const DISPLAY_MODES = [
  ["color", "modelAsk.display.options.color"],
  ["isolate", "modelAsk.display.options.isolate"],
  ["none", "modelAsk.display.options.none"],
] as const satisfies readonly (readonly [Mode, string])[];

const MODEL_CHANGES = Object.keys(MODEL_CHANGE_LABELS_TR) as ModelChangeKind[];

const number = (v: number) => formatNumber(v, { maximumFractionDigits: 2 });

/**
 * "Modele sor": a question box over the loaded IFC version (or over the changes of a comparison).
 * An instant keyword answer comes first; the AI answer replaces it when it arrives. The query is
 * shown as chips that can be edited without AI (filter builder).
 */
export function ModelAskPanel({
  projectId,
  engine,
  versionId,
  versions,
  onVersion,
  compareFrom,
  onIssue,
  onClose,
  embedded,
}: {
  projectId: string;
  engine: ViewerEngine | null;
  /** Model (file version) the question is about; it must be loaded in the viewer. */
  versionId: string;
  /** Loaded models to choose from. */
  versions?: { id: string; label: string }[];
  onVersion?(id: string): void;
  /** Comparison scope: the older version (removed elements live there). */
  compareFrom?: string | null;
  onIssue(guids: string[], title: string, description: string): void;
  onClose?(): void;
  embedded?: boolean;
}) {
  const { t, i18n } = useTranslation(["ai", "common"]);
  const label = useLabel();
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [draft, setDraft] = useState<ModelQuery>({});
  const [pending, setPending] = useState<null | { started: number; quick: boolean }>(null);
  const [, setTick] = useState(0);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prep, setPrep] = useState<string | null>(null);
  const [builder, setBuilder] = useState(false);
  const [vocab, setVocab] = useState<ModelVocabDto | null>(null);
  const [mode, setMode] = useState<Mode>("color");
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [ai, setAi] = useState<ProjectAiDto | null>(null);
  const [providerSelection, setProviderSelection] = useState<AiProviderSelection>("project");
  const [providerModel, setProviderModel] = useState("");
  const ctl = useRef<AbortController | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const allMode = versionId === "all" && !!versions && versions.length > 1 && !compareFrom;
  const primaryId = allMode ? versions[0]!.id : versionId;
  const federatedIds = allMode ? versions.map((v) => v.id) : undefined;
  const federatedKey = federatedIds?.join(",") ?? primaryId;

  // New model or scope: start over.
  useEffect(() => {
    ctl.current?.abort();
    clearTimeout(retry.current);
    setResult(null);
    setDraft({});
    setVocab(null);
    setPending(null);
    setError(null);
    setPrep(null);
    setAiNote(null);
  }, [federatedKey, compareFrom]);

  useEffect(
    () => () => {
      ctl.current?.abort();
      clearTimeout(retry.current);
    },
    [],
  );

  // Elapsed seconds while the AI works.
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [pending]);

  // Colour / isolate the matches.
  useEffect(() => {
    if (!engine) return;
    if (!result || mode === "none") {
      void engine.clearMatches();
      return;
    }
    const groups = result.byVersion?.length
      ? result.byVersion.map((g) => ({ modelId: g.versionId, guids: g.guids }))
      : [{ modelId: primaryId, guids: result.guids }];
    if (compareFrom && result.removedGuids.length) groups.push({ modelId: compareFrom, guids: result.removedGuids });
    void engine.showMatches(groups, { isolate: mode === "isolate", zoom: mode === "isolate" });
  }, [engine, result, mode, primaryId, compareFrom]);

  useEffect(() => () => void engine?.clearMatches(), [engine]);

  useEffect(() => {
    // Project AI settings come from the AI module; without it there is nothing to ask for.
    if (!webModules.some((m) => m.id === "ai")) return setAi(null);
    api.projectAi(projectId).then(setAi, () => setAi(null));
  }, [projectId]);

  const selectedPersonal = providerSelection === "project" ? null : ai?.personal.providers.find((provider) => provider.id === providerSelection);
  const providerModels = providerSelection === "project" ? (ai?.effective.models ?? []) : (selectedPersonal?.models ?? []);

  useEffect(() => {
    const fallback = providerSelection === "project" ? ai?.effective.model : selectedPersonal?.model;
    setProviderModel((current) =>
      providerModels.some((model) => model.id === current) ? current : (fallback ?? providerModels[0]?.id ?? ""),
    );
  }, [ai, providerSelection, selectedPersonal?.model]);

  // Vocabulary for the filter builder.
  useEffect(() => {
    if (!builder || vocab) return;
    api.modelVocab(projectId, primaryId, compareFrom, federatedIds).then(setVocab, (e: Error) => setError(e.message));
  }, [builder, vocab, projectId, primaryId, compareFrom, federatedKey]);

  function show(r: Result) {
    setResult(r);
    setDraft(r.query);
    setSaved(null);
  }

  function failed(e: unknown, again: () => void) {
    if ((e as Error).name === "AbortError") return;
    if (e instanceof ApiError && e.status === 409) {
      setPrep(e.message);
      retry.current = setTimeout(again, 4000);
      return;
    }
    setError((e as Error).message);
  }

  async function ask(text = question) {
    const q = text.trim();
    if (q.length < 2) return;
    ctl.current?.abort();
    clearTimeout(retry.current);
    const ac = new AbortController();
    ctl.current = ac;
    setError(null);
    setPrep(null);
    setAiNote(null);
    setPending({ started: Date.now(), quick: true });
    let aiDone = false;
    // Instant keyword answer first …
    api.modelAsk(projectId, primaryId, q, { compareFrom, versionIds: federatedIds, mode: "rules", signal: ac.signal }).then(
      (r) => {
        if (!aiDone && !ac.signal.aborted) {
          show(r);
          setPending((p) => (p ? { ...p, quick: false } : p));
        }
      },
      () => undefined,
    );
    // … then the AI answer.
    try {
      const r = await api.modelAsk(projectId, primaryId, q, {
        compareFrom,
        versionIds: federatedIds,
        provider: providerSelection,
        model: providerModel || undefined,
        signal: ac.signal,
      });
      aiDone = true;
      if (ac.signal.aborted) return;
      setPrep(null);
      show(r);
      if (r.source === "rules" && r.aiError) setAiNote(r.aiError);
    } catch (e) {
      failed(e, () => void ask(q));
    } finally {
      if (ctl.current === ac) setPending(null);
    }
  }

  function cancel() {
    ctl.current?.abort();
    clearTimeout(retry.current);
    setPending(null);
  }

  async function run(q: ModelQuery) {
    ctl.current?.abort();
    clearTimeout(retry.current);
    const ac = new AbortController();
    ctl.current = ac;
    setDraft(q);
    setError(null);
    setAiNote(null);
    try {
      const r = await api.modelQuery(projectId, primaryId, q, compareFrom, federatedIds);
      if (ac.signal.aborted) return;
      setPrep(null);
      // An edited query no longer answers the typed question.
      show(r);
    } catch (e) {
      failed(e, () => void run(q));
    }
  }

  function removeChip(part: string, index: number) {
    const q: ModelQuery = JSON.parse(JSON.stringify(draft));
    if (part === "class") q.classes = q.classes?.filter((_, i) => i !== index);
    if (part === "storey") q.storeys = q.storeys?.filter((_, i) => i !== index);
    if (part === "filter") q.filters = q.filters?.filter((_, i) => i !== index);
    if (part === "groupBy") q.groupBy = q.groupBy?.filter((_, i) => i !== index);
    if (part === "aggregate") delete q.aggregate;
    if (part === "change") q.change = q.change?.filter((_, i) => i !== index);
    void run(q);
  }

  async function saveReport() {
    if (!result) return;
    setSaving(true);
    setError(null);
    try {
      const d = await api.modelReportDraft(projectId, primaryId, result.query, result.question ?? modelQueryChips(result.query, i18n.language).map((c) => c.text).join(", "));
      const created = await api.createReport(projectId, { ...d, sharing: "private" });
      setSaved(created.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function focus(guid: string, change?: ModelChangeKind, elementVersionId?: string) {
    void engine?.focusGuid(guid, change === "removed" && compareFrom ? [compareFrom] : [elementVersionId ?? primaryId]);
  }

  const chips = modelQueryChips(draft, i18n.language);
  const examples = compareFrom ? COMPARE_EXAMPLES : EXAMPLES;
  const elapsed = pending ? Math.round((Date.now() - pending.started) / 1000) : 0;

  return (
    <div className={`mq${embedded ? " embedded" : ""}`}>
      {!embedded && (
        <div className="row">
          <h3 style={{ margin: 0 }}>✦ {t("modelAsk.title")}</h3>
          <div className="spacer" />
          {onClose && (
            <button className="ghost small" onClick={onClose} title={t("common:actions.close")}>
              ✕
            </button>
          )}
        </div>
      )}
      {embedded && <h4 className="mq-sub">✦ {t("modelAsk.compareTitle")}</h4>}
      {versions && versions.length > 1 && onVersion && (
        <select className="mq-model" value={versionId} onChange={(e) => onVersion(e.target.value)} aria-label={t("modelAsk.aria.model")}>
          {!compareFrom && <option value="all">{t("modelAsk.allModels", { count: versions.length })}</option>}
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      )}
      {ai && (
        <div className="row wrap">
          <select
            className="mq-model"
            value={providerSelection}
            disabled={!!pending}
            aria-label={t("provider.aria.provider")}
            onChange={(event) => setProviderSelection(event.target.value as AiProviderSelection)}
          >
            <option value="project">
              {ai.effective.providerName ? t("provider.projectWith", { name: ai.effective.providerName }) : t("provider.project")}
            </option>
            {ai.personal.providers.map((provider) => (
              <option key={provider.id} value={provider.id} disabled={!provider.hasApiKey || !ai.personal.allowed}>
                {!provider.hasApiKey
                  ? t("provider.keyNeeded", { name: provider.name })
                  : !ai.personal.allowed
                    ? t("provider.notAllowed", { name: provider.name })
                    : provider.name}
              </option>
            ))}
          </select>
          {providerModels.length > 0 && (
            <select
              className="mq-model"
              value={providerModel}
              disabled={!!pending}
              aria-label={t("provider.aria.model")}
              onChange={(event) => setProviderModel(event.target.value)}
            >
              {providerModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          )}
          <Link to={`/projects/${projectId}/settings?sekme=yapay-zeka`} className="small">
            {t("provider.useOwnKey")}
          </Link>
        </div>
      )}
      <form
        className="mq-ask"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={compareFrom ? t("modelAsk.placeholderCompare") : t("modelAsk.placeholder")}
          aria-label={t("modelAsk.aria.question")}
        />
        <button className="primary" type="submit" disabled={question.trim().length < 2}>
          {t("ask.actions.ask")}
        </button>
      </form>
      {!result && !pending && (
        <div className="row wrap mq-examples">
          {examples.map((key) => (
            <button
              key={key}
              type="button"
              className="chip small"
              onClick={() => {
                const x = t(key);
                setQuestion(x);
                void ask(x);
              }}
            >
              {t(key)}
            </button>
          ))}
        </div>
      )}
      {pending && (
        <div className="mq-pending small">
          <span className="mq-spinner" aria-hidden />
          {pending.quick ? t("modelAsk.messages.searching") : t("modelAsk.messages.aiWorking", { seconds: elapsed })}
          <div className="spacer" />
          <button className="ghost small" type="button" onClick={cancel}>
            {t("actions.cancel")}
          </button>
        </div>
      )}
      {prep && <p className="notice small">{prep}</p>}
      {error && <p className="error small">{error}</p>}
      {aiNote && (
        <p className="muted small">
          {t("modelAsk.messages.keywordAnswer")} <span title={aiNote}>{t("modelAsk.messages.aiFailed", { error: aiNote })}</span>
        </p>
      )}
      <AiTaskButton
        projectId={projectId}
        kind="model_ask"
        input={question.trim().length >= 2 ? { versionId: primaryId, question: question.trim(), ...(compareFrom && { compareFrom }), ...(federatedIds && { versionIds: federatedIds }) } : null}
        small
        disabled={!!pending}
        disabledReason={pending ? t("modelAsk.errors.waitCurrent") : t("modelAsk.errors.tooShort")}
        onResult={(r) => show(r as Result)}
      />

      {result && (
        <div className="mq-result">
          <div className="row wrap small">
            {result.source === "ai" ? (
              <span className="badge info">
                {t("modelAsk.badges.ai")}
                {result.model ? ` · ${result.model}` : ""}
                {result.cached ? ` · ${t("modelAsk.cached")}` : ""}
              </span>
            ) : result.source === "rules" ? (
              <span className="badge">{t("modelAsk.badges.quick")}</span>
            ) : (
              <span className="badge">{t("modelAsk.badges.filter")}</span>
            )}
            <span className="muted">{t("modelAsk.matchCount", { n: result.count, total: result.total })}</span>
          </div>
          <p className="mq-answer">{result.answer}</p>
          {result.warnings.map((w) => (
            <p key={w} className="muted small" style={{ margin: "2px 0" }}>
              ⚠ {w}
            </p>
          ))}
        </div>
      )}

      {(result || builder) && (
        <div className="mq-chips">
          {chips.map((c) => (
            <span key={`${c.part}-${c.index}`} className="mq-chip">
              {c.text}
              <button type="button" onClick={() => removeChip(c.part, c.index)} aria-label={t("modelAsk.aria.remove", { text: c.text })} title={t("common:actions.remove")}>
                ✕
              </button>
            </span>
          ))}
          {!chips.length && <span className="muted small">{t("modelAsk.empty")}</span>}
          <button type="button" className="ghost small" onClick={() => setBuilder((b) => !b)}>
            {builder ? t("modelAsk.actions.closeBuilder") : t("modelAsk.actions.addFilter")}
          </button>
        </div>
      )}
      {!result && !builder && (
        <button type="button" className="ghost small" style={{ paddingLeft: 0 }} onClick={() => setBuilder(true)}>
          {t("modelAsk.actions.buildWithoutAi")}
        </button>
      )}
      {builder && <FilterBuilder vocab={vocab} draft={draft} comparing={!!compareFrom} onApply={(q) => void run(q)} />}

      {result && (
        <>
          <div className="row wrap mq-actions">
            <div className="seg" role="group" aria-label={t("modelAsk.aria.display")}>
              {DISPLAY_MODES.map(([m, labelKey]) => (
                <button key={m} type="button" className={`small${mode === m ? " primary" : ""}`} onClick={() => setMode(m)}>
                  {t(labelKey)}
                </button>
              ))}
            </div>
            {!compareFrom && !allMode && (
              <button type="button" className="small" disabled={saving} onClick={() => void saveReport()}>
                {saving ? t("common:status.saving") : t("modelAsk.actions.saveReport")}
              </button>
            )}
            <button
              type="button"
              className="small"
              disabled={!result.guids.length}
              title={result.guids.length > 5000 ? t("modelAsk.firstElementsHint") : undefined}
              onClick={() => onIssue(result.guids.slice(0, 5000), (result.question ?? chips.map((c) => c.text).join(", ")) || t("modelAsk.defaultIssueTitle"), result.answer)}
            >
              {t("modelAsk.actions.createIssue")}
            </button>
          </div>
          {saved && (
            <p className="success small">
              {t("modelAsk.messages.reportSaved")} <Link to={`/projects/${projectId}/reports/${saved}`}>{t("common:actions.open")}</Link>
            </p>
          )}
          {result.table && (
            <div className="mq-table">
              <table className="props-table">
                <thead>
                  <tr>
                    {result.table.columns.map((c) => (
                      <th key={c.key}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.table.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((v, j) => (
                        <td key={j}>{typeof v === "number" ? number(v) : (v ?? "—")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="cmp-list mq-list">
            {result.elements.map((e) => (
              <div
                key={`${e.versionId ?? ""}${e.change ?? ""}${e.guid}`}
                className="model-item small"
                style={{ cursor: "pointer" }}
                onClick={() => focus(e.guid, e.change, e.versionId)}
              >
                <div style={{ minWidth: 0 }}>
                  <div>
                    {e.name ?? <span className="muted">{t("modelAsk.unnamed")}</span>}
                    {e.value !== undefined && e.value !== null && (
                      <span className="muted"> · {typeof e.value === "number" ? number(e.value) : String(e.value)}</span>
                    )}
                  </div>
                  <div className="muted">
                    {e.change && <span className={`mq-change ${e.change}`}>{label("modelChange", e.change)}</span>}
                    {ifcClassLabel(e.class, i18n.language)}
                    {e.storey ? ` · ${e.storey}` : ""}
                    {e.type ? ` · ${e.type}` : ""}
                    {e.modelName ? ` · ${e.modelName}` : ""}
                  </div>
                </div>
              </div>
            ))}
            {result.more > 0 && <p className="muted small">{t("modelAsk.messages.more", { count: result.more })}</p>}
          </div>
        </>
      )}
    </div>
  );
}

/** Builds the same query JSON by hand (when AI is off, or to correct the AI). */
function FilterBuilder({
  vocab,
  draft,
  comparing,
  onApply,
}: {
  vocab: ModelVocabDto | null;
  draft: ModelQuery;
  comparing: boolean;
  onApply(q: ModelQuery): void;
}) {
  const { t, i18n } = useTranslation(["ai", "common"]);
  const label = useLabel();
  const [field, setField] = useState("");
  const [op, setOp] = useState<ModelQueryOp>("=");
  const [value, setValue] = useState("");
  if (!vocab) return <p className="muted small">{t("filterBuilder.loading")}</p>;
  const numeric = vocab.properties.filter((p) => p.numeric);
  const samples = vocab.properties.find((p) => p.key === field || p.name === field)?.samples ?? [];
  const add = (patch: (q: ModelQuery) => void) => {
    const q: ModelQuery = JSON.parse(JSON.stringify(draft));
    patch(q);
    onApply(q);
  };
  const needsValue = op !== "exists" && op !== "missing";
  return (
    <div className="mq-builder">
      <div className="mq-brow">
        <select
          value=""
          aria-label={t("filterBuilder.aria.addClass")}
          onChange={(e) => e.target.value && add((q) => (q.classes = [...new Set([...(q.classes ?? []), e.target.value])]))}
        >
          <option value="">{t("filterBuilder.options.addClass")}</option>
          {vocab.classes.map((c) => (
            <option key={c.name} value={c.name}>
              {c.label} ({c.count})
            </option>
          ))}
        </select>
        <select
          value=""
          aria-label={t("filterBuilder.aria.addStorey")}
          onChange={(e) => e.target.value && add((q) => (q.storeys = [...new Set([...(q.storeys ?? []), e.target.value])]))}
        >
          <option value="">{t("filterBuilder.options.addStorey")}</option>
          {vocab.storeys.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name} ({s.count})
            </option>
          ))}
        </select>
        {comparing && (
          <select
            value=""
            aria-label={t("filterBuilder.aria.changeKind")}
            onChange={(e) => e.target.value && add((q) => (q.change = [...new Set([...(q.change ?? []), e.target.value as ModelChangeKind])]))}
          >
            <option value="">{t("filterBuilder.options.addChange")}</option>
            {MODEL_CHANGES.map((k) => (
              <option key={k} value={k}>
                {label("modelChange", k)}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="mq-brow">
        <select value={field} onChange={(e) => setField(e.target.value)} aria-label={t("filterBuilder.aria.field")}>
          <option value="">{t("filterBuilder.options.property")}</option>
          {BUILTIN_FIELDS.filter((f) => f.key !== "class" && f.key !== "storey").map((f) => (
            <option key={f.key} value={f.key}>
              {t(f.labelKey)}
            </option>
          ))}
          {vocab.properties.slice(0, 300).map((p) => (
            <option key={p.key} value={p.key}>
              {p.key} ({p.count})
            </option>
          ))}
        </select>
        <select value={op} onChange={(e) => setOp(e.target.value as ModelQueryOp)} aria-label={t("filterBuilder.aria.condition")} className="mq-op">
          {MODEL_QUERY_OPS.map((o) => (
            <option key={o} value={o}>
              {label("modelOp", o)}
            </option>
          ))}
        </select>
        {needsValue && (
          <>
            <input value={value} onChange={(e) => setValue(e.target.value)} list="mq-values" placeholder={t("filterBuilder.placeholder")} aria-label={t("filterBuilder.aria.value")} />
            <datalist id="mq-values">
              {samples.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </>
        )}
        <button
          type="button"
          className="small"
          disabled={!field || (needsValue && !value.trim())}
          onClick={() => {
            const f = { field, op, ...(needsValue ? { value: value.trim() } : {}) };
            add((q) => (q.filters = [...(q.filters ?? []), f]));
            setValue("");
          }}
        >
          {t("common:actions.add")}
        </button>
      </div>
      <div className="mq-brow">
        <select
          value={draft.groupBy?.[0] ?? ""}
          aria-label={t("filterBuilder.aria.groupBy")}
          onChange={(e) =>
            add((q) => {
              if (e.target.value) q.groupBy = [e.target.value];
              else delete q.groupBy;
            })
          }
        >
          <option value="">{t("filterBuilder.options.noGrouping")}</option>
          {BUILTIN_FIELDS.map((f) => (
            <option key={f.key} value={f.key}>
              {t("filterBuilder.options.groupByField", { field: t(f.labelKey) })}
            </option>
          ))}
        </select>
        <select
          value={draft.aggregate?.field ?? ""}
          aria-label={t("filterBuilder.aria.total")}
          onChange={(e) =>
            add((q) => {
              if (e.target.value) q.aggregate = { op: "sum", field: e.target.value };
              else delete q.aggregate;
            })
          }
        >
          <option value="">{t("filterBuilder.options.countOnly")}</option>
          {numeric.map((p) => (
            <option key={p.key} value={p.key}>
              {t("filterBuilder.options.aggregate", { op: label("modelAgg", "sum"), field: modelFieldLabel(p.key, i18n.language) })}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
