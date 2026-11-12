import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { LOCATION_TYPES, formatChainage, type LocationDto } from "@sitekeep/shared";
import { api, type LocationInput } from "../../../shared/api/api";
import { useAsk } from "../../../shared/ui/Ask";
import { Dialog } from "../../../shared/ui/Dialog";
import { LocationSelect, flattenLocations, locationLabel } from "../../../shared/ui/LocationSelect";
import { useLoad, useProject } from "../../../app/context/project";
import { reportBuilderUrl, ReportShortcut } from "../../documents/components/ReportShortcut";
import { MoreMenu } from "../../../shared/ui/MoreMenu";
import { usePhoneWidth } from "../../../shared/ui/RecordCards";
import { useLabel } from "../../../i18n";

/** Project tab "Konumlar": location tree with km chainage, CSV import and IFC spatial import. */
/** `embedded`: inside Proje Ayarları → Konumlar (no page header, no outer padding). */
export function LocationsPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation(["projectSettings", "common"]);
  const { confirm } = useAsk();
  const project = useProject();
  const navigate = useNavigate();
  const phone = usePhoneWidth();
  const admin = !!project.isProjectAdmin;
  const { data: list, error, reload } = useLoad(() => api.locations(project.id), [project.id]);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<"new-root" | "new-child" | "csv" | "ifc" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const sel = list?.find((l) => l.id === selected) ?? null;

  const flat = flattenLocations(list ?? []);
  const hasKids = new Set((list ?? []).map((l) => l.parentId).filter(Boolean) as string[]);
  const hiddenBy = (l: LocationDto): boolean => {
    let p = l.parentId;
    while (p) {
      if (collapsed.has(p)) return true;
      p = list?.find((x) => x.id === p)?.parentId ?? null;
    }
    return false;
  };

  async function remove(l: LocationDto) {
    if (
      !(await confirm({
        title: t("locations.remove.title"),
        message: t("locations.remove.confirm", { name: l.name }),
        confirmLabel: t("common:actions.delete"),
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteLocation(project.id, l.id);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (
        err.status !== 409 ||
        !(await confirm({
          title: t("locations.unlink.title"),
          message: t("locations.unlink.confirm", { message: err.message }),
          confirmLabel: t("common:actions.delete"),
          danger: true,
        }))
      ) {
        if (err.status !== 409) setMsg(err.message);
        return;
      }
      await api.deleteLocation(project.id, l.id, true);
    }
    setSelected(null);
    reload();
  }

  return (
    <div className={`split${sel ? " with-detail" : ""}`}>
      <div className={embedded ? "" : "page"} style={{ maxWidth: "none", width: "100%", overflow: "auto" }}>
        <div className="row wrap" style={{ marginBottom: 12 }}>
          {!embedded && <h1 style={{ margin: 0 }}>{t("locations.title")}</h1>}
          <div className="spacer" />
          {phone ? (
            <>
              {admin && (
                <button className="primary" onClick={() => setDialog("new-root")}>
                  {t("locations.actions.add")}
                </button>
              )}
              <MoreMenu
                items={[
                  { key: "report", label: t("locations.actions.report") },
                  ...(admin
                    ? [
                        { key: "csv", label: t("locations.actions.importCsv") },
                        { key: "ifc", label: t("locations.actions.fromIfc") },
                      ]
                    : []),
                ]}
                onSelect={(key) => {
                  if (key === "report") navigate(reportBuilderUrl(project.id, "locations"));
                  else if (key === "csv") setDialog("csv");
                  else if (key === "ifc") setDialog("ifc");
                }}
              />
            </>
          ) : (
            <>
              <ReportShortcut module="locations" />
              {admin && (
                <>
                  <button onClick={() => setDialog("csv")}>{t("locations.actions.importCsv")}</button>
                  <button onClick={() => setDialog("ifc")}>{t("locations.actions.fromIfc")}</button>
                  <button className="primary" onClick={() => setDialog("new-root")}>
                    {t("locations.actions.add")}
                  </button>
                </>
              )}
            </>
          )}
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          {t("locations.description")}
        </p>
        {error && <p className="error">{error}</p>}
        {msg && <p className="error">{msg}</p>}
        <div className="card" style={{ padding: 0 }}>
          <table className="phone-cards">
            <thead>
              <tr>
                <th>{t("locations.columns.name")}</th>
                <th style={{ width: 110 }}>{t("locations.columns.code")}</th>
                <th style={{ width: 130 }}>{t("locations.columns.type")}</th>
                <th style={{ width: 190 }}>{t("locations.columns.km")}</th>
                <th style={{ width: 150 }}>{t("locations.columns.ifc")}</th>
              </tr>
            </thead>
            <tbody>
              {flat
                .filter(({ loc }) => !hiddenBy(loc))
                .map(({ loc, depth }) => (
                  <tr key={loc.id} className={`clickable${loc.id === selected ? " selected" : ""}`} onClick={() => setSelected(loc.id)}>
                    <td style={{ paddingLeft: 10 + depth * 18 }}>
                      <span
                        className="tree-toggle"
                        style={{ display: "inline-block", cursor: "pointer" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setCollapsed((s) => {
                            const n = new Set(s);
                            if (n.has(loc.id)) n.delete(loc.id);
                            else n.add(loc.id);
                            return n;
                          });
                        }}
                      >
                        {hasKids.has(loc.id) ? (collapsed.has(loc.id) ? "▸" : "▾") : ""}
                      </span>{" "}
                      {loc.name}
                    </td>
                    <td className="mono">{loc.code ?? ""}</td>
                    <td className="muted">{loc.type ?? ""}</td>
                    <td className="mono">
                      {loc.kmStart !== null || loc.kmEnd !== null ? `${formatChainage(loc.kmStart)} – ${formatChainage(loc.kmEnd)}` : ""}
                    </td>
                    <td className="muted small">{loc.ifcClass ?? ""}</td>
                  </tr>
                ))}
              {list?.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted" style={{ textAlign: "center", padding: 32 }}>
                    {t("locations.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {sel && (
        <LocationDetail
          key={sel.id}
          loc={sel}
          all={list ?? []}
          admin={admin}
          onAddChild={() => setDialog("new-child")}
          onDelete={() => void remove(sel)}
          onSaved={reload}
          onClose={() => setSelected(null)}
        />
      )}
      {(dialog === "new-root" || dialog === "new-child") && (
        <Dialog title={t("locations.new.title")} onClose={() => setDialog(null)}>
          <LocationForm
            all={list ?? []}
            initial={{ name: "", parentId: dialog === "new-child" ? selected : null }}
            onSubmit={async (v) => {
              const created = await api.createLocation(project.id, v);
              setDialog(null);
              setSelected(created.id);
              reload();
            }}
          />
        </Dialog>
      )}
      {dialog === "csv" && <CsvDialog parentId={selected} all={list ?? []} onClose={() => setDialog(null)} onDone={reload} />}
      {dialog === "ifc" && <IfcDialog parentId={selected} all={list ?? []} onClose={() => setDialog(null)} onDone={reload} />}
    </div>
  );
}

function LocationForm({
  all,
  initial,
  excludeId,
  onSubmit,
  disabled,
}: {
  all: LocationDto[];
  initial: LocationInput;
  excludeId?: string;
  onSubmit(v: LocationInput): Promise<void>;
  disabled?: boolean;
}) {
  const [v, setV] = useState<LocationInput>({
    ...initial,
    kmStart: typeof initial.kmStart === "number" ? formatChainage(initial.kmStart) : (initial.kmStart ?? ""),
    kmEnd: typeof initial.kmEnd === "number" ? formatChainage(initial.kmEnd) : (initial.kmEnd ?? ""),
  });
  const { t } = useTranslation(["projectSettings", "common"]);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<LocationInput>) => setV((x) => ({ ...x, ...p }));
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await onSubmit({ ...v, kmStart: v.kmStart || null, kmEnd: v.kmEnd || null, code: v.code || null, type: v.type || null });
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <label>{t("common:fields.name")}</label>
      <input
        required
        disabled={disabled}
        value={v.name}
        onChange={(e) => set({ name: e.target.value })}
        placeholder={t("locations.form.namePlaceholder")}
      />
      <div className="row">
        <div style={{ flex: 1 }}>
          <label>{t("common:fields.code")}</label>
          <input disabled={disabled} value={v.code ?? ""} onChange={(e) => set({ code: e.target.value })} placeholder={t("locations.form.codePlaceholder")} />
        </div>
        <div style={{ flex: 1 }}>
          <label>{t("locations.form.fields.type")}</label>
          <input disabled={disabled} list="location-types" value={v.type ?? ""} onChange={(e) => set({ type: e.target.value })} />
          <datalist id="location-types">
            {LOCATION_TYPES.map((lt) => (
              <option key={lt} value={lt} />
            ))}
          </datalist>
        </div>
      </div>
      <div className="row">
        <div style={{ flex: 1 }}>
          <label>{t("locations.form.fields.kmStart")}</label>
          <input disabled={disabled} value={String(v.kmStart ?? "")} onChange={(e) => set({ kmStart: e.target.value })} placeholder="12+345.6" />
        </div>
        <div style={{ flex: 1 }}>
          <label>{t("locations.form.fields.kmEnd")}</label>
          <input disabled={disabled} value={String(v.kmEnd ?? "")} onChange={(e) => set({ kmEnd: e.target.value })} placeholder="13+020" />
        </div>
      </div>
      <label>{t("locations.form.fields.parent")}</label>
      <LocationSelect
        disabled={disabled}
        locations={all.filter((l) => l.id !== excludeId)}
        value={v.parentId ?? null}
        onChange={(id) => set({ parentId: id })}
        emptyLabel={t("locations.form.options.topLevel")}
      />
      {error && <p className="error">{error}</p>}
      {!disabled && (
        <div className="dialog-actions">
          <button className="primary">{t("common:actions.save")}</button>
        </div>
      )}
    </form>
  );
}

function LocationDetail({
  loc,
  all,
  admin,
  onAddChild,
  onDelete,
  onSaved,
  onClose,
}: {
  loc: LocationDto;
  all: LocationDto[];
  admin: boolean;
  onAddChild(): void;
  onDelete(): void;
  onSaved(): void;
  onClose(): void;
}) {
  const { t } = useTranslation(["projectSettings", "common"]);
  const label = useLabel();
  const project = useProject();
  const { data: links } = useLoad(() => api.locationLinks(project.id, { locationId: loc.id, subtree: true }), [project.id, loc.id]);
  const [saved, setSaved] = useState(false);
  return (
    <aside className="panel right">
      <div className="row">
        <h2 style={{ margin: 0 }}>{locationLabel(loc)}</h2>
        <div className="spacer" />
        <button className="ghost" aria-label={t("common:actions.close")} onClick={onClose}>
          ✕
        </button>
      </div>
      {loc.ifcGlobalId && (
        <p className="muted small">
          IFC: {loc.ifcClass} · <span className="mono">{loc.ifcGlobalId}</span>
        </p>
      )}
      <LocationForm
        all={all}
        excludeId={loc.id}
        disabled={!admin}
        initial={{ name: loc.name, code: loc.code, type: loc.type, kmStart: loc.kmStart, kmEnd: loc.kmEnd, parentId: loc.parentId }}
        onSubmit={async (v) => {
          await api.updateLocation(project.id, loc.id, v);
          setSaved(true);
          onSaved();
        }}
      />
      {saved && <p className="success small">{t("locations.detail.messages.saved")}</p>}
      {admin && (
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={onAddChild}>{t("locations.detail.actions.addChild")}</button>
          <div className="spacer" />
          <button className="danger" onClick={onDelete}>
            {t("common:actions.delete")}
          </button>
        </div>
      )}
      <h3 style={{ marginTop: 20 }}>{t("locations.detail.linksHeading")}</h3>
      {links?.length === 0 && <p className="muted small">{t("locations.detail.noLinks")}</p>}
      {links?.map((l) => (
        <div key={`${l.kind}:${l.targetId}`} className="small" style={{ padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
          <span className="badge">{label("locationLinkKind", l.kind)}</span>{" "}
          <a href={l.kind === "issue" ? `/projects/${project.id}/issues/${l.targetId}` : l.kind === "form" ? `/projects/${project.id}/forms/${l.targetId}` : `#`}>
            {l.label ?? l.targetId}
          </a>
        </div>
      ))}
    </aside>
  );
}

function CsvDialog({ parentId, all, onClose, onDone }: { parentId: string | null; all: LocationDto[]; onClose(): void; onDone(): void }) {
  const { t } = useTranslation(["projectSettings", "common"]);
  const project = useProject();
  const [csv, setCsv] = useState("Kod;Ad;Tip;Üst kod;Km başlangıç;Km bitiş\n"); // i18n-ok: CSV column names the server reads
  const [parent, setParent] = useState<string | null>(parentId);
  const [result, setResult] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ line: number; message: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={t("locations.csv.title")} onClose={onClose} wide>
      <p className="muted small" style={{ marginTop: 0 }}>
        <Trans t={t} i18nKey="locations.csv.description" components={{ code: <code /> }} />
      </p>
      <input
        type="file"
        accept=".csv,text/csv,text/plain"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) setCsv(await f.text());
        }}
      />
      <textarea className="mono" style={{ minHeight: 200, marginTop: 8 }} value={csv} onChange={(e) => setCsv(e.target.value)} />
      <label>{t("locations.csv.fields.parent")}</label>
      <LocationSelect locations={all} value={parent} onChange={setParent} emptyLabel={t("locations.form.options.topLevel")} />
      {error && <p className="error">{error}</p>}
      {errors.length > 0 && (
        <ul className="error small">
          {errors.slice(0, 30).map((x, i) => (
            <li key={i}>
              {t("locations.csv.lineError", { line: x.line, message: x.message })}
            </li>
          ))}
        </ul>
      )}
      {result && <p className="success">{result}</p>}
      <div className="dialog-actions">
        <button onClick={onClose}>{t("common:actions.close")}</button>
        <button
          className="primary"
          onClick={async () => {
            setError(null);
            setErrors([]);
            setResult(null);
            try {
              const r = await api.importLocationsCsv(project.id, csv, parent);
              setResult(t("locations.csv.result", { created: r.created, updated: r.updated }));
              onDone();
            } catch (e) {
              const err = e as Error & { body?: { details?: { line: number; message: string }[] } };
              setError(err.message);
              if (Array.isArray(err.body?.details)) setErrors(err.body!.details!);
            }
          }}
        >
          {t("locations.csv.actions.import")}
        </button>
      </div>
    </Dialog>
  );
}

