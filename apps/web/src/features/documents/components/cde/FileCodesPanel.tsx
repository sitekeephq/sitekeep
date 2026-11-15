/**
 * Codes of a file's current version in the file drawer, and the editor for them
 * (docs/features/CDE_STATES.md "Codes"). WIP (or a folder without a state): editors change the
 * codes; Shared / Published / Archived: project administrators, with a reason (an override).
 */
import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { allowedSuitability, can, nextRevision, validateCodes, type FileVersionDto } from "@sitekeep/shared";
import { ProjectContext } from "../../../../app/context/project";
import { cdeApi } from "../../../../shared/api/api-cde";
import { Dialog } from "../../../../shared/ui/Dialog";
import { CodeChips, codeErrorText, codeHints, useFolderCodes, type FolderCodes } from "./CodeChips";
import type { FileCdeSlotProps } from "./FileCdeSlots";

export function FileCodesPanel({ projectId, file, level, onChanged }: FileCdeSlotProps) {
  const { t } = useTranslation("cde");
  const project = useContext(ProjectContext);
  const folder = useFolderCodes(projectId, file.folderId);
  const [editing, setEditing] = useState(false);
  const current = file.versions.find((v) => v.version === file.currentVersion) ?? file.latest;
  const locked = !!folder?.state && folder.state !== "wip";
  const isAdmin = !!project?.isProjectAdmin;
  const mayEdit = locked ? isAdmin : can(level, "edit") || isAdmin;
  return (
    <div className="file-codes" data-testid="file-codes">
      <div className="row">
        <h3 style={{ margin: 0 }}>{t("codes.panel.heading")}</h3>
        <div className="spacer" />
        {folder && mayEdit && (
          <button className="small" onClick={() => setEditing(true)}>
            {locked ? t("codes.panel.override") : t("codes.panel.edit")}
          </button>
        )}
      </div>
      {current.suitabilityCode || current.revisionCode ? (
        <div className="row small">
          <span className="muted">{t("codes.panel.current", { version: current.version })}</span>
          <CodeChips suitability={current.suitabilityCode} revision={current.revisionCode} />
        </div>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>
          {t("codes.panel.none")}
        </p>
      )}
      {editing && folder && (
        <CodesEditor
          projectId={projectId}
          version={current}
          history={file.versions.filter((v) => v.id !== current.id).map((v) => v.revisionCode)}
          folder={folder}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/** Edits the codes of one version under the folder's rules (checked here and on the server). */
export function CodesEditor({
  projectId,
  version,
  history,
  folder,
  onClose,
  onSaved,
}: {
  projectId: string;
  version: FileVersionDto;
  /** Revisions of the document's other versions (for the next revision). */
  history: (string | null | undefined)[];
  folder: FolderCodes;
  onClose(): void;
  onSaved(v: FileVersionDto): void;
}) {
  const { t } = useTranslation(["cde", "common"]);
  const { t: tc } = useTranslation("cde");
  const [suitability, setSuitability] = useState(version.suitabilityCode ?? "");
  const [revision, setRevision] = useState(version.revisionCode ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { profile, state } = folder;
  const locked = !!state && state !== "wip";
  const hints = codeHints(profile, state);
  const check = validateCodes(profile, state, { suitabilityCode: suitability, revisionCode: revision });
  // Unchanged values are not checked again (older data is accepted as it is).
  const problems = check.errors.filter((e) => e.value !== (e.field === "suitabilityCode" ? version.suitabilityCode : version.revisionCode));
  // Refused only when the project enforces the ISO 19650 rules (D-8); otherwise saved with a warning.
  const enforced = folder.dto.enforceTransitions;
  const errors = enforced ? problems : [];
  const next = nextRevision(profile, version.revisionCode, state, state, history);
  const listId = `codes-${version.id}`;

  async function save() {
    if (errors.length) return;
    if (locked && !reason.trim()) {
      setError(t("codes.editor.reasonRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await cdeApi.setVersionCodes(projectId, version.id, {
        suitabilityCode: suitability.trim() || null,
        revisionCode: revision.trim() || null,
        ...(locked ? { reason: reason.trim() } : {}),
      });
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t("codes.editor.title", { version: version.version })} onClose={onClose}>
      <div className="stack" data-testid="codes-editor">
        <p className="muted small" style={{ margin: 0 }}>
          {state ? t("codes.editor.stateHelp", { state: t(`states.${state}`), codes: hints.codes, revision: hints.revision }) : t("codes.editor.noStateHelp")}
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "0 12px" }}>
          <div>
            <label htmlFor={`${listId}-s`}>{t("codes.suitability")}</label>
            <input id={`${listId}-s`} list={`${listId}-list`} value={suitability} onChange={(e) => setSuitability(e.target.value)} placeholder={t("codes.editor.clear")} />
            <datalist id={`${listId}-list`}>
              {allowedSuitability(profile, state).map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div>
            <label htmlFor={`${listId}-r`}>{t("codes.revision")}</label>
            <input id={`${listId}-r`} value={revision} onChange={(e) => setRevision(e.target.value)} placeholder={t("codes.editor.clear")} />
            {next && next !== check.codes.revisionCode && (
              <div className="muted small">
                {t("codes.editor.nextRevision", { revision: next })}{" "}
                <button type="button" className="ghost small" onClick={() => setRevision(next)}>
                  {t("codes.editor.useNext")}
                </button>
              </div>
            )}
          </div>
        </div>
        {locked && (
          <div>
            <label htmlFor={`${listId}-reason`}>{t("codes.editor.reason")}</label>
            <p className="muted small" style={{ margin: 0 }}>
              {t("codes.editor.reasonHelp", { state: t(`states.${state}`) })}
            </p>
            <textarea id={`${listId}-reason`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        )}
        {problems.length > 0 && (
          <p className={enforced ? "error small" : "small"} data-testid={enforced ? "codes-error" : "codes-warning"}>
            {!enforced && <span className="badge warn">{tc("codes.warning")}</span>} {problems.map((e) => codeErrorText(tc, e, state)).join(" ")}
          </p>
        )}
        {error && <p className="error small">{error}</p>}
      </div>
      <div className="dialog-actions">
        <button onClick={onClose}>{t("common:actions.cancel")}</button>
        <button className="primary" disabled={busy || errors.length > 0} onClick={() => void save()}>
          {t("codes.editor.save")}
        </button>
      </div>
    </Dialog>
  );
}
