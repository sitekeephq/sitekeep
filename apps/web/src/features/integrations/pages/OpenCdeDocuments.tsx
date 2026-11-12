/**
 * OpenCDE Documents API pages (outside the app shell, docs/features/OPENCDE.md). An authoring tool (AEC
 * Pilot, Solibri …) opens one of them in the browser:
 *   /opencde/upload?key=…  "Dış Uygulamadan Yükleme": target folder, names (checked live against
 *                          the naming standard), Revizyon, Durum / Uygunluk, Açıklama, attributes
 *   /opencde/select?key=…  "Dış Uygulama İçin Belge Seç": folders, search, multi-select
 * When the user finishes (or cancels), the browser goes back to the application's callback.
 */
import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import {
  OPENCDE_REVISION_KEY,
  OPENCDE_SUITABILITY_KEY,
  suitabilityOptions,
  splitExtension,
  validateName,
  type OpenCdeDocumentRowDto,
  type OpenCdeFolderDto,
  type OpenCdeSessionDto,
  type OpenCdeUploadRulesDto,
  type ProjectDto,
} from "@sitekeep/shared";
import { api, ApiError } from "../../../shared/api/api";
import { opencdeApi } from "../../../shared/api/api-opencde";
import { useAuth } from "../../../app/context/auth";
import { i18n } from "../../../i18n";
import { editionName } from "../../../app/brand";
import { BrandMark } from "../../../shared/ui/BrandMark";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";


function useSession() {
  const location = useLocation();
  const key = useMemo(() => new URLSearchParams(location.search).get("key") ?? "", [location.search]);
  const [session, setSession] = useState<OpenCdeSessionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const framed = window.top !== window.self;
  useEffect(() => {
    if (framed) return;
    if (!key) {
      setError(i18n.t("integrations:opencde.errors.missingKey"));
      return;
    }
    opencdeApi.session(key).then(setSession, (e: Error) => setError(e.message));
    api.projects().then(setProjects, () => undefined);
  }, [key, framed]);
  return { key, session, error, setError, projects, framed };
}

/** Back to the application: the browser leaves the CDE. */
function Returning({ client }: { client: string }) {
  const { t } = useTranslation("integrations");
  return (
    <>
      <h1 className="consent-title">{t("opencde.returning.title")}</h1>
      <p className="muted small">{t("opencde.returning.description", { client })}</p>
    </>
  );
}

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="login">
      <div className="card consent opencde-page">
        <div className="brand" style={{ marginBottom: 12, fontSize: 18 }}>
          <BrandMark /> {editionName()} · {title}
        </div>
        {children}
      </div>
    </div>
  );
}

function SessionState({ s, framed, error }: { s: OpenCdeSessionDto | null; framed: boolean; error: string | null }) {
  const t = i18n.getFixedT(null, "integrations");
  if (framed) return <p className="error">{t("framed")}</p>;
  if (error && !s)
    return (
      <>
        <h1 className="consent-title">{t("opencde.failed.title")}</h1>
        <p className="error">{error}</p>
      </>
    );
  if (!s) return <LoadingIndicator />;
  if (s.status !== "pending")
    return (
      <>
        <h1 className="consent-title">{t("opencde.done.title")}</h1>
        <p className="muted small">{t("opencde.done.description")}</p>
      </>
    );
  return null;
}

/** Folder options with their path; `only` filters (upload: writable folders). */
function FolderSelect(props: { folders: OpenCdeFolderDto[]; value: string; onChange: (id: string) => void; only?: (f: OpenCdeFolderDto) => boolean }) {
  const { t } = useTranslation("integrations");
  const list = props.only ? props.folders.filter(props.only) : props.folders;
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.target.value)} style={{ width: "100%" }}>
      <option value="">{t("opencde.options.selectFolder")}</option>
      {list.map((f) => (
        <option key={f.id} value={f.id}>
          {f.path}
        </option>
      ))}
    </select>
  );
}

// ---- Upload ----------------------------------------------------------------------------------------