function IfcDialog({ parentId, all, onClose, onDone }: { parentId: string | null; all: LocationDto[]; onClose(): void; onDone(): void }) {
  const { t } = useTranslation(["projectSettings", "common"]);
  const project = useProject();
  const { data: models } = useLoad(() => api.models(project.id), [project.id]);
  const [vid, setVid] = useState("");
  const [parent, setParent] = useState<string | null>(parentId);
  const [job, setJob] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!job) return;
    const timer = setInterval(async () => {
      try {
        const s = await api.locationImportJob(project.id, job);
        if (s.status === "done") {
          setStatus(t("locations.ifc.done", { created: s.result?.created ?? 0, updated: s.result?.updated ?? 0 }));
          setJob(null);
          onDone();
        } else if (s.status === "failed") {
          setError(s.error ?? t("locations.ifc.failed"));
          setJob(null);
        } else setStatus(s.status === "running" ? t("locations.ifc.reading") : t("locations.ifc.queued"));
      } catch (e) {
        setError((e as Error).message);
        setJob(null);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [job, project.id, onDone, t]);

  return (
    <Dialog title={t("locations.ifc.title")} onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("locations.ifc.description")}
      </p>
      <label>{t("locations.ifc.fields.model")}</label>
      <select value={vid} onChange={(e) => setVid(e.target.value)}>
        <option value="">{t("locations.ifc.options.choose")}</option>
        {models?.map((m) => (
          <option key={m.id} value={m.id}>
            {m.folderPath} / {m.fileName} (v{m.version})
          </option>
        ))}
      </select>
      <label>{t("locations.ifc.fields.parent")}</label>
      <LocationSelect locations={all} value={parent} onChange={setParent} emptyLabel={t("locations.form.options.topLevel")} />
      {status && <p className="notice">{status}</p>}
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button onClick={onClose}>{t("common:actions.close")}</button>
        <button
          className="primary"
          disabled={!vid || !!job}
          onClick={async () => {
            setError(null);
            setStatus(null);
            try {
              const r = await api.importLocationsIfc(project.id, vid, parent);
              setJob(r.jobId);
              setStatus(t("locations.ifc.queued"));
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          {t("common:actions.create")}
        </button>
      </div>
    </Dialog>
  );
}
