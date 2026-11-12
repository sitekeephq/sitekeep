import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { type IssueDto, type IssuePriority, type ModelSetDto, type VersionCompareDto } from "@sitekeep/shared";
import { ViewerEngine, type SelectedItem } from "@7dimensions-project/bim-viewer";
import { PropertiesPanel, ViewerToolsHud, useViewerTools } from "@7dimensions-project/bim-viewer/react";
import { isToolMoreKey, toolMoreItems } from "@7dimensions-project/bim-viewer/tools";
import "@7dimensions-project/bim-viewer/tools.css";
import { ApiError, api, formatDate, type ModelVersion } from "../../../shared/api/api";
import { viewerAboutText } from "../../../shared/lib/about";
import { BrandMark } from "../../../shared/ui/BrandMark";
import { CompareDialog, ComparePanel } from "../../documents/components/ComparePanel";
import { ModelAskPanel } from "../components/ModelAsk";
import { publishModelAskVisibility } from "../../../shared/ai/panel-coordination";
import { useLoad, useProject } from "../../../app/context/project";
import { Dialog } from "../../../shared/ui/Dialog";
import { ModelSetPanel, SaveViewDialog } from "../components/CoordinationViewer";
import { webCapability, type ViewerClash } from "../../../sdk";
import { MoreMenu } from "../../../shared/ui/MoreMenu";
import { viewerMoreItems } from "../../../viewers/viewer-phone";
import { labelEntries, useLabel } from "../../../i18n";

const PIN_COLORS: Record<string, string> = {
  open: "#d92d20",
  in_progress: "#f79009",
  in_review: "#2e90fa",
  closed: "#12b76a",
};

/** Issue type values as stored on the issue (Turkish, like existing data); labels: `newIssue.types.<key>`. */
const ISSUE_TYPES: { value: string; key: "coordination" | "design" | "site" | "quality" | "ohs" | "other" }[] = [
  { value: "Koordinasyon", key: "coordination" },
  { value: "Tasarım", key: "design" }, // i18n-ok
  { value: "Saha", key: "site" },
  { value: "Kalite", key: "quality" },
  { value: "İSG", key: "ohs" }, // i18n-ok
  { value: "Diğer", key: "other" }, // i18n-ok
];

