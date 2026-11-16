/**
 * ISO-12 (ISO 19650-1 §12.5, docs/features/CDE_STATES.md "Supersession"): "Superseded by" and
 * "Supersedes" in the file drawer. Each entry opens the other file in its folder; a file the user
 * cannot see (the server leaves out its ids) is shown as text only.
 */
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { FileVersionDto, SupersessionLinkDto } from "@sitekeep/shared";

/** "A-101.pdf V2 · C02": the name, the version and the revision code. */
export function supersessionLabel(l: Pick<SupersessionLinkDto, "name" | "version" | "revisionCode">): string {
  return [`${l.name} V${l.version}`, l.revisionCode].filter(Boolean).join(" · ");
}

function Entry({ projectId, link }: { projectId: string; link: SupersessionLinkDto }) {
  const { t } = useTranslation("cde");
  const label = supersessionLabel(link);
  if (!link.fileId || !link.folderId)
    return (
      <span className="muted" title={t("supersession.noAccess")} data-testid="supersession-text">
        {label}
      </span>
    );
  return (
    <Link to={`/projects/${projectId}/files/${link.folderId}?file=${link.fileId}`} data-testid="supersession-link">
      {label}
    </Link>
  );
}

/** The supersession links of one version; nothing when it has none. */
export function SupersessionLinks({ projectId, version }: { projectId: string; version: Pick<FileVersionDto, "supersededBy" | "supersedes"> }) {
  const { t } = useTranslation("cde");
  const rows = [
    ["supersededBy", version.supersededBy ?? []],
    ["supersedes", version.supersedes ?? []],
  ] as const;
  if (!rows.some(([, list]) => list.length)) return null;
  return (
    <div className="small supersession-links">
      {rows.map(([key, list]) =>
        list.length ? (
          <div key={key} data-testid={`supersession-${key}`}>
            <span className="muted">{t(`supersession.${key}`)}:</span>{" "}
            {list.map((l, i) => (
              <span key={`${l.versionId ?? l.name}-${l.version}-${i}`}>
                {i > 0 && ", "}
                <Entry projectId={projectId} link={l} />
              </span>
            ))}
          </div>
        ) : null,
      )}
    </div>
  );
}
