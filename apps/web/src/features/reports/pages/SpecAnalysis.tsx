import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import {
  SUBMITTAL_DISCIPLINES,
  SUBMITTAL_TYPES,
  submittalDisciplineLabel,
  submittalTypeLabel,
  type SubmittalDisciplineCode,
  type SubmittalRegisterItem,
  type SubmittalTypeCode,
} from "@sitekeep/shared";
import { api, formatDate, intlLocale } from "../../../shared/api/api";
import { documentsApi } from "../../documents/api";
import { ConfidenceBadge } from "../../documents/components/AntetPanel";
import { useLoad, useProject } from "../../../app/context/project";
import { webCapability } from "../../../sdk/capabilities";
import { reportBuilderUrl, ReportShortcut } from "../../documents/components/ReportShortcut";
import { Dialog } from "../../../shared/ui/Dialog";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";
import { MoreMenu } from "../../../shared/ui/MoreMenu";
import { usePhoneWidth } from "../../../shared/ui/RecordCards";


/** "Şartname analizi": draft submittal registers built from specification PDFs. */
export function SpecAnalysisPage() {
  const { rid } = useParams();
  return rid ? <RegisterView rid={rid} /> : <RegisterList />;
}

function RegisterList() {
  const { t } = useTranslation(["reports", "common"]);
  const project = useProject();
  const navigate = useNavigate();
  const phone = usePhoneWidth();
  const { data, error } = useLoad(() => api.specRegisters(project.id), [project.id]);
  const [picking, setPicking] = useState(false);
  const existingVersions = useMemo(() => new Set((data ?? []).map((r) => r.versionId)), [data]);
  return (
    <div className="page">
      <div className="muted small">
        <Link to={`/projects/${project.id}/files`}>{t("spec.actions.backToDocuments")}</Link>
      </div>
      <div className="row wrap" style={{ margin: "6px 0 12px" }}>
        <h1 style={{ margin: 0 }}>{t("spec.title")}</h1>
        <div className="spacer" />
        <button className="primary" onClick={() => setPicking(true)}>
          {t("spec.actions.newAnalysis")}
        </button>
        {phone ? (
          <MoreMenu
            items={[{ key: "report", label: t("spec.actions.report") }]}
            onSelect={(key) => {
              if (key === "report") navigate(reportBuilderUrl(project.id, "spec"));
            }}
          />
        ) : (
          <ReportShortcut module="spec" />
        )}
      </div>
      <p className="muted small">
        <Trans t={t} i18nKey="spec.intro" components={{ strong: <strong /> }} />
      </p>
      {error && <p className="error">{error}</p>}
      {data && data.length === 0 && <p className="muted">{t("spec.empty")}</p>}
      {data && data.length > 0 && (
        <table className="phone-cards">
          <thead>
            <tr>
              <th>{t("spec.columns.specification")}</th>
              <th style={{ width: 80 }}>{t("spec.columns.version")}</th>
              <th style={{ width: 90 }}>{t("spec.columns.items")}</th>
              <th style={{ width: 150 }}>{t("spec.columns.updated")}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={r.id}>{r.fileName}</Link>
                </td>
                <td>
                  <span className="badge">V{r.version}</span>
                </td>
                <td>{r.itemCount}</td>
                <td className="muted small">{formatDate(r.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {picking && (
        <NewSpecAnalysisDialog
          existingVersions={existingVersions}
          onClose={() => setPicking(false)}
          onDone={(id) => {
            setPicking(false);
            navigate(`/projects/${project.id}/spec/${id}`);
          }}
        />
      )}
    </div>
  );
}

function NewSpecAnalysisDialog({
  existingVersions,
  onClose,
  onDone,
}: {
  existingVersions: Set<string>;
  onClose(): void;
  onDone(registerId: string): void;
}) {
  const { t } = useTranslation(["reports", "common"]);
  const project = useProject();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [versionId, setVersionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { data, error } = useLoad(() => documentsApi.search(project.id, { q: query, ext: "pdf" }), [project.id, query]);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);

  const files = useMemo(() => {
    const list = (data?.results ?? []).filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    const specLike = (name: string) => /sartname|şartname|spec|teknik/i.test(name);
    return [...list].sort((a, b) => Number(specLike(b.name)) - Number(specLike(a.name)) || a.name.localeCompare(b.name));
  }, [data]);

  async function run() {
    if (!versionId || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const reg = await documentsApi.buildSpecRegister(project.id, versionId, false);
      onDone(reg.id);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog title={t("spec.picker.title")} onClose={onClose} wide>
      <input
        autoFocus
        placeholder={t("spec.picker.placeholder")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {(error || err) && <p className="error small">{err ?? error}</p>}
      <div style={{ maxHeight: 360, overflow: "auto", marginTop: 8 }}>
        {!data ? (
          <LoadingIndicator />
        ) : files.length === 0 ? (
          <p className="muted small">{t("spec.picker.empty")}</p>
        ) : (
          <table className="phone-cards">
            <tbody>
              {files.map((f) => {
                const vid = f.latest.id;
                const on = versionId === vid;
                const analysed = existingVersions.has(vid);
                return (
                  <tr
                    key={f.id}
                    className={`clickable${on ? " selected" : ""}`}
                    onClick={() => setVersionId(vid)}
                    onDoubleClick={() => {
                      setVersionId(vid);
                      void documentsApi.buildSpecRegister(project.id, vid, false).then((r) => onDone(r.id), (e: Error) => setErr(e.message));
                    }}
                  >
                    <td className="pc-inline" style={{ width: 30 }}>
                      <input type="radio" readOnly checked={on} style={{ width: "auto" }} />
                    </td>
                    <td className="pc-title">
                      {f.name}
                      <div className="muted small">{f.folderPath}</div>
                    </td>
                    <td className="small" style={{ width: 130, textAlign: "right" }}>
                      {analysed && <span className="badge info" style={{ marginRight: 6 }}>{t("spec.picker.analysed")}</span>}
                      <span className="badge">V{f.currentVersion}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="dialog-actions">
        <Link className="btn" to={`/projects/${project.id}/files?yukle=1`} onClick={onClose}>
          {t("spec.picker.uploadPdf")}
        </Link>
        <div className="spacer" />
        <button onClick={onClose} disabled={busy}>{t("common:actions.cancel")}</button>
        <button className="primary" disabled={!versionId || busy} onClick={() => void run()}>
          {busy ? t("spec.picker.running") : t("spec.picker.start")}
        </button>
      </div>
    </Dialog>
  );
}

function RegisterView({ rid }: { rid: string }) {
  const { t, i18n } = useTranslation(["reports", "common"]);
  const project = useProject();
  const navigate = useNavigate();
  const phone = usePhoneWidth();
  const { data: reg, error, setData } = useLoad(() => api.specRegister(project.id, rid), [project.id, rid]);
  const { data: intel } = useLoad(
    () => (reg ? documentsApi.versionDocIntel(project.id, reg.versionId) : Promise.resolve(null)),
    [project.id, reg?.versionId],
  );
  const [items, setItems] = useState<SubmittalRegisterItem[]>([]);
  const [dirty, setDirty] = useState(false);
  const [type, setType] = useState("");
  const [disc, setDisc] = useState("");
  const [q, setQ] = useState("");
  const [showExcluded, setShowExcluded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // Importing the register as submittal works is Manage's.
  const ImportDialog = webCapability("manage.ui")?.ImportDialog;

  useEffect(() => {
    if (reg) {
      setItems(reg.items);
      setDirty(false);
    }
  }, [reg]);

  const shown = useMemo(() => {
    const locale = intlLocale();
    const needle = q.trim().toLocaleLowerCase(locale);
    return items.filter(
      (i) =>
        (showExcluded || !i.excluded) &&
        (!type || (type === "-" ? !i.type : i.type === type)) &&
        (!disc || (disc === "-" ? !i.discipline : i.discipline === disc)) &&
        (!needle ||
          `${i.sectionCode ?? ""} ${i.sectionTitle ?? ""} ${i.description} ${i.excerpt}`
            .toLocaleLowerCase(locale)
            .includes(needle)),
    );
  }, [items, type, disc, q, showExcluded]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) if (!i.excluded) m.set(i.type ?? "-", (m.get(i.type ?? "-") ?? 0) + 1);
    return m;
  }, [items]);

  function edit(id: string, patch: Partial<SubmittalRegisterItem>) {
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...patch } : i)));
    setDirty(true);
  }

  async function act(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (error) return <div className="page error">{error}</div>;
  if (!reg) return <LoadingIndicator className="page" />;

  const exportItems = [
    { key: "pdf", label: t("specView.actions.viewPdf") },
    { key: "xlsx", label: "Excel (.xlsx)" },
    { key: "csv", label: "CSV (.csv)" },
    { key: "json", label: "JSON (.json)" },
    ...(intel?.aiAvailable
      ? [
          {
            key: "ai" as const,
            label: busy === "ai" ? t("specView.status.aiRunning") : t("specView.actions.aiClassify"),
            disabled: !!busy || dirty,
            note: dirty ? t("specView.messages.saveFirst") : undefined,
          },
        ]
      : []),
    { key: "rebuild", label: t("specView.actions.rebuild"), disabled: !!busy || dirty, note: dirty ? t("specView.messages.saveFirst") : undefined },
  ];

  function handleMenu(key: string) {
    if (key === "pdf") navigate(`/projects/${project.id}/view/${reg!.versionId}`);
    else if (key === "xlsx" || key === "csv" || key === "json") {
      window.location.assign(api.specRegisterExportUrl(project.id, reg!.id, key));
    } else if (key === "ai") {
      void act("ai", async () => {
        const r = await documentsApi.buildSpecRegister(project.id, reg!.versionId, true);
        setData(r);
      });
    } else if (key === "rebuild") {
      void act("rebuild", async () => {
        const r = await documentsApi.buildSpecRegister(project.id, reg!.versionId, false);
        if (r.id !== reg!.id) navigate(`/projects/${project.id}/spec/${r.id}`);
        setData(r);
      });
    }
  }

  return (
    <div className="page">
      <div className="row wrap" style={{ marginBottom: 6 }}>
        <Link to={`/projects/${project.id}/spec`} className="muted small">
          {t("specView.actions.back")}
        </Link>
      </div>
      <div className="row wrap" style={{ marginBottom: 6, gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>{reg.fileName}</h1>
        <span className="badge">V{reg.version}</span>
        {reg.usedAi && <span className="badge info">{t("specView.badges.aiAssisted")}</span>}
        <span className="muted small">
          · {t("specView.pages", { count: reg.pageCount })}, {t("specView.sections", { count: reg.sectionCount })},{" "}
          {t("specView.items", { count: items.filter((i) => !i.excluded).length })}
        </span>
        <div className="spacer" />
        <button
          disabled={dirty}
          title={dirty ? t("specView.messages.saveFirst") : t("specView.importHint")}
          onClick={() => setImporting(true)}
        >
          {t("specView.actions.import")}
        </button>
        <button
          className="primary"
          disabled={!dirty || !!busy}
          onClick={() => void act("save", async () => setData(await api.updateSpecRegister(project.id, reg.id, items)))}
        >
          {t("common:actions.save")}
        </button>
        <MoreMenu items={exportItems} onSelect={handleMenu} />
      </div>

      <div className="spec-toolbar">
        <input
          className="spec-filter-search"
          placeholder={t("specView.placeholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="spec-filter-select" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">{t("specView.options.allTypes")} ({items.filter((i) => !i.excluded).length})</option>
          {counts.has("-") && (
            <option value="-">
              {t("specView.status.unclassified")} ({counts.get("-")})
            </option>
          )}
          {SUBMITTAL_TYPES.map((st) => {
            const n = counts.get(st.code) ?? 0;
            return (
              <option key={st.code} value={st.code}>
                {st.code} · {submittalTypeLabel(st.code, i18n.language)}
                {n ? ` (${n})` : ""}
              </option>
            );
          })}
        </select>
        <select className="spec-filter-select" value={disc} onChange={(e) => setDisc(e.target.value)}>
          <option value="">{t("specView.options.allDisciplines")}</option>
          <option value="-">{t("specView.options.noDiscipline")}</option>
          {SUBMITTAL_DISCIPLINES.map((d) => (
            <option key={d.code} value={d.code}>
              {d.code} · {submittalDisciplineLabel(d.code, i18n.language)}
            </option>
          ))}
        </select>
        <label className="row small muted" style={{ margin: 0, whiteSpace: "nowrap" }}>
          <input
            type="checkbox"
            checked={showExcluded}
            onChange={(e) => setShowExcluded(e.target.checked)}
            style={{ width: "auto" }}
          />{" "}
          {t("specView.options.showExcluded")}
        </label>
      </div>

      {msg && <p className="error">{msg}</p>}
      {importing && ImportDialog && (
        <ImportDialog
          items={items.filter((i) => !i.excluded).map((i) => ({ ...i, sourceFileVersionId: reg.versionId }))}
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            navigate(`/projects/${project.id}/works`);
          }}
        />
      )}
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table className="phone-cards spec-items">
          <thead>
            <tr>
              <th style={{ width: 52 }}>{t("specView.columns.no")}</th>
              <th style={{ width: 190 }}>{t("specView.columns.section")}</th>
              <th style={{ width: 245 }}>{t("specView.columns.type")}</th>
              <th style={{ width: 165 }}>{t("specView.columns.discipline")}</th>
              <th>{t("specView.columns.requirement")}</th>
              <th style={{ width: 58, textAlign: "center" }}>{t("specView.columns.included")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => (
              <tr key={i.id} className={i.excluded ? "spec-row-excluded" : undefined}>
                <td className="pc-title mono small">
                  <div>{i.id}</div>
                  <div className="muted" style={{ fontSize: 11 }}>S.{i.page}</div>
                </td>
                <td className="small" data-label={t("specView.columns.section")}>
                  {i.sectionCode && <div className="mono" style={{ fontWeight: 600 }}>{i.sectionCode}</div>}
                  <div className="muted spec-section-title">{i.sectionTitle ?? "—"}</div>
                </td>
                <td data-label={t("specView.columns.type")}>
                  <div className="spec-cell-inline">
                    <select
                      className="spec-select"
                      value={i.type ?? ""}
                      title={i.type ? `${i.type} · ${submittalTypeLabel(i.type, i18n.language)}` : t("specView.status.unclassified")}
                      onChange={(e) =>
                        edit(i.id, { type: (e.target.value || null) as SubmittalTypeCode | null, typeConfidence: 1 })
                      }
                    >
                      <option value="">{t("specView.status.unclassified")}</option>
                      {SUBMITTAL_TYPES.map((st) => (
                        <option key={st.code} value={st.code}>
                          {st.code} · {submittalTypeLabel(st.code, i18n.language)}
                        </option>
                      ))}
                    </select>
                    <ConfidenceBadge value={i.typeConfidence} ambiguous={!i.type} />
                    {i.aiAssisted && <span className="badge info">{t("specView.badges.ai")}</span>}
                  </div>
                </td>
                <td data-label={t("specView.columns.discipline")}>
                  <select
                    className="spec-select"
                    value={i.discipline ?? ""}
                    title={i.discipline ? `${i.discipline} · ${submittalDisciplineLabel(i.discipline, i18n.language)}` : "—"}
                    onChange={(e) => edit(i.id, { discipline: (e.target.value || null) as SubmittalDisciplineCode | null })}
                  >
                    <option value="">—</option>
                    {SUBMITTAL_DISCIPLINES.map((d) => (
                      <option key={d.code} value={d.code}>
                        {d.code} · {submittalDisciplineLabel(d.code, i18n.language)}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="small" data-label={t("specView.columns.requirement")}>
                  <input
                    className="spec-desc-input"
                    value={i.description}
                    onChange={(e) => edit(i.id, { description: e.target.value.slice(0, 300) })}
                  />
                  <div className="spec-excerpt">“{i.excerpt}”</div>
                </td>
                <td className="pc-inline" data-label={t("specView.columns.included")} style={{ textAlign: "center" }}>
                  <input
                    type="checkbox"
                    checked={!i.excluded}
                    onChange={(e) => edit(i.id, { excluded: !e.target.checked })}
                    style={{ width: "auto" }}
                  />
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  {t("specView.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
