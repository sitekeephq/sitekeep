/**
 * BCF (.bcfzip) for Sorunlar (docs/features/BCF.md): "BCF Olarak Dışa Aktar" (2.1 default, or 3.0) and the
 * "BCF İçe Aktar" wizard: file → preview (new / update / unchanged / conflict per topic, value
 * mappings) → result.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type BcfImportMapping,
  type BcfImportPreview,
  type BcfImportResult,
  type BcfImportState,
  type BcfVersion,
  type IssuePriority,
  type IssueStatus,
} from "@sitekeep/shared";
import { api, intlLocale } from "../../../shared/api/api";
import { useLoad, useProject } from "../../../app/context/project";
import { Dialog } from "../../../shared/ui/Dialog";
import { useLabel } from "../../../i18n";

const PRIORITIES: IssuePriority[] = ["low", "normal", "high", "critical"];
const STATUSES: IssueStatus[] = ["open", "in_progress", "in_review", "closed"];
const STATE_CLASS: Record<BcfImportState, string> = { new: "ok", update: "info", unchanged: "", conflict: "warn" };

export function BcfExportDialog({
  ids,
  status,
  count,
  onClose,
}: {
  /** Selected issues; none = every issue of the current filter. */
  ids?: string[];
  status?: string;
  count: number;
  onClose(): void;
}) {
  const { t } = useTranslation(["coordination", "common"]);
  const project = useProject();
  const [version, setVersion] = useState<BcfVersion>("2.1");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      setWarnings(await api.bcfExport(project.id, { version, ids, status: ids?.length ? undefined : status }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t("bcfExport.title")} onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>
        {ids?.length ? t("bcfExport.descriptionSelected", { count }) : t("bcfExport.descriptionList", { count })}
      </p>
      <label className="check">
        <input type="radio" name="bcf-version" checked={version === "2.1"} onChange={() => setVersion("2.1")} /> {t("bcfExport.options.v21")}
      </label>
      <p className="muted small" style={{ margin: "0 0 0 24px" }}>
        {t("bcfExport.v21Hint")}
      </p>
      <label className="check">
        <input type="radio" name="bcf-version" checked={version === "3.0"} onChange={() => setVersion("3.0")} /> BCF 3.0
      </label>
      {warnings && (
        <div className="small" style={{ marginTop: 8 }}>
          <p style={{ margin: "4px 0" }}>{t("bcfExport.messages.downloaded")}</p>
          {warnings.map((w) => (
            <p key={w} className="muted" style={{ margin: "4px 0" }}>
              {w}
            </p>
          ))}
        </div>
      )}
      {err && <p className="error">{err}</p>}
      <div className="dialog-actions" style={{ marginTop: 12 }}>
        <button onClick={onClose}>{warnings ? t("common:actions.close") : t("common:actions.cancel")}</button>
        <button className="primary" disabled={busy || !count} onClick={() => void run()}>
          {busy ? t("bcfExport.status.preparing") : t("bcfExport.actions.export")}
        </button>
      </div>
    </Dialog>
  );
}

