import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { type FileDto, type WorkflowTemplateDto } from "@sitekeep/shared";
import { i18n, label } from "../../../i18n";
import { api, type ReviewPreview } from "../../../shared/api/api";
import { documentsApi } from "../api";
import { useLoad } from "../../../app/context/project";
import { Dialog } from "../../../shared/ui/Dialog";
import { FolderTree } from "./FolderTree";

function withDays(name: string, days: number | null | undefined): string {
  return days ? i18n.t("documents:startReview.stageDays", { name, count: days }) : name;
}

function stageText(tpl: WorkflowTemplateDto): string {
  const stages = tpl.chain?.stages;
  if (!stages?.length) return tpl.steps.map((s, i) => `${i + 1}. ${withDays(s.name, s.days)}`).join(" → ");
  const origin = tpl.chain.originParty ? [label("reviewParty", tpl.chain.originParty)] : [];
  return [...origin, ...stages.map((s) => withDays(s.name || label("reviewParty", s.party), s.days))].join(" → ");
}

/** Starts a document review on the current versions of the selected files. */
export function StartReviewDialog({
  projectId,
  rootFolderId,
  files,
  onClose,
  onStarted,
}: {
  projectId: string;
  rootFolderId: string;
  files: FileDto[];
  onClose(): void;
  onStarted(): void;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const navigate = useNavigate();
  const { data: templates, error: tplError } = useLoad(() => api.workflowTemplates(projectId, "review"), [projectId]);
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState(files.length === 1 ? files[0]!.name : "");
  const [note, setNote] = useState("");
  const [copy, setCopy] = useState(false);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [pattern, setPattern] = useState("");
  const [fallback, setFallback] = useState(false);
  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: target } = useLoad(
    () => (targetId ? documentsApi.folder(projectId, targetId) : Promise.resolve(null)),
    [projectId, targetId],
  );
  const template = templates?.find((tpl) => tpl.id === (templateId || templates[0]?.id));
  const numbered = !!template?.chain?.namePattern;

  // The template's copy rule is the default; the starter can change it.
  useEffect(() => {
    const rule = template?.chain?.copyTarget;
    setCopy(!!rule?.folderId);
    setTargetId(rule?.folderId ?? null);
    setPattern(rule?.pattern ?? "");
    setFallback(rule?.onUnresolved === "base");
  }, [template?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const input = template
    ? {
        name: name.trim() || null,
        note: note || null,
        templateId: template.id,
        versionIds: files.map((f) => f.latest.id),
        targetFolderId: copy ? targetId : null,
        targetPattern: copy ? pattern.trim() || null : null,
        targetFallback: fallback,
      }
    : null;
  const inputKey = JSON.stringify(input);

  // Preview: number, attribute-resolved assignees, per-file copy path and problems.
  useEffect(() => {
    if (!input) return;
    let live = true;
    const timer = setTimeout(() => {
      api
        .previewReview(projectId, input)
        .then((p) => live && setPreview(p))
        .catch(() => live && setPreview(null));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [inputKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    if (!input) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api.startReview(projectId, input);
      onStarted();
      onClose();
      navigate(`/projects/${projectId}/reviews/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const resolvedSteps = preview?.steps.filter((s) => s.resolvedBy) ?? [];

  return (
    <Dialog title={t("startReview.title")} onClose={onClose} wide>
      <div className="muted small">
        {t("startReview.pinned", { count: files.length, files: files.map((f) => `${f.name} (V${f.currentVersion})`).join(", ") })}
      </div>
      <label>{t("startReview.fields.template")}</label>
      {tplError && <p className="error">{tplError}</p>}
      {templates?.length === 0 ? (
        <p className="notice">{t("startReview.noTemplates")}</p>
      ) : (
        <select value={template?.id ?? ""} onChange={(e) => setTemplateId(e.target.value)}>
          {templates?.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.name}
            </option>
          ))}
        </select>
      )}
      {template && (
        <div className="small muted" style={{ marginTop: 4 }}>
          {stageText(template)}
        </div>
      )}
      <label>{numbered ? t("startReview.fields.subject") : t("startReview.fields.name")}</label>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("startReview.namePlaceholder")} />
      {numbered && (
        <div className="small" style={{ marginTop: 4 }}>
          <Trans
            t={t}
            i18nKey="startReview.number"
            values={{ code: preview?.code ?? template!.chain.namePattern }}
            components={{ b: <strong className="mono" />, m: <span className="muted" /> }}
          />
        </div>
      )}
      {resolvedSteps.length > 0 && (
        <div className="small muted" style={{ marginTop: 4 }}>
          {resolvedSteps.map((s) => `${s.name}: ${s.resolvedBy!.attribute} = ${s.resolvedBy!.values.join(", ")}`).join(" · ")}
        </div>
      )}
      <label>{t("startReview.fields.note")}</label>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} style={{ minHeight: 60 }} />
      <label className="row" style={{ color: "var(--text)", fontSize: 13 }}>
        <input type="checkbox" style={{ width: "auto" }} checked={copy} onChange={(e) => setCopy(e.target.checked)} />
        {t("startReview.options.copy")}
      </label>
      {copy && (
        <>
          <div className="row" style={{ alignItems: "stretch", gap: 12 }}>
            <div className="card" style={{ flex: 1, maxHeight: 260, overflow: "auto", padding: "8px 0" }}>
              <FolderTree
                projectId={projectId}
                rootId={rootFolderId}
                activeId={targetId ?? rootFolderId}
                version={0}
                onSelect={setTargetId}
              />
            </div>
            <div style={{ width: 280 }} className="small">
              <div className="muted">{t("startReview.fields.target")}</div>
              <strong>{target ? target.path.map((p) => p.name).join(" / ") : t("startReview.notSelected")}</strong>
              {target && !target.canUpload && <p className="error">{t("startReview.errors.noUpload")}</p>}
              <label>{t("startReview.fields.pattern")}</label>
              <input className="mono" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder={t("startReview.patternPlaceholder")} />
              <label className="row" style={{ color: "var(--text)", fontSize: 12 }}>
                <input type="checkbox" style={{ width: "auto" }} checked={fallback} onChange={(e) => setFallback(e.target.checked)} />
                {t("startReview.options.fallback")}
              </label>
              <p className="muted">
                {t("startReview.patternHelp")}
              </p>
            </div>
          </div>
          {pattern.trim() && preview && (
            <div className="card" style={{ padding: 0, marginTop: 8, maxHeight: 180, overflow: "auto" }}>
              <table className="phone-cards">
                <tbody>
                  {preview.files.map((f) => (
                    <tr key={f.versionId}>
                      <td className="small pc-title">{f.name}</td>
                      <td className="small" data-label={t("startReview.columns.target")}>
                        {f.targetPath ?? <span className="error">{t("startReview.notCopied")}</span>}
                        {f.unresolved.length > 0 && (
                          <span className="error"> · {t("startReview.missing", { fields: f.unresolved.map((u) => `{${u}}`).join(", ") })}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {preview && !preview.ok && (
        <div className="notice" style={{ marginTop: 8 }}>
          {preview.problems.map((p, i) => (
            <div key={i}>{p}</div>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button onClick={onClose}>{t("common:actions.cancel")}</button>
        <button
          className="primary"
          disabled={busy || !template || (!numbered && !name.trim()) || (copy && (!targetId || !target?.canUpload))}
          onClick={() => void start()}
        >
          {t("startReview.actions.start")}
        </button>
      </div>
    </Dialog>
  );
}
