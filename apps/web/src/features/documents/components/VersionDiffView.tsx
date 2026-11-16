/**
 * DWG / IFC version comparison (FP-1, docs/features/DOCUMENT_COMPARISON.md): totals, the summary
 * per layer (DWG) or per class and storey (IFC), the filtered list of differences, the CSV / Excel
 * export and the links into the viewers. IFC elements are coloured in the 3D viewer's comparison
 * (added green, changed orange, removed red); the CAD viewer cannot highlight single entities, so a
 * drawing links to the layer shown on its own.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  CAD_CHANGE_ASPECTS,
  MODEL_CHANGE_CATEGORIES,
  ifcClassLabel,
  viewerPath,
  type DocCompareDto,
  type VersionDiffChange,
  type VersionDiffFilter,
  type VersionDiffKind,
  type VersionDiffPageDto,
  type VersionDiffRow,
} from "@sitekeep/shared";
import { i18n } from "../../../i18n";
import { api } from "../../../shared/api/api";
import { useProject } from "../../../app/context/project";

const PAGE = 100;
/** "Every layer / class / storey" in the selects ("" is a real value: no storey). */
const ALL = "__all__";
const KINDS: VersionDiffKind[] = ["added", "removed", "changed"];

/** 3D viewer with the comparison colours; `select` picks one element (removed ones are in the old model). */
export function modelCompareUrl(projectId: string, from: string, to: string, select?: { guid: string; removed: boolean }): string {
  const qs = new URLSearchParams({ v: select?.removed ? `${to},${from}` : to, cmp: `${from},${to}` });
  if (select?.removed) qs.set("ghost", "1");
  if (select) qs.set("select", select.guid);
  return `/projects/${projectId}/viewer?${qs}`;
}

