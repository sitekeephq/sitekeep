import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  REPORT_MODULES,
  isReportModule,
  reportQueryDatasets,
  reportValueLabels,
  type DashboardSummaryDto,
  type ReportCatalogDto,
  type ReportGenerateResult,
  type ReportModule,
  type ReportTemplateDto,
} from "@sitekeep/shared";
import { api, formatDate } from "../../../shared/api/api";
import { Dialog } from "../../../shared/ui/Dialog";
import { ReportFrame } from "../components/ReportFrame";
import { useLoad, useProject } from "../../../app/context/project";
import { AiTaskButton, useAiTaskMode } from "../../../shared/ai/AiTaskButton";
import { MoreMenu } from "../../../shared/ui/MoreMenu";
import { usePhoneWidth } from "../../../shared/ui/RecordCards";
import { useLabel } from "../../../i18n";

export function ReportsPage() {
  const { t } = useTranslation(["reports", "common"]);
  const project = useProject();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const { data: list, error } = useLoad(() => api.reports(project.id), [project.id]);
  const { data: catalog } = useLoad(() => api.reportCatalog(project.id), [project.id]);
  const [dialog, setDialog] = useState<"ai" | "template" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const queueMode = useAiTaskMode(project.id);
  const aiUsable = !!catalog?.aiAvailable || queueMode !== "hidden";

  // Deep links: ?new=ai&module=correspondence (module pages' "Rapor"), ?template=<id> (Sor, MCP).
  const moduleParam = search.get("module");
  const scope: ReportModule | undefined = isReportModule(moduleParam) ? moduleParam : undefined;
  const highlight = search.get("template") ?? undefined;
  useEffect(() => {
    if (!catalog) return;
    if (search.get("new") === "ai") setDialog(catalog.aiAvailable || queueMode !== "hidden" ? "ai" : "template");
    else if (search.get("new") === "template" || highlight) setDialog("template");
  }, [catalog, search, highlight, queueMode]);

  const closeDialog = () => {
    setDialog(null);
    if (search.has("new") || search.has("module") || search.has("template")) setSearch(new URLSearchParams(), { replace: true });
  };

  const phone = usePhoneWidth();
  const mine = list?.filter((d) => d.isMine) ?? [];
  const shared = list?.filter((d) => !d.isMine) ?? [];

  async function create(body: Parameters<typeof api.createReport>[1], edit = false) {
    setMsg(null);
    try {
      const d = await api.createReport(project.id, body);
      navigate(`/projects/${project.id}/reports/${d.id}${edit ? "?edit=1" : ""}`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="page">
      <div className="row wrap" style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>{t("list.title")}</h1>
        <div className="spacer" />
        <button
          className="primary"
          disabled={!aiUsable}
          title={catalog && !aiUsable ? t("list.messages.aiNotConfiguredShort") : undefined}
          onClick={() => setDialog("ai")}
        >
          {t("list.actions.createWithAi")}
        </button>
        {phone ? (
          <MoreMenu
            items={[
              { key: "template", label: t("list.actions.fromTemplate") },
              { key: "blank", label: t("list.actions.blank") },
            ]}
            onSelect={(key) => {
              if (key === "template") setDialog("template");
              else if (key === "blank") void create({ name: t("list.defaultName") }, true);
            }}
          />
        ) : (
          <>
            <button onClick={() => setDialog("template")}>{t("list.actions.fromTemplate")}</button>
            <button onClick={() => void create({ name: t("list.defaultName") }, true)}>{t("list.actions.blank")}</button>
          </>
        )}
      </div>
      {catalog && !catalog.aiAvailable && (
        <p className="notice small">
          {queueMode === "hidden"
            ? t("list.messages.aiNotConfigured")
            : t("list.messages.localAiNotConfigured")}
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {msg && <p className="error">{msg}</p>}

      <h2>{t("list.mine.title")}</h2>
      <DashboardCards items={mine} empty={t("list.mine.empty")} />
      <h2 style={{ marginTop: 24 }}>{t("list.shared.title")}</h2>
      <DashboardCards items={shared} empty={t("list.shared.empty")} />
      <p className="muted small" style={{ marginTop: 24 }}>
        {t("list.description")}
      </p>

      {dialog === "template" && catalog && (
        <TemplateDialog
          catalog={catalog}
          focus={scope}
          highlight={highlight}
          onClose={closeDialog}
          onPick={(id) => void create({ templateId: id })}
        />
      )}
      {dialog === "ai" && catalog && (
        <AiCreateDialog catalog={catalog} module={scope} onClose={closeDialog} onPickTemplate={(id) => void create({ templateId: id })} />
      )}
    </div>
  );
}

function DashboardCards({ items, empty }: { items: DashboardSummaryDto[]; empty: string }) {
  const project = useProject();
  const label = useLabel();
  if (!items.length) return <p className="muted">{empty}</p>;
  return (
    <div className="grid-cards">
      {items.map((d) => (
        <Link key={d.id} to={`/projects/${project.id}/reports/${d.id}`} className="card report-card">
          <strong>{d.name}</strong>
          {d.description && <div className="muted small">{d.description}</div>}
          <div className="row wrap small" style={{ marginTop: 8 }}>
            <span className={`badge${d.sharing === "private" ? "" : " info"}`}>{label("reportSharing", d.sharing)}</span>
            {!d.isMine && <span className="muted">{d.ownerName}</span>}
            <span className="muted">{formatDate(d.updatedAt)}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}

/** Templates grouped by module family; the module the user came from first. */
export function groupTemplates(templates: ReportTemplateDto[], focus?: ReportModule): { module: ReportModule | null; items: ReportTemplateDto[] }[] {
  const order = new Map<ReportModule | null, ReportTemplateDto[]>();
  if (focus) order.set(focus, []);
  for (const t of templates) {
    const key = t.module ?? null;
    if (!order.has(key)) order.set(key, []);
    order.get(key)!.push(t);
  }
  const rank = (m: ReportModule | null) => (m === focus ? -1 : m ? REPORT_MODULES.indexOf(m) : REPORT_MODULES.length);
  return [...order.entries()]
    .filter(([, items]) => items.length)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([module, items]) => ({ module, items }));
}

function TemplateDialog({
  catalog,
  focus,
  highlight,
  onClose,
  onPick,
}: {
  catalog: ReportCatalogDto;
  focus?: ReportModule;
  highlight?: string;
  onClose(): void;
  onPick(id: string): void;
}) {
  const { t } = useTranslation(["reports", "common"]);
  const label = useLabel();
  const groups = useMemo(() => groupTemplates(catalog.templates, focus), [catalog.templates, focus]);
  return (
    <Dialog title={t("template.title")} onClose={onClose} wide>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("template.description")}
      </p>
      {groups.map((g) => (
        <section key={g.module ?? "diger"} className="template-group">
          <h3>{g.module ? label("reportModule", g.module) : t("template.other.title")}</h3>
          <div className="grid-cards">
            {g.items.map((tpl) => (
              <div key={tpl.id} className={`card${tpl.id === highlight ? " highlighted" : ""}`}>
                <strong>{tpl.name}</strong>
                <p className="muted small">{tpl.description}</p>
                <button className="primary small" onClick={() => onPick(tpl.id)}>
                  {t("template.actions.use")}
                </button>
              </div>
            ))}
          </div>
        </section>
      ))}
    </Dialog>
  );
}

/** Prompt box with example prompts; used for new dashboards and for edits. */
export function PromptBox({
  examples,
  busy,
  placeholder,
  submitLabel,
  onSubmit,
  actions,
  submitHidden,
}: {
  examples?: string[];
  busy: boolean;
  placeholder: string;
  submitLabel: string;
  onSubmit(prompt: string): void;
  /** Extra buttons next to the submit (e.g. "Yapay Zekâya Gönder"), given the current prompt. */
  actions?: (prompt: string) => ReactNode;
  /** No in-app model: only the extra actions are offered. */
  submitHidden?: boolean;
}) {
  const { t } = useTranslation(["reports", "common"]);
  const [prompt, setPrompt] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (prompt.trim().length >= 3 && !submitHidden) onSubmit(prompt.trim());
      }}
    >
      <textarea
        value={prompt}
        placeholder={placeholder}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && prompt.trim().length >= 3 && !submitHidden) onSubmit(prompt.trim());
        }}
      />
      {examples && (
        <div className="row wrap" style={{ marginTop: 6 }}>
          {examples.map((x) => (
            <button key={x} type="button" className="small chip" onClick={() => setPrompt(x)}>
              {x}
            </button>
          ))}
        </div>
      )}
      <div className="dialog-actions" style={{ marginTop: 8 }}>
        {busy && <span className="muted small">{t("prompt.messages.busy")}</span>}
        {actions?.(prompt.trim())}
        {!submitHidden && (
          <button className="primary" disabled={busy || prompt.trim().length < 3}>
            {submitLabel}
          </button>
        )}
      </div>
    </form>
  );
}

