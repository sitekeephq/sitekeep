import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SavedSearchDto, SavedSearchShareDto } from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { useLoad } from "../../../app/context/project";
import { Dialog } from "../../../shared/ui/Dialog";
import { documentsApi } from "../api";

type Share = Pick<SavedSearchShareDto, "subjectType" | "subjectId">;

/** Project administrators share a saved search with the project, companies on it or members. */
export function SavedSearchShareDialog({
  projectId,
  search,
  onClose,
  onSaved,
}: {
  projectId: string;
  search: SavedSearchDto;
  onClose(): void;
  onSaved(s: SavedSearchDto): void;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const { data: members } = useLoad(() => api.members(projectId), [projectId]);
  const { data: companies } = useLoad(() => api.projectCompanies(projectId), [projectId]);
  const [shares, setShares] = useState<Share[]>(search.shares.map(({ subjectType, subjectId }) => ({ subjectType, subjectId })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const has = (s: Share) => shares.some((x) => x.subjectType === s.subjectType && x.subjectId === s.subjectId);
  const toggle = (s: Share) =>
    setShares((list) => (has(s) ? list.filter((x) => !(x.subjectType === s.subjectType && x.subjectId === s.subjectId)) : [...list, s]));
  const wholeProject = has({ subjectType: "project", subjectId: projectId });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // The whole project includes everyone: the other entries are dropped.
      const payload: Share[] = wholeProject ? [{ subjectType: "project", subjectId: projectId }] : shares;
      onSaved(await documentsApi.shareSavedSearch(projectId, search.id, payload));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const box = (s: Share, text: string, testId?: string) => (
    <label key={`${s.subjectType}:${s.subjectId}`} className="row" style={{ gap: 8, margin: 0, fontWeight: 400 }}>
      <input type="checkbox" style={{ width: "auto" }} checked={has(s)} onChange={() => toggle(s)} data-testid={testId} />
      {text}
    </label>
  );

  return (
    <Dialog title={t("searchPanel.share.title", { name: search.name })} onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t("searchPanel.share.hint")}
      </p>
      <div className="stack" style={{ gap: 6 }}>
        {box({ subjectType: "project", subjectId: projectId }, t("searchPanel.share.wholeProject"), "share-project")}
        {!wholeProject && (
          <>
            <strong className="small" style={{ marginTop: 8 }}>
              {t("searchPanel.share.companies")}
            </strong>
            {(companies ?? []).map((c) => box({ subjectType: "company", subjectId: c.id }, c.name))}
            {companies?.length === 0 && <span className="muted small">—</span>}
            <strong className="small" style={{ marginTop: 8 }}>
              {t("searchPanel.share.people")}
            </strong>
            {(members ?? [])
              .filter((m) => !m.pending && m.userId !== search.ownerId)
              .map((m) => box({ subjectType: "user", subjectId: m.userId }, m.companyName ? `${m.name} · ${m.companyName}` : m.name))}
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions">
        <button onClick={onClose}>{t("common:actions.cancel")}</button>
        <button className="primary" disabled={busy} onClick={() => void save()}>
          {t("common:actions.save")}
        </button>
      </div>
    </Dialog>
  );
}