export function OpenCdeUploadPage() {
  const { t, i18n: { language } } = useTranslation(["integrations", "common"]);
  const { user } = useAuth();
  const { key, session: s, error, setError, projects, framed } = useSession();
  const [projectId, setProjectId] = useState("");
  const [folders, setFolders] = useState<OpenCdeFolderDto[]>([]);
  const [folderId, setFolderId] = useState("");
  const [rules, setRules] = useState<OpenCdeUploadRulesDto | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [revision, setRevision] = useState("");
  const [suitability, setSuitability] = useState("");
  const [comment, setComment] = useState("");
  const [attrs, setAttrs] = useState<Record<string, string>>({});
  const [fileErrors, setFileErrors] = useState<Record<string, string[]>>({});
  const [attrErrors, setAttrErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const newFiles = s?.files.filter((f) => !f.existing) ?? [];
  const onlyVersions = !!s && s.files.length > 0 && newFiles.length === 0;

  useEffect(() => {
    if (!s) return;
    const existing = s.files.find((f) => f.existing)?.existing;
    setProjectId(existing?.projectId ?? s.context.projectId ?? "");
    setNames(Object.fromEntries(s.files.map((f) => [f.id, f.targetName ?? f.fileName])));
  }, [s]);

  useEffect(() => {
    setFolders([]);
    setRules(null);
    if (!projectId || !key) return;
    opencdeApi.folders(key, projectId).then((list) => {
      setFolders(list);
      const preferred = s?.context.projectId === projectId ? s.context.folderId : null;
      setFolderId(list.find((f) => f.id === preferred && f.canUpload)?.id ?? "");
    }, (e: Error) => setError(e.message));
  }, [projectId, key, s, setError]);

  useEffect(() => {
    setRules(null);
    if (!projectId || !folderId) return;
    opencdeApi.rules(key, projectId, folderId).then(setRules, (e: Error) => setError(e.message));
  }, [key, projectId, folderId, setError]);

  const defNames = new Set(rules?.attributes.map((a) => a.name) ?? []);
  const liveProblems = (id: string): string[] => {
    const f = s?.files.find((x) => x.id === id);
    if (!f || f.existing) return [];
    const name = names[id]?.trim() ?? "";
    const out: string[] = [];
    if (!name) out.push(t("opencde.upload.errors.emptyName"));
    else if (splitExtension(name).extension.toLowerCase() !== splitExtension(f.fileName).extension.toLowerCase())
      out.push(t("opencde.upload.errors.keepExtension", { ext: splitExtension(f.fileName).extension }));
    if (name && rules?.standard) out.push(...validateName(rules.standard, name, i18n.language).errors);
    return out;
  };
  const anyProblem = newFiles.some((f) => liveProblems(f.id).length > 0);
  const canSend = !!s && !!projectId && (onlyVersions || !!folderId) && !anyProblem && !rules?.gateMessage && !busy;

  async function send() {
    if (!s) return;
    setBusy(true);
    setError(null);
    setFileErrors({});
    setAttrErrors([]);
    try {
      const { redirectTo } = await opencdeApi.upload(key, {
        projectId,
        folderId: folderId || (s.files.find((f) => f.existing)?.existing?.folderId ?? ""),
        comment,
        revision: defNames.has(OPENCDE_REVISION_KEY) ? null : revision,
        suitability: defNames.has(OPENCDE_SUITABILITY_KEY) ? null : suitability,
        attributes: attrs,
        names,
      });
      setDone(true);
      window.location.replace(redirectTo);
    } catch (e) {
      const details = e instanceof ApiError ? (e.body as { details?: { files?: Record<string, string[]>; attributes?: string[] } } | null)?.details : null;
      setFileErrors(details?.files ?? {});
      setAttrErrors(details?.attributes ?? []);
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      const { redirectTo } = await opencdeApi.cancel(key);
      setDone(true);
      window.location.replace(redirectTo);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const state = SessionState({ s, framed, error });
  return (
    <Frame title={t("opencde.upload.frameTitle")}>
      {state ??
        (done ? (
          <Returning client={s!.client.name} />
        ) : (
          <>
            <h1 className="consent-title">
              <Trans
                t={t}
                i18nKey="opencde.upload.request"
                count={s!.files.length}
                values={{ client: s!.client.name, count: s!.files.length }}
                components={{ b: <strong /> }}
              />
            </h1>
            <p className="muted small">
              <Trans t={t} i18nKey="opencde.upload.intro" values={{ name: user?.name, target: s!.callbackTarget }} components={{ b: <strong /> }} />
            </p>

            <label className="field">
              <span>{t("common:fields.project")}</span>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={onlyVersions} style={{ width: "100%" }}>
                <option value="">{t("opencde.options.selectProject")}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </select>
            </label>
            {!onlyVersions && (
              <label className="field">
                <span>{t("opencde.upload.fields.targetFolder")}</span>
                <FolderSelect folders={folders} value={folderId} onChange={setFolderId} only={(f) => f.canUpload} />
                {projectId && folders.length > 0 && !folders.some((f) => f.canUpload) && (
                  <span className="error small">{t("opencde.upload.noWritable")}</span>
                )}
              </label>
            )}
            {rules?.gateMessage && <p className="error small">{rules.gateMessage}</p>}
            {rules && !onlyVersions && (
              <p className="muted small">{rules.standard ? t("opencde.upload.standard", { name: rules.standard.name }) : t("opencde.upload.noStandard")}</p>
            )}

            <table className="table small phone-cards" style={{ width: "100%", marginBottom: 12 }}>
              <thead>
                <tr>
                  <th>{t("opencde.upload.columns.incoming")}</th>
                  <th>{t("opencde.upload.columns.cdeName")}</th>
                </tr>
              </thead>
              <tbody>
                {s!.files.map((f) => {
                  const problems = [...new Set([...liveProblems(f.id), ...(fileErrors[f.id] ?? [])])];
                  return (
                    <tr key={f.id}>
                      <td className="pc-title">{f.fileName}</td>
                      <td data-label={t("opencde.upload.columns.cdeName")}>
                        {f.existing ? (
                          <span>
                            {f.existing.name} <span className="muted">
                              · {t("opencde.upload.newVersion", { version: f.existing.version + 1 })} · {f.existing.folderPath}
                            </span>
                          </span>
                        ) : (
                          <input
                            value={names[f.id] ?? ""}
                            onChange={(e) => setNames({ ...names, [f.id]: e.target.value })}
                            style={{ width: "100%" }}
                            aria-invalid={problems.length > 0}
                          />
                        )}
                        {f.existingError && <div className="error">{f.existingError}</div>}
                        {problems.map((p) => (
                          <div key={p} className="error">
                            {p}
                          </div>
                        ))}
                        {!f.existing && problems.length === 0 && rules?.standard && <div className="muted">{t("opencde.upload.matches")}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="row wrap" style={{ gap: 12 }}>
              {!defNames.has(OPENCDE_REVISION_KEY) && (
                <label className="field" style={{ flex: "1 1 140px" }}>
                  <span>{t("opencde.upload.fields.revision")}</span>
                  <input value={revision} onChange={(e) => setRevision(e.target.value)} placeholder={t("opencde.upload.placeholder.revision")} />
                </label>
              )}
              {!defNames.has(OPENCDE_SUITABILITY_KEY) && (
                <label className="field" style={{ flex: "1 1 200px" }}>
                  <span>{t("opencde.upload.fields.suitability")}</span>
                  <select value={suitability} onChange={(e) => setSuitability(e.target.value)}>
                    <option value="">{t("opencde.options.notSelected")}</option>
                    {suitabilityOptions(language).map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {rules?.attributes.map((d) => (
              <label key={d.id} className="field">
                <span>
                  {d.name}
                  {d.required && " *"}
                </span>
                {d.type === "list" ? (
                  <select value={attrs[d.name] ?? ""} onChange={(e) => setAttrs({ ...attrs, [d.name]: e.target.value })}>
                    <option value="">{t("opencde.options.notSelected")}</option>
                    {d.options.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={d.type === "date" ? "date" : d.type === "number" ? "number" : "text"}
                    value={attrs[d.name] ?? ""}
                    onChange={(e) => setAttrs({ ...attrs, [d.name]: e.target.value })}
                  />
                )}
              </label>
            ))}
            <label className="field">
              <span>{t("common:fields.description")}</span>
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder={t("opencde.upload.placeholder.comment")} />
            </label>
            {attrErrors.map((m) => (
              <p key={m} className="error small">
                {m}
              </p>
            ))}
            {error && <p className="error small">{error}</p>}
            <div className="dialog-actions">
              <button disabled={busy} onClick={() => void cancel()}>
                {t("opencde.actions.cancel")}
              </button>
              <button className="primary" disabled={!canSend} onClick={() => void send()}>
                {t("opencde.actions.startUpload")}
              </button>
            </div>
            <p className="muted small" style={{ marginBottom: 0 }}>
              {t("opencde.upload.footnote")}
            </p>
          </>
        ))}
    </Frame>
  );
}

// ---- Select ----------------------------------------------------------------------------------------

export function OpenCdeSelectPage() {
  const { t } = useTranslation(["integrations", "common"]);
  const { key, session: s, error, setError, projects, framed } = useSession();
  const [projectId, setProjectId] = useState("");
  const [folders, setFolders] = useState<OpenCdeFolderDto[]>([]);
  const [folderId, setFolderId] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<OpenCdeDocumentRowDto[]>([]);
  const [selected, setSelected] = useState<Map<string, OpenCdeDocumentRowDto>>(new Map());
  const [onlyPreferred, setOnlyPreferred] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (s) setProjectId(s.context.projectId ?? "");
  }, [s]);

  useEffect(() => {
    setFolders([]);
    setRows([]);
    setSelected(new Map());
    if (!projectId || !key) return;
    opencdeApi.folders(key, projectId).then((list) => {
      setFolders(list);
      const preferred = s?.context.projectId === projectId ? s.context.folderId : null;
      setFolderId(list.find((f) => f.id === preferred)?.id ?? "");
    }, (e: Error) => setError(e.message));
  }, [projectId, key, s, setError]);

  useEffect(() => {
    if (!projectId || (!folderId && query.trim().length < 2)) {
      setRows([]);
      return;
    }
    const t = setTimeout(() => {
      opencdeApi.documents(key, projectId, { folderId: folderId || undefined, q: query.trim() || undefined }).then(setRows, (e: Error) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [key, projectId, folderId, query, setError]);

  const exts = s?.supportedExtensions ?? [];
  const shown = onlyPreferred && exts.length ? rows.filter((r) => exts.some((e) => r.name.toLowerCase().endsWith(e))) : rows;
  const depth = (f: OpenCdeFolderDto) => f.path.split(" / ").length - 1;

  function toggle(r: OpenCdeDocumentRowDto) {
    const next = new Map(selected);
    if (next.has(r.versionId)) next.delete(r.versionId);
    else next.set(r.versionId, r);
    setSelected(next);
  }

  async function finish(cancelled: boolean) {
    setBusy(true);
    setError(null);
    try {
      const { redirectTo } = cancelled ? await opencdeApi.cancel(key) : await opencdeApi.select(key, projectId, [...selected.keys()]);
      setDone(true);
      window.location.replace(redirectTo);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const state = SessionState({ s, framed, error });
  return (
    <Frame title={t("opencde.select.frameTitle")}>
      {state ??
        (done ? (
          <Returning client={s!.client.name} />
        ) : (
          <>
            <h1 className="consent-title">
              <Trans t={t} i18nKey="opencde.select.request" values={{ client: s!.client.name }} components={{ b: <strong /> }} />
            </h1>
            <p className="muted small">{t("opencde.select.description")}</p>
            <label className="field">
              <span>{t("common:fields.project")}</span>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: "100%" }}>
                <option value="">{t("opencde.options.selectProject")}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </select>
            </label>
            {projectId && (
              <div className="row" style={{ gap: 12, alignItems: "stretch" }}>
                <div style={{ flex: "0 0 40%", maxHeight: 320, overflow: "auto", borderRight: "1px solid var(--border)" }}>
                  {folders.map((f) => (
                    <button
                      key={f.id}
                      className={`link-button small${f.id === folderId ? " active" : ""}`}
                      style={{ display: "block", textAlign: "left", paddingLeft: 4 + depth(f) * 12, fontWeight: f.id === folderId ? 600 : 400 }}
                      onClick={() => setFolderId(f.id)}
                    >
                      {f.name}
                    </button>
                  ))}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("opencde.select.placeholder")} style={{ width: "100%", marginBottom: 8 }} />
                  {exts.length > 0 && (
                    <label className="small row" style={{ gap: 6, marginBottom: 6 }}>
                      <input type="checkbox" checked={onlyPreferred} onChange={(e) => setOnlyPreferred(e.target.checked)} />
                      {t("opencde.select.options.onlyExts", { exts: exts.join(", ") })} {/* ui-terms-ok: Title Case around the {{exts}} placeholder */}
                    </label>
                  )}
                  <div style={{ maxHeight: 280, overflow: "auto" }}>
                    {shown.length === 0 && <p className="muted small">{folderId || query ? t("opencde.select.empty") : t("opencde.select.pickFolder")}</p>}
                    {shown.map((r) => (
                      <label key={r.versionId} className="small" style={{ display: "flex", gap: 6, padding: "4px 0", alignItems: "flex-start" }}>
                        <input type="checkbox" checked={selected.has(r.versionId)} onChange={() => toggle(r)} />
                        <span>
                          {r.name} <span className="muted">· V{r.version}</span>
                          {query && <div className="muted">{r.folderPath}</div>}
                          {!r.canDownload && <div className="muted">{t("opencde.select.noDownload")}</div>}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {error && <p className="error small">{error}</p>}
            <div className="dialog-actions">
              <button disabled={busy} onClick={() => void finish(true)}>
                {t("opencde.actions.cancel")}
              </button>
              <button className="primary" disabled={busy || selected.size === 0} onClick={() => void finish(false)}>
                {selected.size ? t("opencde.actions.sendSelectionCount", { n: selected.size }) : t("opencde.actions.sendSelection")}
              </button>
            </div>
          </>
        ))}
    </Frame>
  );
}