function AiCreateDialog({
  catalog,
  module: initialModule,
  onClose,
  onPickTemplate,
}: {
  catalog: ReportCatalogDto;
  module?: ReportModule;
  onClose(): void;
  onPickTemplate(id: string): void;
}) {
  const { t } = useTranslation(["reports", "common"]);
  const project = useProject();
  const navigate = useNavigate();
  const [module, setModule] = useState<ReportModule | undefined>(initialModule);
  const [result, setResult] = useState<ReportGenerateResult | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const scope = module ? catalog.modules?.find((m) => m.key === module) : undefined;
  const moduleTemplates = module ? catalog.templates.filter((tpl) => tpl.module === module) : [];
  const labels = useMemo(
    () => (result ? reportValueLabels(catalog.datasets, reportQueryDatasets(result.draft.queries)) : undefined),
    [catalog.datasets, result],
  );

  async function generate(prompt: string) {
    setBusy(true);
    setMsg(null);
    setFrameError(null);
    try {
      const r = await api.generateReport(project.id, { prompt, current: result?.draft, module });
      setResult(r);
      setName(r.draft.name);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!result) return;
    try {
      const d = await api.createReport(project.id, { ...result.draft, name: name.trim() || result.draft.name });
      navigate(`/projects/${project.id}/reports/${d.id}`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <Dialog title={t("aiCreate.title")} onClose={onClose} wide>
      {scope && (
        <div className="row wrap small" style={{ marginBottom: 8 }}>
          <span className="badge info">{t("aiCreate.badges.scope", { module: scope.label })}</span>
          <span className="muted">{t("aiCreate.scopeHint")}</span>
          <button type="button" className="small ghost" onClick={() => setModule(undefined)} disabled={busy}>
            {t("aiCreate.actions.removeScope")}
          </button>
        </div>
      )}
      {!result && moduleTemplates.length > 0 && (
        <div className="row wrap small" style={{ marginBottom: 8 }}>
          <span className="muted">{t("aiCreate.templatesHint")}</span>
          {moduleTemplates.map((tpl) => (
            <button key={tpl.id} type="button" className="small" onClick={() => onPickTemplate(tpl.id)} disabled={busy}>
              {tpl.name}
            </button>
          ))}
        </div>
      )}
      {!result && <h3>{t("aiCreate.ask.title")}</h3>}
      {result && (
        <div className="stack">
          <div className="row">
            <input value={name} onChange={(e) => setName(e.target.value)} aria-label={t("aiCreate.nameLabel")} />
            <button className="primary" onClick={() => void save()} disabled={busy}>
              {t("common:actions.save")}
            </button>
          </div>
          {Object.keys(result.errors).length > 0 && <QueryErrors errors={result.errors} />}
          {frameError && <p className="error small">{frameError}</p>}
          <div className="report-stage">
            <ReportFrame
              html={result.draft.html}
              data={result.results}
              errors={result.errors}
              generatedAt={result.generatedAt}
              project={project}
              labels={labels}
              onError={setFrameError}
            />
          </div>
          <h3>{t("aiCreate.refine.title")}</h3>
        </div>
      )}
      <PromptBox
        busy={busy}
        examples={
          result
            ? [t("aiCreate.examples.monthly"), t("aiCreate.examples.excludeClosed"), t("aiCreate.examples.addTable")]
            : (scope?.examples ?? catalog.examplePrompts)
        }
        placeholder={
          result
            ? t("aiCreate.placeholderRefine")
            : scope
              ? t("aiCreate.placeholderScoped", { example: scope.examples[0] ?? t("aiCreate.defaultScopedExample") })
              : t("aiCreate.placeholder")
        }
        submitLabel={result ? t("common:actions.apply") : t("common:actions.create")}
        onSubmit={(p) => void generate(p)}
        submitHidden={!catalog.aiAvailable}
        actions={(p) =>
          !result && (
            <AiTaskButton
              projectId={project.id}
              kind="report_generate"
              input={p.length >= 3 ? { prompt: p, ...(module && { module }) } : null}
              disabled={busy}
              onResult={(r) => {
                // The connected AI client's draft was validated and saved as your private dashboard.
                const link = (r as { link?: string } | null)?.link;
                if (link) navigate(link);
              }}
            />
          )
        }
      />
      {msg && <p className="error">{msg}</p>}
      <p className="muted small">{t("aiCreate.description")}</p>
    </Dialog>
  );
}

export function QueryErrors({ errors }: { errors: Record<string, string> }) {
  return (
    <div className="notice small">
      {Object.entries(errors).map(([id, m]) => (
        <div key={id}>
          <strong>{id}:</strong> {m}
        </div>
      ))}
    </div>
  );
}
