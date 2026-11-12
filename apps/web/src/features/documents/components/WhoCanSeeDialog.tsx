import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { type AccessReasonDto, type WhoCanSeeEntryDto } from "@sitekeep/shared";
import { useLabel } from "../../../i18n";
import { documentsApi } from "../api";
import { useLoad } from "../../../app/context/project";
import { Dialog } from "../../../shared/ui/Dialog";
import { LoadingIndicator } from "../../../shared/ui/LoadingIndicator";

const VIA_KEYS = {
  user: "whoCanSee.via.user",
  company: "whoCanSee.via.company",
  role: "whoCanSee.via.role",
  project_admin: "whoCanSee.via.projectAdmin",
  system_admin: "whoCanSee.via.systemAdmin",
} as const satisfies Record<AccessReasonDto["via"], string>;

/** "Bu dosyayı / klasörü kim görebilir?" — every member, their level and the grants behind it. */
export function WhoCanSeeDialog({
  projectId,
  folderId,
  fileId,
  onClose,
}: {
  projectId: string;
  folderId: string;
  fileId?: string;
  onClose(): void;
}) {
  const { t } = useTranslation(["documents", "common"]);
  const { data, error } = useLoad(() => documentsApi.whoCanSee(projectId, folderId, fileId), [projectId, folderId, fileId]);
  const [showHidden, setShowHidden] = useState(false);
  const visible = data?.entries.filter((e) => e.canSee) ?? [];
  const hidden = data?.entries.filter((e) => !e.canSee) ?? [];

  return (
    <Dialog title={fileId ? t("whoCanSee.titleFile") : t("whoCanSee.titleFolder")} onClose={onClose} wide>
      {error && <p className="error">{error}</p>}
      {!data && !error && <LoadingIndicator />}
      {data && (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            {data.fileName ? (
              <>
                <strong>{data.fileName}</strong> · {data.folderPath}
              </>
            ) : (
              data.folderPath
            )}
          </p>
          <p style={{ marginTop: 0 }}>
            <Trans
              t={t}
              i18nKey={hidden.length > 0 ? "whoCanSee.summaryWithHidden" : "whoCanSee.summary"}
              count={visible.length}
              values={{ hidden: hidden.length }}
              components={{ b: <strong /> }}
            />
          </p>
          <EntryTable entries={visible} />
          {hidden.length > 0 && (
            <>
              <button className="small" style={{ marginTop: 12 }} onClick={() => setShowHidden((v) => !v)}>
                {showHidden ? t("whoCanSee.actions.hideHidden") : t("whoCanSee.actions.showHidden", { count: hidden.length })}
              </button>
              {showHidden && <EntryTable entries={hidden} />}
            </>
          )}
          <p className="muted small">{t("whoCanSee.systemAdminsNote")}</p>
        </>
      )}
      <div className="dialog-actions">
        <button onClick={onClose}>{t("common:actions.close")}</button>
      </div>
    </Dialog>
  );
}

function EntryTable({ entries }: { entries: WhoCanSeeEntryDto[] }) {
  const { t } = useTranslation(["documents", "common"]);
  const label = useLabel();
  if (!entries.length) return null;
  return (
    <table className="phone-cards" style={{ marginTop: 8 }}>
      <thead>
        <tr>
          <th style={{ width: 210 }}>{t("permissions.subjects.user")}</th>
          <th style={{ width: 170 }}>{t("permissions.columns.level")}</th>
          <th>{t("whoCanSee.columns.why")}</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.userId} style={e.disabled ? { opacity: 0.6 } : undefined}>
            <td className="pc-title">
              <div>
                {e.name}
                {e.disabled && <span className="badge" style={{ marginLeft: 6 }}>{t("whoCanSee.inactive")}</span>}
              </div>
              <div className="muted small">{e.companyName ?? t("whoCanSee.noCompany")}</div>
              {e.roleNames.length > 0 && (
                <div className="row wrap" style={{ gap: 4, marginTop: 2 }}>
                  {e.roleNames.map((r) => (
                    <span key={r} className="badge info">
                      {r}
                    </span>
                  ))}
                </div>
              )}
            </td>
            <td data-label={t("permissions.columns.level")}>
              <span className={`badge ${e.canSee ? "ok" : ""}`}>{label("level", e.level)}</span>
              {e.canUpload && e.level !== "upload_only" && !["edit", "manage"].includes(e.level) && (
                <div className="muted small">{t("whoCanSee.canUpload")}</div>
              )}
            </td>
            <td className="small" data-label={t("whoCanSee.columns.why")}>
              <div>{e.explanation}</div>
              {e.reasons.length > 1 && (
                <ul className="muted" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                  {e.reasons.map((r, i) => (
                    <li key={i}>
                      {t(VIA_KEYS[r.via])}
                      {r.subjectName ? ` "${r.subjectName}"` : ""}: {label("level", r.level)}
                      {r.folderName ? ` · ${r.inherited ? t("whoCanSee.inheritedFrom", { folder: r.folderName }) : r.folderName}` : ""}
                      {r.decisive ? ` · ${t("whoCanSee.decisive")}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
