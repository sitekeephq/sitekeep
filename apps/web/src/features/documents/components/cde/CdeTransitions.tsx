/**
 * ISO 19650 state transitions in the documents UI (docs/features/CDE_STATES.md "Transitions"):
 *   CdeStatusBadge        Returned / Superseded / Withdrawn beside the codes
 *   useCdeFlow            the project's transition settings and the top folder of each state
 *   nextReviewStep        WIP → Shared ("Send to Shared"), Shared → Published ("Publish")
 *   FileTransitionPanel   the file drawer actions: send / publish, administrator override
 */
import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_CDE_TRANSITIONS,
  type CdeFileStatus,
  type CdeSettingsDto,
  type CdeState,
  type CdeTransitionDto,
  type FileDto,
  type FolderDto,
} from "@sitekeep/shared";
import { ProjectContext, useLoad } from "../../../../app/context/project";
import { cdeApi } from "../../../../shared/api/api-cde";
import { Dialog } from "../../../../shared/ui/Dialog";
import { documentsApi } from "../../api";
import { FolderTree } from "../FolderTree";
import { StartReviewDialog } from "../StartReviewDialog";
import type { FileCdeSlotProps } from "./FileCdeSlots";

const STATUS_TONE: Record<CdeFileStatus, string> = { returned: "warn", superseded: "", withdrawn: "danger" };

/** The status flag of a document (ISO-1); nothing when it has none. */
export function CdeStatusBadge({ status }: { status: CdeFileStatus | null | undefined }) {
  const { t } = useTranslation("cde");
  if (!status) return null;
  return (
    <span className={`badge ${STATUS_TONE[status]}`} data-testid="cde-status" title={t(`statusHints.${status}`)}>
      {t(`statuses.${status}`)}
    </span>
  );
}

/** The table that applies: the project's, or the ISO 19650 default when it enforces an empty one. */
export function effectiveTransitions(s: CdeSettingsDto | null | undefined): readonly CdeTransitionDto[] {
  if (!s) return [];
  return s.transitions.length || !s.enforceTransitions ? s.transitions : DEFAULT_CDE_TRANSITIONS;
}

/** The state of a folder from its path (its own, else the nearest ancestor's). */
export function stateOfPath(path: readonly Pick<FolderDto, "state">[] | undefined): CdeState | null {
  for (const f of [...(path ?? [])].reverse()) if (f.state) return f.state as CdeState;
  return null;
}

export interface ReviewStep {
  fromState: CdeState;
  toState: CdeState;
  workflowTemplateId: string | null;
  /** Top folder of the target state (the review's copy target). */
  targetFolderId: string | null;
}

const NEXT: Partial<Record<CdeState, CdeState>> = { wip: "shared", shared: "published" };

/** The review that takes a document in `state` one step further, when the table has one. */
export function nextReviewStep(
  settings: CdeSettingsDto | null | undefined,
  roots: Partial<Record<CdeState, string>>,
  state: CdeState | null,
): ReviewStep | null {
  const toState = state ? NEXT[state] : undefined;
  if (!state || !toState) return null;
  const t = effectiveTransitions(settings).find((x) => x.fromState === state && x.toState === toState && x.mode === "review");
  if (!t) return null;
  return { fromState: state, toState, workflowTemplateId: t.workflowTemplateId, targetFolderId: roots[toState] ?? null };
}

/** Transition settings and the first folder of each state below the project root. */
export function useCdeFlow(projectId: string, rootFolderId: string | null | undefined) {
  const { data: settings, reload } = useLoad(() => cdeApi.settings(projectId).catch(() => null), [projectId]);
  const { data: root } = useLoad(
    () => (rootFolderId ? documentsApi.contents(projectId, rootFolderId).catch(() => null) : Promise.resolve(null)),
    [projectId, rootFolderId],
  );
  const roots: Partial<Record<CdeState, string>> = {};
  for (const f of root?.folders ?? []) if (f.state && !roots[f.state as CdeState]) roots[f.state as CdeState] = f.id;
  return { settings: settings ?? null, roots, reload };
}

/** Button text of a review step: "Send to Shared" / "Publish". */
export function stepLabelKey(step: ReviewStep): "transitions.sendToShared" | "transitions.publish" {
  return step.toState === "published" ? "transitions.publish" : "transitions.sendToShared";
}