export function ViewerPage() {
  const { t } = useTranslation(["coordination", "common"]);
  const label = useLabel();
  const project = useProject();
  const [params, setParams] = useSearchParams();
  const requested = useMemo(() => (params.get("v") ?? "").split(",").filter(Boolean), [params]);
  const issueParam = params.get("issue");
  const vpParam = params.get("vp");
  // ?select=<GlobalId,…>: highlight these elements once the requested models are loaded.
  const selectParam = params.get("select");
  const appliedSelect = useRef<string | null>(null);
  // 4D is the Planning module's; without it there is no 4D bar.
  const planningFourD = webCapability("planning.fourD");
  const [fourD, setFourD] = useState(!!planningFourD && params.get("takvim") === "1");
  const container = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<ViewerEngine | null>(null);
  const [loaded, setLoaded] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedItem | null>(null);
  const [creating, setCreating] = useState<{ pin: IssueDto["pin"]; title?: string; description?: string } | null>(null);
  // "Modele sor" (?sor=1 opens it).
  const [askOpen, setAskOpen] = useState(params.get("sor") === "1");
  const [askVersion, setAskVersion] = useState<string | null>(null);
  useEffect(() => publishModelAskVisibility(askOpen), [askOpen]);
  useEffect(() => () => publishModelAskVisibility(false), []);
  const { data: models } = useLoad(() => api.models(project.id), [project.id]);
  const { data: issues, reload: reloadIssues } = useLoad(() => api.issues(project.id), [project.id]);
  // Version comparison ("Karşılaştır"): ?cmp=<old>,<new>, &ghost=1 also loads the old version.
  const [cmpFrom, cmpTo] = (params.get("cmp") ?? "").split(",");
  const comparing = !!cmpFrom && !!cmpTo;
  const ghost = comparing && params.get("ghost") === "1";
  const [fade, setFade] = useState(true);
  const [cmpResult, setCmpResult] = useState<VersionCompareDto | null>(null);
  const [cmpStatus, setCmpStatus] = useState<string | null>(null);
  const [comparePick, setComparePick] = useState<ModelVersion[] | null>(null);
  const { data: allVersions } = useLoad(() => api.modelVersions(project.id), [project.id]);
  // Model coordination: ?set=<model set>[&view=<saved view>] and ?clash=<clash id>&ct=<clash test>.
  const setParam = params.get("set");
  const viewParam = params.get("view");
  const clashParam = params.get("clash");
  const ctParam = params.get("ct");
  const coordMode = !!setParam || !!clashParam;
  const [modelSet, setModelSet] = useState<ModelSetDto | null>(null);
  const [savingView, setSavingView] = useState(false);
  // Clash mode is the Coordinate module's; without it ?clash= is ignored.
  const viewerClash = webCapability("coordinate.viewerClash");
  const [clash, setClash] = useState<ViewerClash | null>(null);
  const [clashTick, setClashTick] = useState(0);
  const [isolated, setIsolated] = useState(true);
  const appliedView = useRef<string | null>(null);
  // Narrow screens (≤ 900px, CSS) hide the left panel; "Modeller" opens it as a bottom sheet.
  const [modelsOpen, setModelsOpen] = useState(false);
  // Navigation modes, sections, measurements, visibility, view cube (components/viewer-tools).
  const viewerTools = useViewerTools(engine, {
    loaded,
    onFit: () => void engine?.fit(),
    storeyLoader: async (versionId) => {
      const vocab = await api.modelVocab(project.id, versionId);
      return vocab.storeys.map((s) => ({ name: s.name, elevation: s.elevation, count: s.count }));
    },
  });

  useEffect(() => {
    let disposed = false;
    let instance: ViewerEngine | null = null;
    ViewerEngine.create(container.current!).then(
      (e) => {
        if (disposed) return e.dispose();
        instance = e;
        e.onSelect = setSelected;
        setEngine(e);
      },
      (err: Error) => setError(t("viewer.errors.init", { error: err.message })),
    );
    return () => {
      disposed = true;
      instance?.dispose();
    };
  }, []);

  // Keep loaded models in sync with ?v=
  useEffect(() => {
    if (!engine) return;
    void (async () => {
      for (const id of engine.loadedIds) if (!requested.includes(id)) await engine.unload(id);
      let first = engine.loadedIds.length === 0;
      for (const id of requested) {
        if (engine.loadedIds.includes(id)) continue;
        setBusy(t("viewer.status.loadingModel"));
        try {
          await engine.load(id, api.modelUrl(project.id, id));
          if (coordMode) await engine.align(id);
          if (first) {
            await engine.fit();
            first = false;
          }
        } catch (e) {
          setError((e as Error).message);
        }
      }
      setBusy(null);
      setLoaded([...engine.loadedIds]);
    })();
  }, [engine, requested, project.id, coordMode]);

  // Model set: load it, then open its models (minus the ones the selected view switches off).
  useEffect(() => {
    setModelSet(null);
    appliedView.current = null;
    if (!setParam) return;
    api.modelSet(project.id, setParam).then(setModelSet, (e: Error) => setError(e.message));
  }, [setParam, project.id]);

  useEffect(() => {
    if (!modelSet) return;
    const view = modelSet.views.find((v) => v.id === viewParam);
    const ids = modelSet.items
      .filter((i) => i.resolvedVersionId && i.derivativeStatus === "ready" && !view?.state.hiddenFileIds.includes(i.fileId))
      .map((i) => i.resolvedVersionId!);
    setParams((p) => {
      if (ids.length) p.set("v", ids.join(","));
      else p.delete("v");
      return p;
    });
    appliedView.current = null;
  }, [modelSet, viewParam, setParams]);

  const modelFiles = useMemo(() => {
    const out: Record<string, string> = {};
    for (const i of modelSet?.items ?? []) if (i.resolvedVersionId) out[i.resolvedVersionId] = i.fileId;
    return out;
  }, [modelSet]);

  // Apply the selected view (camera + class rules) once its models are loaded.
  useEffect(() => {
    if (!engine || !modelSet) return;
    const view = modelSet.views.find((v) => v.id === viewParam);
    const key = `${viewParam ?? ""}|${loaded.join(",")}`;
    if (!requested.every((id) => loaded.includes(id)) || appliedView.current === key) return;
    appliedView.current = key;
    void (async () => {
      if (!view) return engine.clearRules();
      await engine.applyExtras(view.state);
      await engine.setCamera(view.state.camera);
      await engine.applyRules(view.state.rules, modelFiles);
    })().catch((e: Error) => setError(t("viewer.errors.view", { error: e.message })));
  }, [engine, modelSet, viewParam, loaded, requested, modelFiles]);

  // Clash: load both versions, isolate and colour the pair.
  useEffect(() => {
    setClash(null);
    if (!clashParam || !ctParam || !viewerClash) return;
    viewerClash.load(project.id, ctParam, clashParam).then(
      (c) => {
        setClash(c);
        const ids = [...new Set([c.a.versionId, c.b.versionId])];
        setParams((p) => {
          if ((p.get("v") ?? "") !== ids.join(",")) p.set("v", ids.join(","));
          return p;
        });
      },
      (e: Error) => setError(e.message),
    );
  }, [clashParam, ctParam, project.id, clashTick, setParams]);

  useEffect(() => {
    if (!engine) return;
    if (!clash) {
      void engine.clearClash();
      return;
    }
    if (!loaded.includes(clash.a.versionId) || !loaded.includes(clash.b.versionId)) return;
    engine
      .showClash({
        a: { modelId: clash.a.versionId, globalId: clash.a.globalId },
        b: { modelId: clash.b.versionId, globalId: clash.b.globalId },
        point: clash.point,
        isolate: isolated,
      })
      .then((ok) => !ok && setError(t("viewer.errors.clashElementMissing")))
      .catch((e: Error) => setError(t("viewer.errors.clash", { error: e.message })));
  }, [engine, clash, loaded, isolated]);

  function closeCoordination(keys: string[]) {
    setParams((p) => {
      for (const k of keys) p.delete(k);
      return p;
    });
  }

  // Pins of issues that belong to the loaded models.
  useEffect(() => {
    if (!engine || !issues) return;
    engine.setPins(
      issues
        .filter((i) => i.pin && (!i.pin.fileVersionId || loaded.includes(i.pin.fileVersionId) || i.viewpoint?.fileVersionIds.some((v) => loaded.includes(v))))
        .map((i) => ({ position: i.pin!.position, color: PIN_COLORS[i.status] ?? "#888" })),
    );
  }, [engine, issues, loaded]);

  // Open an issue's viewpoint from ?issue= (&vp=<GUID> picks one of its further BCF viewpoints).
  useEffect(() => {
    if (!engine || !issueParam) return;
    void (async () => {
      const list = vpParam ? await api.issueViewpoints(project.id, issueParam) : null;
      const vp = list?.find((v) => v.guid === vpParam)?.viewpoint ?? (await api.issue(project.id, issueParam)).viewpoint;
      if (!vp) return;
      const missing = vp.fileVersionIds.filter((v) => !requested.includes(v));
      if (missing.length) {
        setParams((p) => {
          p.set("v", [...requested, ...missing].join(","));
          return p;
        });
        return;
      }
      if (vp.fileVersionIds.every((v) => loaded.includes(v))) await engine.applyViewpoint(vp);
    })().catch((e: Error) => setError(t("viewer.errors.view", { error: e.message })));
  }, [engine, issueParam, vpParam, loaded, project.id, requested, setParams]);

  useEffect(() => {
    if (!engine || !selectParam || appliedSelect.current === selectParam) return;
    if (!requested.length || !requested.every((v) => loaded.includes(v))) return;
    appliedSelect.current = selectParam;
    const guids = selectParam.split(",").map((g) => g.trim()).filter(Boolean);
    void engine.selectGuids(guids).then((n) => {
      if (!n) setError(t("viewer.errors.selectMissing"));
    });
  }, [engine, selectParam, loaded, requested]);

  // Fetch the comparison; while the server builds a missing index (409) poll every few seconds.
  useEffect(() => {
    setCmpResult(null);
    setCmpStatus(null);
    if (!comparing) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      setCmpStatus((s) => s ?? t("viewer.status.comparing"));
      api.compare(project.id, cmpFrom!, cmpTo!).then(
        (r) => {
          if (!alive) return;
          setCmpResult(r);
          setCmpStatus(null);
          if (r.upgrading) timer = setTimeout(run, 5000);
        },
        (e: Error) => {
          if (!alive) return;
          if (e instanceof ApiError && e.status === 409) {
            setCmpStatus(e.message);
            timer = setTimeout(run, 3000);
          } else setCmpStatus(e.message);
        },
      );
    };
    run();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [comparing, cmpFrom, cmpTo, project.id]);

  // Colour the models once the comparison and the models are there.
  useEffect(() => {
    if (!engine) return;
    if (!cmpResult || !loaded.includes(cmpTo!)) {
      void engine.clearComparison();
      return;
    }
    engine.showComparison({
      newModelId: cmpTo!,
      added: cmpResult.added,
      changed: cmpResult.changed,
      fadeUnchanged: fade,
      oldModelId: ghost && loaded.includes(cmpFrom!) ? cmpFrom : null,
      removed: cmpResult.removed,
    }).catch((e: Error) => setError(t("viewer.errors.compareColours", { error: e.message })));
  }, [engine, cmpResult, loaded, ghost, fade, cmpFrom, cmpTo]);

  function startCompare(from: string, to: string) {
    setComparePick(null);
    setParams((p) => {
      p.set("cmp", `${from},${to}`);
      p.set("v", to);
      p.delete("ghost");
      p.delete("issue");
      return p;
    });
  }

  function setGhost(on: boolean) {
    setParams((p) => {
      const v = (p.get("v") ?? "").split(",").filter((x) => x && x !== cmpFrom);
      if (on) {
        p.set("ghost", "1");
        v.push(cmpFrom!);
      } else p.delete("ghost");
      p.set("v", v.join(","));
      return p;
    });
  }

  function closeCompare() {
    setParams((p) => {
      p.delete("cmp");
      if (ghost) {
        const v = (p.get("v") ?? "").split(",").filter((x) => x && x !== cmpFrom);
        if (v.length) p.set("v", v.join(","));
        else p.delete("v");
      }
      p.delete("ghost");
      return p;
    });
  }

  function toggleModel(id: string, on: boolean) {
    const next = on ? [...requested, id] : requested.filter((x) => x !== id);
    setParams((p) => {
      if (next.length) p.set("v", next.join(","));
      else p.delete("v");
      return p;
    });
  }

  async function newIssue(withPin: boolean) {
    if (!engine) return;
    let pin: IssueDto["pin"] = null;
    if (withPin) {
      setBusy(t("viewer.status.pickPin"));
      const onEsc = (e: KeyboardEvent) => e.key === "Escape" && engine.cancelPick();
      window.addEventListener("keydown", onEsc);
      const hit = await engine.pickPoint();
      window.removeEventListener("keydown", onEsc);
      setBusy(null);
      if (!hit) return;
      pin = { position: hit.point, fileVersionId: hit.modelId, globalId: hit.globalId ?? undefined };
    }
    setCreating({ pin });
  }

  /** Issue for model elements: they are selected first so the viewpoint carries them. */
  async function issueFor(guids: string[], title: string, description: string) {
    if (engine && guids.length) await engine.selectGuids(guids, false);
    setCreating({ pin: null, title, description });
  }

  const versionLabel = (id: string) => {
    const m = allVersions?.find((v) => v.id === id) ?? models?.find((v) => v.id === id);
    return m ? `${m.fileName} · V${m.version}` : id.slice(0, 8);
  };
  const askTarget =
    askVersion === "all" && loaded.length > 1
      ? "all"
      : askVersion && loaded.includes(askVersion)
        ? askVersion
        : loaded.length > 1 && !comparing
          ? "all"
          : (loaded.find((id) => id !== cmpFrom) ?? loaded[0] ?? null);
  const showAsk = askOpen && !!askTarget;
  const rightOpen = !!(selected || comparing || clash || showAsk);

  const byFolder = groupBy(models ?? [], (m) => m.folderPath);

  const versionsByFile = groupBy(allVersions ?? [], (m) => m.fileId);

  return (
    <div className={`viewer model-viewer${rightOpen ? "" : " no-right"}${showAsk || comparing ? " right-on-phone" : ""}`}>
      {modelsOpen && <div className="viewer-sheet-backdrop" onClick={() => setModelsOpen(false)} />}
      <aside className={`panel left${modelsOpen ? " sheet-open" : ""}`} aria-label={t("viewer.models")} data-tour="viewer-models">
        <div className="viewer-sheet-head">
          <strong>{t("viewer.models")}</strong>
          <span className="muted small">{requested.length ? t("viewer.selectedCount", { n: requested.length }) : t("viewer.selectHint")}</span>
          <div className="spacer" />
          <button className="primary small" onClick={() => setModelsOpen(false)}>
            {t("common:actions.ok")}
          </button>
        </div>
        {modelSet && (
          <ModelSetPanel
            projectId={project.id}
            set={modelSet}
            viewId={viewParam}
            onView={(id) =>
              setParams((p) => {
                if (id) p.set("view", id);
                else p.delete("view");
                return p;
              })
            }
            onSave={() => setSavingView(true)}
            onClose={() => {
              void engine?.clearRules();
              closeCoordination(["set", "view"]);
            }}
          />
        )}
        <h3 className="viewer-models-title">{t("viewer.models")}</h3>
        {models?.length === 0 && <p className="muted small">{t("viewer.noModels")}</p>}
        {Object.entries(byFolder).map(([folder, list]) => (
          <div key={folder} style={{ marginBottom: 10 }}>
            <div className="muted small" style={{ marginBottom: 2 }}>{folder}</div>
            {list.map((m) => (
              <ModelRow
                key={m.id}
                model={m}
                checked={requested.includes(m.id)}
                onToggle={(on) => toggleModel(m.id, on)}
                onCompare={(versionsByFile[m.fileId]?.length ?? 0) > 1 ? () => setComparePick(versionsByFile[m.fileId]!) : undefined}
              />
            ))}
          </div>
        ))}
        <h3 style={{ marginTop: 16 }}>{t("viewer.issues")}</h3>
        {issues
          ?.filter((i) => i.viewpoint)
          .slice(0, 30)
          .map((i) => (
            <div
              key={i.id}
              className="model-item"
              style={{ cursor: "pointer" }}
              onClick={() => {
                setModelsOpen(false);
                setParams((p) => {
                  p.set("issue", i.id);
                  return p;
                });
              }}
            >
              <span style={{ width: 10, height: 10, borderRadius: 5, background: PIN_COLORS[i.status], marginTop: 4, flexShrink: 0 }} />
              <div className="small">
                <strong>#{i.number}</strong> {i.title}
                <div className="muted">{label("issueStatus", i.status)}</div>
              </div>
            </div>
          ))}
      </aside>
      <div className="canvas-wrap">
        <div ref={container} className="viewer-container" />
        <div className="viewer-hud" data-tour="viewer-hud">
          <button className="viewer-models-btn primary" data-tour="viewer-models" onClick={() => setModelsOpen(true)} aria-haspopup="dialog">
            {requested.length ? t("viewer.actions.modelsCount", { n: requested.length }) : t("viewer.actions.models")}
          </button>
          <button onClick={() => void engine?.fit()} disabled={!loaded.length}>{t("viewer.actions.fit")}</button>
          <button className="wide-tool" onClick={() => void newIssue(true)} disabled={!loaded.length}>{t("viewer.actions.pinIssue")}</button>
          <button className="wide-tool" onClick={() => void newIssue(false)} disabled={!loaded.length}>{t("viewer.actions.viewIssue")}</button>
          {planningFourD && (
            <button className={`wide-tool${fourD ? " primary" : ""}`} onClick={() => setFourD((v) => !v)} disabled={!loaded.length} title={t("viewer.fourDHint")}>
              {t("viewer.actions.fourD")}
            </button>
          )}
          <button className={askOpen ? "primary" : ""} onClick={() => setAskOpen((v) => !v)} disabled={!loaded.length} title={t("viewer.askHint")}>
            {t("viewer.actions.ask")}
          </button>
          <div className="phone-tool">
            <MoreMenu
              items={[...viewerMoreItems(loaded.length > 0, fourD).filter((i) => i.key !== "four_d" || planningFourD), ...(loaded.length ? toolMoreItems(viewerTools.state) : [])]}
              onSelect={(key) => {
                if (isToolMoreKey(key)) viewerTools.command(key);
                else if (key === "pin_issue") void newIssue(true);
                else if (key === "view_issue") void newIssue(false);
                else setFourD((v) => !v);
              }}
            />
          </div>
        </div>
        {(busy || error) && (
          <div className="viewer-status" style={error ? { color: "var(--danger)" } : undefined}>
            {error ?? busy}
            {error && (
              <button className="ghost small" onClick={() => setError(null)}>✕</button>
            )}
          </div>
        )}
        <ViewerToolsHud
          tools={viewerTools.tools}
          state={viewerTools.state}
          panel={viewerTools.panel}
          setPanel={viewerTools.setPanel}
          loaded={loaded.length > 0}
          branding={<BrandMark size={22} />}
          aboutText={viewerAboutText()}
        />
        {fourD && planningFourD && engine && loaded.length > 0 && (
          <planningFourD.FourDPanel engine={engine} loaded={loaded} hasSelection={!!selected} selected={selected} onClose={() => setFourD(false)} />
        )}
        {!loaded.length && !busy && (
          <div className="muted viewer-empty">
            <span className="wide-only">{t("viewer.emptyWide")}</span>
            <span className="narrow-only">{t("viewer.emptyNarrow")}</span>
          </div>
        )}
      </div>
      {rightOpen && (
        <aside className="panel right">
          {showAsk && askTarget && (
            <ModelAskPanel
              projectId={project.id}
              engine={engine}
              versionId={askTarget}
              versions={loaded.map((id) => ({ id, label: versionLabel(id) }))}
              onVersion={setAskVersion}
              onIssue={(g, title, d) => void issueFor(g, title, d)}
              onClose={() => setAskOpen(false)}
            />
          )}
          {clash && viewerClash && (
            <viewerClash.ClashPanel
              projectId={project.id}
              clash={clash}
              engine={engine}
              isolated={isolated}
              onIsolate={(on) => {
                setIsolated(on);
                if (!on) void engine?.showAll();
              }}
              onChanged={() => setClashTick((n) => n + 1)}
              onClose={() => closeCoordination(["clash", "ct"])}
            />
          )}
          {comparing && (
            <ComparePanel
              projectId={project.id}
              engine={engine}
              onIssue={(g, title, d) => void issueFor(g, title, d)}
              result={cmpResult}
              status={cmpStatus}
              ghost={ghost}
              fade={fade}
              onGhost={setGhost}
              onFade={setFade}
              onClose={closeCompare}
              onFocus={(guid, kind) => void engine?.focusGuid(guid, kind === "removed" ? [cmpFrom!] : [cmpTo!])}
            />
          )}
          {selected && <PropertiesPanel selected={selected} classLabel={viewerClassLabel} onClose={() => void engine?.highlighter.clear("select")} />}
        </aside>
      )}
      {savingView && modelSet && engine && (
        <SaveViewDialog
          projectId={project.id}
          set={modelSet}
          engine={engine}
          loadedFileIds={loaded.map((id) => modelFiles[id]).filter((x): x is string => !!x)}
          initialRules={modelSet.views.find((v) => v.id === viewParam)?.state.rules ?? []}
          modelFiles={modelFiles}
          onClose={() => setSavingView(false)}
          onSaved={(vid) => {
            setSavingView(false);
            void api.modelSet(project.id, modelSet.id).then((s) => {
              setModelSet(s);
              setParams((p) => {
                p.set("view", vid);
                return p;
              });
            });
          }}
        />
      )}
      {comparePick && <CompareDialog versions={comparePick} onClose={() => setComparePick(null)} onStart={startCompare} />}
      {creating && engine && (
        <NewIssueDialog
          engine={engine}
          pin={creating.pin}
          initialTitle={creating.title}
          initialDescription={creating.description}
          onClose={() => setCreating(null)}
          onCreated={reloadIssues}
        />
      )}
    </div>
  );
}