export function VersionDiffView({ dto }: { dto: DocCompareDto }) {
  const { t } = useTranslation(["documents", "common"]);
  const project = useProject();
  const tx: Tx = (key, options) => String(t(key as never, options as never));
  const result = dto.result;
  const cad = result?.cad ?? null;
  const model = result?.model ?? null;
  const [filter, setFilter] = useState<VersionDiffFilter>({});
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<VersionDiffPageDto | null>(null);
  const [rows, setRows] = useState<VersionDiffRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const done = dto.status === "done" && !!result && (!!cad || !!model);

  // The search box filters after a short pause.
  useEffect(() => {
    const timer = setTimeout(() => setFilter((f) => ({ ...f, q: query.trim() || undefined })), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!done) return;
    let alive = true;
    setLoading(true);
    setError(null);
    api.versionDifferences(project.id, dto.id, filter, 0, PAGE).then(
      (p) => {
        if (!alive) return;
        setPage(p);
        setRows(p.rows);
        setLoading(false);
      },
      (e: Error) => {
        if (!alive) return;
        setError(e.message);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [project.id, dto.id, done, filter]);

  const more = async () => {
    if (!page) return;
    setLoading(true);
    try {
      const next = await api.versionDifferences(project.id, dto.id, filter, rows.length, PAGE);
      setPage(next);
      setRows((list) => [...list, ...next.rows]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const groups = useMemo(() => {
    if (cad) return cad.layers.filter((l) => l.status !== "same").map((l) => ({ value: l.layer, label: l.layer }));
    if (model)
      return Object.entries(model.byClass)
        .filter(([, n]) => n.added + n.removed + n.changed > 0)
        .map(([cls]) => ({ value: cls, label: ifcClassLabel(cls, i18n.language) }))
        .sort((a, b) => a.label.localeCompare(b.label, i18n.language));
    return [];
  }, [cad, model]);
  const subgroups = useMemo(() => {
    if (cad) return [...new Set(cad.layers.flatMap((l) => Object.keys(l.types)))].sort().map((x) => ({ value: x, label: x }));
    if (model)
      return Object.keys(model.byStorey)
        .sort((a, b) => a.localeCompare(b, i18n.language))
        .map((s) => ({ value: s, label: s || t("versionDiff.noStorey") }));
    return [];
  }, [cad, model, t]);

  if (dto.status === "running") return <p className="muted" style={{ margin: 16 }}><span className="spin" /> {t("versionDiff.running")}</p>;
  if (dto.status === "failed") return <p className="error" style={{ margin: 16 }}>{t("versionDiff.failed", { error: dto.error ?? "" })}</p>;
  if (!done) return null;

  const counts = cad ?? model!;
  const aspects = cad ? CAD_CHANGE_ASPECTS : MODEL_CHANGE_CATEGORIES;
  const aspectLabel = (a: string) => (cad ? t(`versionDiff.aspects.${a}` as never) : t(`versionDiff.categories.${a}` as never)) as string;
  const set = (patch: Partial<VersionDiffFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const groupLabel = (value: string) => (model ? ifcClassLabel(value, i18n.language) : value);
  const openLayer = (layer: string) => `${viewerPath(project.id, dto.to.fileName, dto.to.versionId)}?layer=${encodeURIComponent(layer)}`;

  return (
    <div className="vdiff">
      <div className="vdiff-kpis">
        <Kpi kind="added" value={counts.added} label={t("versionDiff.kinds.added")} onClick={() => set({ kind: "added" })} />
        <Kpi kind="removed" value={counts.removed} label={t("versionDiff.kinds.removed")} onClick={() => set({ kind: "removed" })} />
        <Kpi kind="changed" value={counts.changed} label={t("versionDiff.kinds.changed")} onClick={() => set({ kind: "changed" })} />
        <Kpi value={counts.unchanged} label={t("versionDiff.kinds.unchanged")} />
        <div className="spacer" />
        {model && (
          <Link className="btn small" to={modelCompareUrl(project.id, dto.from.versionId, dto.to.versionId)} title={t("versionDiff.model.openHint")}>
            {t("versionDiff.model.open")}
          </Link>
        )}
        {cad && (
          <Link className="btn small" to={viewerPath(project.id, dto.to.fileName, dto.to.versionId)}>
            {t("versionDiff.cad.open")}
          </Link>
        )}
      </div>
      {cad?.matchedBy === "geometry" && <p className="notice small">{t("versionDiff.cad.matchedByGeometry")}</p>}
      {cad && <p className="muted small">{t("versionDiff.cad.highlightNote")}</p>}
      {model && !model.geometry && <p className="notice small">{t("versionDiff.model.noGeometry")}</p>}
      {model && !model.detailed && <p className="notice small">{t("versionDiff.model.notDetailed")}</p>}
      {cad?.truncated && <p className="notice small">{t("versionDiff.truncated")}</p>}

      {cad && (
        <>
          <h3>{t("versionDiff.cad.layersHeading")}</h3>
          <div className="table-scroll">
            <table className="props-table small vdiff-table">
              <thead>
                <tr>
                  <th>{t("versionDiff.columns.layer")}</th>
                  <th>{t("versionDiff.columns.entities")}</th>
                  <th>{t("versionDiff.kinds.added")}</th>
                  <th>{t("versionDiff.kinds.removed")}</th>
                  <th>{t("versionDiff.kinds.changed")}</th>
                  <th>{t("versionDiff.columns.types")}</th>
                  <th>{t("versionDiff.columns.layerProps")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {cad.layers.map((l) => (
                  <tr key={l.layer} className={filter.group === l.layer ? "active" : undefined}>
                    <td>
                      <a href="#" onClick={(e) => (e.preventDefault(), set({ group: filter.group === l.layer ? undefined : l.layer }))}>{l.layer}</a>{" "}
                      {l.status !== "same" && <span className={`badge diff-${l.status}`}>{t(`versionDiff.status.${l.status}` as never)}</span>}
                    </td>
                    <td>{l.entitiesA === l.entitiesB ? l.entitiesB : `${l.entitiesA} → ${l.entitiesB}`}</td>
                    <td>{l.added || ""}</td>
                    <td>{l.removed || ""}</td>
                    <td>{l.changed || ""}</td>
                    <td className="muted">
                      {Object.entries(l.types)
                        .map(([type, [a, b]]) => (a === b ? `${type} ${b}` : `${type} ${a} → ${b}`))
                        .join(", ")}
                    </td>
                    <td>{l.props.map((p) => `${t(`versionDiff.layerProps.${p.prop}` as never)}: ${propValue(p.from, tx)} → ${propValue(p.to, tx)}`).join("; ")}</td>
                    <td>{l.entitiesB > 0 && <Link className="small" to={openLayer(l.layer)} title={t("versionDiff.cad.showLayerHint")}>{t("versionDiff.cad.showLayer")}</Link>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {model && (
        <div className="vdiff-tables">
          <div>
            <h3>{t("versionDiff.model.classesHeading")}</h3>
            <div className="table-scroll">
              <table className="props-table small vdiff-table">
                <thead>
                  <tr>
                    <th>{t("versionDiff.columns.class")}</th>
                    <th>{t("versionDiff.kinds.added")}</th>
                    <th>{t("versionDiff.kinds.removed")}</th>
                    <th>{t("versionDiff.kinds.changed")}</th>
                    <th>{t("versionDiff.kinds.unchanged")}</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(model.byClass)
                    .sort((a, b) => b[1].added + b[1].removed + b[1].changed - (a[1].added + a[1].removed + a[1].changed) || a[0].localeCompare(b[0]))
                    .map(([cls, n]) => (
                      <tr key={cls} className={filter.group === cls ? "active" : undefined}>
                        <td>
                          <a href="#" onClick={(e) => (e.preventDefault(), set({ group: filter.group === cls ? undefined : cls }))}>{ifcClassLabel(cls, i18n.language)}</a>{" "}
                          <span className="muted">{cls}</span>
                        </td>
                        <td>{n.added || ""}</td>
                        <td>{n.removed || ""}</td>
                        <td>{n.changed || ""}</td>
                        <td className="muted">{n.unchanged}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <h3>{t("versionDiff.model.storeysHeading")}</h3>
            <div className="table-scroll">
              <table className="props-table small vdiff-table">
                <thead>
                  <tr>
                    <th>{t("versionDiff.columns.storey")}</th>
                    <th>{t("versionDiff.kinds.added")}</th>
                    <th>{t("versionDiff.kinds.removed")}</th>
                    <th>{t("versionDiff.kinds.changed")}</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(model.byStorey)
                    .sort((a, b) => a[0].localeCompare(b[0], i18n.language))
                    .map(([storey, n]) => (
                      <tr key={storey} className={filter.subgroup === storey ? "active" : undefined}>
                        <td>
                          <a href="#" onClick={(e) => (e.preventDefault(), set({ subgroup: filter.subgroup === storey ? undefined : storey }))}>{storey || t("versionDiff.noStorey")}</a>
                        </td>
                        <td>{n.added || ""}</td>
                        <td>{n.removed || ""}</td>
                        <td>{n.changed || ""}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <h3>{t("versionDiff.listHeading", { count: page?.total ?? 0 })}</h3>
      <div className="vdiff-filters">
        <select aria-label={t("versionDiff.filters.kind")} value={filter.kind ?? ""} onChange={(e) => set({ kind: (e.target.value || undefined) as VersionDiffKind | undefined })}>
          <option value="">{t("versionDiff.filters.allKinds")}</option>
          {KINDS.map((k) => <option key={k} value={k}>{t(`versionDiff.kinds.${k}` as never)}</option>)}
        </select>
        <select aria-label={cad ? t("versionDiff.columns.layer") : t("versionDiff.columns.class")} value={filter.group ?? ALL} onChange={(e) => set({ group: e.target.value === ALL ? undefined : e.target.value })}>
          <option value={ALL}>{cad ? t("versionDiff.filters.allLayers") : t("versionDiff.filters.allClasses")}</option>
          {groups.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
        </select>
        <select aria-label={cad ? t("versionDiff.columns.entityType") : t("versionDiff.columns.storey")} value={filter.subgroup ?? ALL} onChange={(e) => set({ subgroup: e.target.value === ALL ? undefined : e.target.value })}>
          <option value={ALL}>{cad ? t("versionDiff.filters.allTypes") : t("versionDiff.filters.allStoreys")}</option>
          {subgroups.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
        </select>
        <select aria-label={t("versionDiff.filters.aspect")} value={filter.aspect ?? ""} onChange={(e) => set({ aspect: e.target.value || undefined })}>
          <option value="">{t("versionDiff.filters.allAspects")}</option>
          {aspects.map((a) => <option key={a} value={a}>{aspectLabel(a)}</option>)}
        </select>
        <input type="search" placeholder={t("versionDiff.filters.search")} aria-label={t("versionDiff.filters.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
        {(filter.kind || filter.group !== undefined || filter.subgroup !== undefined || filter.aspect || filter.q) && (
          <button className="small ghost" onClick={() => (setFilter({}), setQuery(""))}>{t("versionDiff.filters.clear")}</button>
        )}
        <div className="spacer" />
        <a className="btn small" href={api.versionDifferencesExportUrl(project.id, dto.id, "xlsx", filter)} download>{t("versionDiff.export.xlsx")}</a>
        <a className="btn small ghost" href={api.versionDifferencesExportUrl(project.id, dto.id, "csv", filter)} download>{t("versionDiff.export.csv")}</a>
      </div>
      {error && <p className="error small">{error}</p>}
      <div className="table-scroll">
        <table className="props-table small vdiff-table vdiff-list">
          <thead>
            <tr>
              <th>{t("versionDiff.columns.kind")}</th>
              <th>{cad ? t("versionDiff.columns.layer") : t("versionDiff.columns.class")}</th>
              <th>{cad ? t("versionDiff.columns.entityType") : t("versionDiff.columns.storey")}</th>
              <th>{cad ? t("versionDiff.columns.handle") : t("versionDiff.columns.element")}</th>
              <th>{t("versionDiff.columns.changes")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.kind}-${r.id}`}>
                <td><span className={`badge diff-${r.kind}`}>{t(`versionDiff.kinds.${r.kind}` as never)}</span></td>
                <td>{groupLabel(r.group)}</td>
                <td>{model ? r.subgroup || t("versionDiff.noStorey") : r.subgroup}</td>
                <td>
                  {r.name && <div>{r.name}</div>}
                  <code className="muted">{r.id}</code>
                </td>
                <td>
                  {r.changes.length ? (
                    <ul className="vdiff-changes">{r.changes.map((c, i) => <li key={i}>{changeNode(c, tx)}</li>)}</ul>
                  ) : null}
                </td>
                <td>
                  {model ? (
                    <Link className="small" to={modelCompareUrl(project.id, dto.from.versionId, dto.to.versionId, { guid: r.id, removed: r.kind === "removed" })} title={t("versionDiff.model.showHint")}>
                      {t("versionDiff.model.show")}
                    </Link>
                  ) : r.kind !== "removed" ? (
                    <Link className="small" to={openLayer(r.group)} title={t("versionDiff.cad.showLayerHint")}>{t("versionDiff.cad.showLayer")}</Link>
                  ) : null}
                </td>
              </tr>
            ))}
            {!rows.length && !loading && (
              <tr>
                <td colSpan={6} className="muted">{t("versionDiff.empty")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {page && rows.length < page.total && (
        <button className="small ghost" disabled={loading} onClick={() => void more()}>
          {loading ? <span className="spin" /> : null} {t("versionDiff.more", { shown: rows.length, total: page.total })}
        </button>
      )}
    </div>
  );
}

function Kpi({ kind, value, label, onClick }: { kind?: VersionDiffKind; value: number; label: string; onClick?: () => void }) {
  const body = (
    <>
      <b>{value}</b>
      <span>{label}</span>
    </>
  );
  return onClick ? (
    <button className={`vdiff-kpi${kind ? ` diff-${kind}` : ""}`} onClick={onClick}>{body}</button>
  ) : (
    <div className="vdiff-kpi">{body}</div>
  );
}

/** t() for keys built at run time. */
type Tx = (key: string, options?: Record<string, unknown>) => string;

function propValue(v: string | null, t: Tx): string {
  if (v === "true") return t("versionDiff.yes");
  if (v === "false") return t("versionDiff.no");
  return v ?? "—";
}

function changeLabel(prop: string, t: Tx): string {
  return prop.startsWith("@") ? t(`versionDiff.props.${prop.slice(1)}`, { defaultValue: prop.slice(1) }) : prop;
}

function changeNode(c: VersionDiffChange, t: Tx): ReactNode {
  const label = changeLabel(c.prop, t);
  if (c.from === null && c.to === null) return label;
  return (
    <>
      {label}: <del className="diff-old">{c.from ?? "—"}</del> → <ins className="diff-new">{c.to ?? "—"}</ins>
    </>
  );
}