/** File drawer: send the document one state further through review; the administrator override. */
export function FileTransitionPanel({ projectId, file, onChanged }: FileCdeSlotProps) {
  const { t } = useTranslation("cde");
  const project = useContext(ProjectContext);
  const rootFolderId = project?.rootFolderId ?? null;
  const { settings, roots } = useCdeFlow(projectId, rootFolderId);
  const { data: folder } = useLoad(() => documentsApi.folder(projectId, file.folderId).catch(() => null), [projectId, file.folderId]);
  const [dialog, setDialog] = useState<"review" | "override" | null>(null);
  const state = stateOfPath(folder?.path ?? (folder ? [folder] : undefined));
  const step = nextReviewStep(settings, roots, state);
  const isAdmin = !!project?.isProjectAdmin;
  if (!state && !isAdmin) return null;
  if (!step && !(isAdmin && settings?.enforceTransitions)) return null;
  return (
    <div className="file-transitions" data-testid="file-transitions">
      <div className="row wrap">
        <h3 style={{ margin: 0 }}>{t("transitions.heading")}</h3>
        <div className="spacer" />
        {step && (
          <button className="small primary" data-testid="cde-send" onClick={() => setDialog("review")}>
            {t(stepLabelKey(step))}
          </button>
        )}
        {isAdmin && settings?.enforceTransitions && (
          <button className="small" data-testid="cde-override" onClick={() => setDialog("override")}>
            {t("transitions.override.open")}
          </button>
        )}
      </div>
      {state && (
        <p className="muted small" style={{ margin: 0 }}>
          {step ? t("transitions.next", { from: t(`states.${step.fromState}`), to: t(`states.${step.toState}`) }) : t(`states.${state}`)}
        </p>
      )}
      {dialog === "review" && step && rootFolderId && (
        <StartReviewDialog
          projectId={projectId}
          rootFolderId={rootFolderId}
          files={[file]}
          transition={step}
          onClose={() => setDialog(null)}
          onStarted={onChanged}
        />
      )}
      {dialog === "override" && rootFolderId && (
        <OverrideDialog projectId={projectId} rootFolderId={rootFolderId} file={file} onClose={() => setDialog(null)} onDone={onChanged} />
      )}
    </div>
  );
}

/** Administrator override: move the file into any folder, with a reason (audited as cde.override). */
function OverrideDialog({
  projectId,
  rootFolderId,
  file,
  onClose,
  onDone,
}: {
  projectId: string;
  rootFolderId: string;
  file: FileDto;
  onClose(): void;
  onDone(): void;
}) {
  const { t } = useTranslation(["cde", "common"]);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: target } = useLoad(
    () => (targetId ? documentsApi.folder(projectId, targetId).catch(() => null) : Promise.resolve(null)),
    [projectId, targetId],
  );
  const toState = stateOfPath(target?.path);

  async function save() {
    if (!targetId) return;
    setBusy(true);
    setError(null);
    try {
      await cdeApi.overrideTransition(projectId, file.id, { toFolderId: targetId, reason: reason.trim() });
      onDone();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t("transitions.override.title", { name: file.name })} onClose={onClose} wide>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("transitions.override.description")}
      </p>
      <div className="card" style={{ maxHeight: 260, overflow: "auto", padding: "8px 0" }}>
        <FolderTree projectId={projectId} rootId={rootFolderId} activeId={targetId ?? rootFolderId} version={0} onSelect={setTargetId} />
      </div>
      <div className="small" style={{ marginTop: 6 }}>
        <span className="muted">{t("transitions.override.target")} </span>
        <strong>{target ? target.path.map((p) => p.name).join(" / ") : "—"}</strong>
        {toState && <span className="badge info" style={{ marginLeft: 6 }}>{t(`states.${toState}`)}</span>}
      </div>
      <label htmlFor="cde-override-reason">{t("transitions.override.reason")}</label>
      <textarea id="cde-override-reason" value={reason} onChange={(e) => setReason(e.target.value)} style={{ minHeight: 60 }} />
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button onClick={onClose}>{t("common:actions.cancel")}</button>
        <button className="primary" disabled={busy || !targetId || targetId === file.folderId || !reason.trim()} onClick={() => void save()}>
          {t("transitions.override.save")}
        </button>
      </div>
    </Dialog>
  );
}