function ModelRow({
  model,
  checked,
  onToggle,
  onCompare,
}: {
  model: ModelVersion;
  checked: boolean;
  onToggle(on: boolean): void;
  onCompare?: () => void;
}) {
  const { t } = useTranslation(["coordination", "common"]);
  return (
    <label className="model-item" style={{ margin: 0, color: "inherit", fontSize: 13 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} disabled={model.derivativeStatus !== "ready"} />
      <div>
        <div style={{ wordBreak: "break-all" }}>{model.fileName}</div>
        <div className="muted small">
          V{model.version} · {formatDate(model.uploadedAt)}
          {model.derivativeStatus !== "ready" && <span className="badge warn" style={{ marginLeft: 4 }}>{model.derivativeStatus}</span>}
        </div>
      </div>
      {onCompare && (
        <button
          className="ghost small"
          style={{ marginLeft: "auto" }}
          title={t("viewer.compareHint")}
          onClick={(e) => {
            e.preventDefault();
            onCompare();
          }}
        >
          ⇄
        </button>
      )}
    </label>
  );
}

function NewIssueDialog({
  engine,
  pin,
  initialTitle,
  initialDescription,
  onClose,
  onCreated,
}: {
  engine: ViewerEngine;
  pin: IssueDto["pin"];
  initialTitle?: string;
  initialDescription?: string;
  onClose(): void;
  onCreated(): void;
}) {
  const { t } = useTranslation(["coordination", "common"]);
  const label = useLabel();
  const project = useProject();
  const { data: members } = useLoad(() => api.members(project.id), [project.id]);
  const [title, setTitle] = useState(initialTitle ?? "");
  const [description, setDescription] = useState(initialDescription ?? "");
  const [priority, setPriority] = useState<IssuePriority>("normal");
  const [assignee, setAssignee] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [type, setType] = useState(ISSUE_TYPES[0]!.value);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<IssueDto | null>(null);
  const vp = useRef<Awaited<ReturnType<ViewerEngine["viewpoint"]>> | null>(null);

  useEffect(() => {
    void engine.viewpoint().then((v) => {
      vp.current = v;
      setSnapshot(v.snapshot ?? null);
    });
  }, [engine]);

  async function submit() {
    setError(null);
    try {
      const issue = await api.createIssue(project.id, {
        title,
        description: description || null,
        priority,
        type,
        assigneeUserId: assignee || null,
        dueDate: dueDate || null,
        viewpoint: vp.current,
        pin,
      });
      setCreated(issue);
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Dialog title={t("newIssue.title")} onClose={onClose} wide>
      {created ? (
        <>
          <p className="success">
            {t("newIssue.created", { number: created.number })} <Link to={`/projects/${project.id}/issues/${created.id}`}>{t("common:actions.open")}</Link>
          </p>
          <div className="dialog-actions">
            <button className="primary" onClick={onClose}>{t("common:actions.close")}</button>
          </div>
        </>
      ) : (
        <div className="issue-dialog-grid">
          <div>
            <label>{t("common:fields.title")}</label>
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
            <label>{t("common:fields.description")}</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
            <div className="row">
              <div style={{ flex: 1 }}>
                <label>{t("common:fields.type")}</label>
                <select value={type} onChange={(e) => setType(e.target.value)}>
                  {ISSUE_TYPES.map((x) => (
                    <option key={x.value} value={x.value}>
                      {t(`newIssue.types.${x.key}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label>{t("common:fields.priority")}</label>
                <select value={priority} onChange={(e) => setPriority(e.target.value as IssuePriority)}>
                  {(["low", "normal", "high", "critical"] as IssuePriority[]).map((p) => (
                    <option key={p} value={p}>
                      {label("issuePriority", p)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="row">
              <div style={{ flex: 1 }}>
                <label>{t("common:fields.assignee")}</label>
                <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                  <option value="">—</option>
                  {members?.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name} {m.companyName ? `(${m.companyName})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label>{t("common:fields.dueDate")}</label>
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </div>
            </div>
          </div>
          <div>
            <label>{t("newIssue.viewpoint")}</label>
            {snapshot ? (
              <img src={snapshot} alt={t("newIssue.viewpoint")} style={{ width: "100%", borderRadius: 6, border: "1px solid var(--border)" }} />
            ) : (
              <div className="muted small">{t("newIssue.capturing")}</div>
            )}
            <p className="muted small">
              {vp.current?.selection?.length ? t("newIssue.savedWithSelection", { n: vp.current.selection.length }) : t("newIssue.saved")}
              {pin && ` ${t("newIssue.pinAdded")}`}
              {vp.current?.sections && ` ${t("newIssue.sectionsSaved")}`}
              {vp.current?.measurements?.length ? ` ${t("newIssue.measurementsSaved", { n: vp.current.measurements.length })}` : ""}
            </p>
          </div>
          {error && <p className="error" style={{ gridColumn: "1 / -1" }}>{error}</p>}
          <div className="dialog-actions" style={{ gridColumn: "1 / -1" }}>
            <button onClick={onClose}>{t("common:actions.cancel")}</button>
            <button className="primary" disabled={!title.trim()} onClick={() => void submit()}>
              {t("common:actions.create")}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function groupBy<T>(list: T[], key: (t: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of list) (out[key(item)] ??= []).push(item);
  return out;
}

function viewerClassLabel(category: string): string {
  const cls = category.replace(/(standardcase|elementedcase)$/i, "");
  const hit = labelEntries("ifcClass").find(([k]) => k.toLowerCase() === cls.toLowerCase());
  const text = hit ? hit[1] : cls.replace(/^Ifc/i, "");
  return text === text.toUpperCase() ? text.charAt(0) + text.slice(1).toLowerCase() : text;
}