export function BcfImportDialog({ onClose, onImported }: { onClose(): void; onImported(): void }) {
  const { t } = useTranslation(["coordination", "common"]);
  const label = useLabel();
  const project = useProject();
  const { data: members } = useLoad(() => api.members(project.id), [project.id]);
  const { data: models } = useLoad(() => api.models(project.id), [project.id]);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BcfImportPreview | null>(null);
  const [result, setResult] = useState<BcfImportResult | null>(null);
  const [mapping, setMapping] = useState<Required<Omit<BcfImportMapping, "topics" | "conflicts">>>({ statuses: {}, types: {}, priorities: {}, users: {}, files: {} });
  const [conflicts, setConflicts] = useState<"keep" | "overwrite">("keep");
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load(f: File) {
    setBusy(true);
    setErr(null);
    setPreview(null);
    try {
      const p = await api.bcfImportPreview(project.id, f);
      setPreview(p);
      setSkip(new Set());
      setMapping({
        statuses: Object.fromEntries(p.statuses.map((s) => [s.value, s.suggested])),
        types: Object.fromEntries(p.types.map((x) => [x.value, x.suggested])),
        priorities: Object.fromEntries(p.priorities.map((x) => [x.value, x.suggested])),
        users: Object.fromEntries(p.users.map((u) => [u.email, u.suggestedUserId])),
        files: Object.fromEntries(p.files.map((x) => [x.key, x.suggestedVersionId])),
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!file || !preview) return;
    setBusy(true);
    setErr(null);
    try {
      const topics = preview.topics.filter((x) => !skip.has(x.guid)).map((x) => x.guid);
      setResult(await api.bcfImport(project.id, file, { ...mapping, conflicts, topics }));
      onImported();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const counts = useMemo(() => {
    const c: Record<BcfImportState, number> = { new: 0, update: 0, unchanged: 0, conflict: 0 };
    for (const x of preview?.topics ?? []) if (!skip.has(x.guid)) c[x.state]++;
    return c;
  }, [preview, skip]);
  const selected = (preview?.topics.length ?? 0) - skip.size;
  const latestModels = (models ?? []).filter((m) => m.isLatest);
  const set = <K extends keyof typeof mapping>(k: K, key: string, v: (typeof mapping)[K][string]) => setMapping((m) => ({ ...m, [k]: { ...m[k], [key]: v } }));

  if (result) {
    return (
      <Dialog title={t("bcfImport.title")} onClose={onClose}>
        <p>
          {t("bcfImport.result", {
            created: result.created,
            updated: result.updated,
            unchanged: result.unchanged,
            skipped: result.skipped ? t("bcfImport.resultSkipped", { count: result.skipped }) : "",
            comments: result.comments,
            viewpoints: result.viewpoints,
          })}
        </p>
        {result.warnings.slice(0, 12).map((w) => (
          <p key={w} className="muted small" style={{ margin: "4px 0" }}>
            {w}
          </p>
        ))}
        <div className="dialog-actions" style={{ marginTop: 12 }}>
          <button className="primary" onClick={onClose}>
            {t("common:actions.close")}
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={t("bcfImport.title")} onClose={onClose} wide>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("bcfImport.hint")}
      </p>
      <input
        type="file"
        accept=".bcfzip,.bcf,.zip"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          setFile(f);
          if (f) void load(f);
        }}
      />
      {busy && !preview && <p className="muted small">{t("bcfImport.status.reading")}</p>}
      {preview && (
        <>
          <p className="small" style={{ marginBottom: 4 }}>
            {t(preview.projectName ? "bcfImport.summaryWithProject" : "bcfImport.summary", {
              version: preview.version,
              project: preview.projectName,
              count: preview.topics.length,
              states: (Object.keys(counts) as BcfImportState[])
                .filter((k) => counts[k])
                .map((k) => t("bcfImport.stateCount", { count: counts[k], state: label("bcfImportState", k).toLocaleLowerCase(intlLocale()) }))
                .join(", "),
            })}
          </p>
          {preview.warnings.slice(0, 6).map((w) => (
            <div key={w} className="small muted">
              {w}
            </div>
          ))}
          <div style={{ maxHeight: 220, overflow: "auto", marginTop: 8, border: "1px solid var(--border)", borderRadius: 6 }}>
            <table className="phone-cards">
              <thead>
                <tr>
                  <th style={{ width: 28 }} />
                  <th>{t("bcfImport.columns.title")}</th>
                  <th style={{ width: 130 }}>{t("bcfImport.columns.status")}</th>
                  <th style={{ width: 120 }}>{t("bcfImport.columns.import")}</th>
                  <th style={{ width: 110 }}>{t("bcfImport.columns.commentsViews")}</th>
                </tr>
              </thead>
              <tbody>
                {preview.topics.map((topic) => (
                  <tr key={topic.guid}>
                    <td className="pc-inline">
                      <input
                        type="checkbox"
                        aria-label={t("bcfImport.importTopic")}
                        checked={!skip.has(topic.guid)}
                        onChange={(e) =>
                          setSkip((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.delete(topic.guid);
                            else n.add(topic.guid);
                            return n;
                          })
                        }
                      />
                    </td>
                    <td className="pc-title">
                      {topic.existingNumber ? <span className="muted">#{topic.existingNumber} </span> : null}
                      {topic.title}
                      {topic.warnings.length > 0 && (
                        <div className="muted small" title={topic.warnings.join("\n")}>
                          {t("bcfImport.warningCount", { count: topic.warnings.length })}
                        </div>
                      )}
                    </td>
                    <td className="small" data-label={t("bcfImport.columns.status")}>
                      {topic.topicStatus || "—"}
                      {topic.topicType ? <span className="muted"> · {topic.topicType}</span> : null}
                    </td>
                    <td data-label={t("bcfImport.columns.import")}>
                      <span className={`badge ${STATE_CLASS[topic.state]}`}>{label("bcfImportState", topic.state)}</span>
                      {topic.readOnly && <div className="muted small">{t("bcfImport.commentsOnly")}</div>}
                    </td>
                    <td className="small muted" data-label={t("bcfImport.columns.commentsViews")}>
                      {topic.comments} / {topic.viewpoints}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 style={{ marginBottom: 4 }}>{t("bcfImport.mapping.title")}</h3>
          <div className="bcf-map-grid">
            {preview.statuses.map((s) => (
              <label key={`s-${s.value}`} className="small">
                {t("bcfImport.mapping.status", { value: s.value, n: s.count })}
                <select value={mapping.statuses[s.value] ?? s.suggested} onChange={(e) => set("statuses", s.value, e.target.value as IssueStatus)}>
                  {STATUSES.map((k) => (
                    <option key={k} value={k}>
                      {label("issueStatus", k)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            {preview.priorities.map((p) => (
              <label key={`p-${p.value}`} className="small">
                {t("bcfImport.mapping.priority", { value: p.value, n: p.count })}
                <select value={mapping.priorities[p.value] ?? p.suggested} onChange={(e) => set("priorities", p.value, e.target.value as IssuePriority)}>
                  {PRIORITIES.map((k) => (
                    <option key={k} value={k}>
                      {label("issuePriority", k)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            {preview.types.map((x) => (
              <label key={`t-${x.value}`} className="small">
                {t("bcfImport.mapping.type", { value: x.value, n: x.count })}
                <input
                  value={mapping.types[x.value] ?? ""}
                  placeholder={t("bcfImport.mapping.noType")}
                  maxLength={100}
                  onChange={(e) => set("types", x.value, e.target.value.trim() ? e.target.value : null)}
                />
              </label>
            ))}
            {preview.users.map((u) => (
              <label key={`u-${u.email}`} className="small">
                {t("bcfImport.mapping.person", { value: u.email, n: u.count })}
                <select value={mapping.users[u.email] ?? ""} onChange={(e) => set("users", u.email, e.target.value || null)}>
                  <option value="">{t("bcfImport.mapping.unmatched")}</option>
                  {members?.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name} ({m.email})
                    </option>
                  ))}
                </select>
              </label>
            ))}
            {preview.files.map((f) => (
              <label key={`f-${f.key}`} className="small">
                {t("bcfImport.mapping.model", { value: f.filename ?? f.ifcProject ?? "—", n: f.count })}
                <select value={mapping.files[f.key] ?? ""} onChange={(e) => set("files", f.key, e.target.value || null)}>
                  <option value="">{t("bcfImport.mapping.notLinked")}</option>
                  {[...latestModels, ...(models ?? []).filter((m) => !m.isLatest && m.id === mapping.files[f.key])].map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.fileName} · V{m.version}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <p className="muted small" style={{ margin: "6px 0" }}>
            {t("bcfImport.mapping.hint")}
          </p>
          {counts.conflict > 0 && (
            <>
              <p className="small" style={{ marginBottom: 0 }}>
                {t("bcfImport.conflicts", { count: counts.conflict })}
              </p>
              <label className="check">
                <input type="radio" name="bcf-conflict" checked={conflicts === "keep"} onChange={() => setConflicts("keep")} /> {t("bcfImport.options.keep")}
              </label>
              <label className="check">
                <input type="radio" name="bcf-conflict" checked={conflicts === "overwrite"} onChange={() => setConflicts("overwrite")} /> {t("bcfImport.options.overwrite")}
              </label>
            </>
          )}
        </>
      )}
      {err && <p className="error">{err}</p>}
      <div className="dialog-actions" style={{ marginTop: 12 }}>
        <button onClick={onClose}>{t("common:actions.cancel")}</button>
        <button className="primary" disabled={busy || !preview || !selected} onClick={() => void commit()}>
          {busy && preview ? t("bcfImport.status.importing") : selected ? t("bcfImport.actions.importCount", { n: selected }) : t("bcfImport.actions.import")}
        </button>
      </div>
    </Dialog>
  );
}
