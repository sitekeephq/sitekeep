import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CDE_STATES,
  CDE_TRANSITION_MODES,
  DEFAULT_CDE_TRANSITIONS,
  type CdeSettingsDto,
  type CdeState,
  type CdeTransitionDto,
  type CdeTransitionMode,
  type WorkflowTemplateDto,
} from "@sitekeep/shared";
import { cdeApi } from "../../../shared/api/api-cde";
import { documentsApi } from "../../documents/api";
import { useLoad, useProject } from "../../../app/context/project";

const UPLOAD = "upload";

/**
 * Proje Ayarları → CDE → State Transitions (docs/features/CDE_STATES.md "Transitions"): the
 * enforcement switch, the archive folder and the transition table. Project administrators edit;
 * everyone else reads.
 */
export function CdeTransitionsEditor({
  settings,
  workflows,
  onSaved,
}: {
  settings: CdeSettingsDto;
  workflows: WorkflowTemplateDto[] | null | undefined;
  onSaved(s: CdeSettingsDto): void;
}) {
  const { t } = useTranslation(["cde", "common"]);
  const project = useProject();
  const isAdmin = !!project.isProjectAdmin;
  const [enforce, setEnforce] = useState(settings.enforceTransitions);
  const [archiveFolderId, setArchiveFolderId] = useState(settings.archiveFolderId);
  const [rows, setRows] = useState<CdeTransitionDto[]>(settings.transitions);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const { data: root } = useLoad(() => documentsApi.contents(project.id, project.rootFolderId).catch(() => null), [project.id, project.rootFolderId]);
  const folders = root?.folders ?? [];
  const stateText = (v: CdeState | null) => (v ? t(`states.${v}`) : t("settings.transitions.upload"));
  const update = (i: number, patch: Partial<CdeTransitionDto>) =>
    setRows((rs) =>
      rs.map((r, j) => {
        if (j !== i) return r;
        const next = { ...r, ...patch };
        if (next.mode !== "review") next.workflowTemplateId = null;
        return next;
      }),
    );
  const dirty =
    enforce !== settings.enforceTransitions ||
    archiveFolderId !== settings.archiveFolderId ||
    JSON.stringify(rows) !== JSON.stringify(settings.transitions);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const saved = await cdeApi.saveSettings(project.id, { enforceTransitions: enforce, archiveFolderId, transitions: rows });
      onSaved(saved);
      setRows(saved.transitions);
      setMessage({ ok: true, text: t("transitionEditor.saved") });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack" data-section="transitions" data-testid="cde-transitions-editor">
      <h3 style={{ margin: 0 }}>{t("settings.transitions.heading")}</h3>
      <label className="row" style={{ color: "var(--text)", fontSize: 13, margin: 0 }}>
        <input
          type="checkbox"
          data-testid="cde-enforce"
          style={{ width: "auto" }}
          checked={enforce}
          disabled={!isAdmin}
          onChange={(e) => setEnforce(e.target.checked)}
        />
        {t("transitionEditor.enforce")}
      </label>
      <p className="muted small" style={{ margin: 0 }}>
        {enforce ? t("transitionEditor.enforceHelp") : t("settings.general.enforceOff")}
      </p>
      <div>
        <label htmlFor="cde-archive-folder">{t("transitionEditor.archiveFolder")}</label>
        <select
          id="cde-archive-folder"
          value={archiveFolderId ?? ""}
          disabled={!isAdmin}
          onChange={(e) => setArchiveFolderId(e.target.value || null)}
          style={{ width: "auto" }}
        >
          <option value="">{t("transitionEditor.noFolder")}</option>
          {archiveFolderId && !folders.some((f) => f.id === archiveFolderId) && <option value={archiveFolderId}>{archiveFolderId.slice(0, 8)}</option>}
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <p className="muted small" style={{ margin: "4px 0 0" }}>
          {t("transitionEditor.archiveHelp")}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          {enforce ? t("transitionEditor.defaultsNote") : t("settings.transitions.empty")}
        </p>
      ) : (
        <table className="phone-cards">
          <thead>
            <tr>
              <th>{t("settings.transitions.from")}</th>
              <th>{t("settings.transitions.to")}</th>
              <th>{t("settings.transitions.mode")}</th>
              <th>{t("settings.transitions.workflow")}</th>
              <th>{t("settings.transitions.reason")}</th>
              {isAdmin && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((tr, i) => (
              <tr key={i} data-testid="cde-transition-row">
                <td data-label={t("settings.transitions.from")}>
                  {isAdmin ? (
                    <select value={tr.fromState ?? UPLOAD} onChange={(e) => update(i, { fromState: e.target.value === UPLOAD ? null : (e.target.value as CdeState) })}>
                      <option value={UPLOAD}>{t("settings.transitions.upload")}</option>
                      {CDE_STATES.map((s) => (
                        <option key={s} value={s}>
                          {t(`states.${s}`)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    stateText(tr.fromState)
                  )}
                </td>
                <td data-label={t("settings.transitions.to")}>
                  {isAdmin ? (
                    <select value={tr.toState} onChange={(e) => update(i, { toState: e.target.value as CdeState })}>
                      {CDE_STATES.map((s) => (
                        <option key={s} value={s}>
                          {t(`states.${s}`)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    stateText(tr.toState)
                  )}
                </td>
                <td data-label={t("settings.transitions.mode")}>
                  {isAdmin ? (
                    <select value={tr.mode} onChange={(e) => update(i, { mode: e.target.value as CdeTransitionMode })}>
                      {CDE_TRANSITION_MODES.map((m) => (
                        <option key={m} value={m}>
                          {t(`modes.${m}`)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    t(`modes.${tr.mode}`)
                  )}
                </td>
                <td data-label={t("settings.transitions.workflow")}>
                  {tr.mode !== "review" ? (
                    "—"
                  ) : isAdmin ? (
                    <select value={tr.workflowTemplateId ?? ""} onChange={(e) => update(i, { workflowTemplateId: e.target.value || null })}>
                      <option value="">{t("transitionEditor.anyWorkflow")}</option>
                      {workflows?.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    (workflows?.find((w) => w.id === tr.workflowTemplateId)?.name ?? t("settings.transitions.anyReview"))
                  )}
                </td>
                <td data-label={t("settings.transitions.reason")}>
                  {isAdmin ? (
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      checked={tr.requireReason}
                      aria-label={t("settings.transitions.reason")}
                      onChange={(e) => update(i, { requireReason: e.target.checked })}
                    />
                  ) : tr.requireReason ? (
                    t("settings.yes")
                  ) : (
                    t("settings.no")
                  )}
                </td>
                {isAdmin && (
                  <td>
                    <button className="small" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                      {t("transitionEditor.remove")}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {isAdmin && (
        <div className="row wrap">
          <button
            className="small"
            onClick={() => setRows((rs) => [...rs, { fromState: "wip", toState: "shared", mode: "review", workflowTemplateId: null, requireReason: false }])}
          >
            {t("transitionEditor.add")}
          </button>
          <button className="small" onClick={() => setRows(DEFAULT_CDE_TRANSITIONS.map((r) => ({ ...r })))}>
            {t("transitionEditor.defaults")}
          </button>
          <div className="spacer" />
          <button className="primary small" data-testid="cde-transitions-save" disabled={busy || !dirty} onClick={() => void save()}>
            {t("transitionEditor.save")}
          </button>
          {message && <span className={message.ok ? "muted small" : "error small"}>{message.text}</span>}
        </div>
      )}
    </section>
  );
}
