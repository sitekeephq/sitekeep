import { useTranslation } from "react-i18next";
import { request } from "../../../shared/api/client";
import { useLoad } from "../../../app/context/project";

interface ConflictFile {
  fileId: string;
  name: string;
  path: string;
  createdAt: string;
}
interface CodeConflict {
  code: string;
  holder: ConflictFile | null;
  others: ConflictFile[];
}

/**
 * Proje Ayarları → CDE → Code conflicts (ISO-3, docs/features/DOCUMENT_CODES.md): files from before
 * unique document codes that use a code registered to another document. Project administrators
 * only (the section is hidden for others).
 */
export function CdeCodeConflicts({ projectId }: { projectId: string }) {
  const { t } = useTranslation("cde");
  const { data, error } = useLoad(
    () => request<{ conflicts: CodeConflict[] }>("GET", `/projects/${projectId}/cde/code-conflicts`),
    [projectId],
  );
  if (error) return null;
  return (
    <section className="card stack" data-section="code-conflicts" data-testid="cde-code-conflicts">
      <h3 style={{ margin: 0 }}>{t("documentCode.conflicts.heading")}</h3>
      <p className="muted small" style={{ margin: 0 }}>
        {t("documentCode.conflicts.description")}
      </p>
      {!data ? (
        <p className="muted">…</p>
      ) : data.conflicts.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          {t("documentCode.conflicts.empty")}
        </p>
      ) : (
        <table className="phone-cards">
          <thead>
            <tr>
              <th>{t("documentCode.conflicts.code")}</th>
              <th>{t("documentCode.conflicts.holder")}</th>
              <th>{t("documentCode.conflicts.others")}</th>
            </tr>
          </thead>
          <tbody>
            {data.conflicts.map((c) => (
              <tr key={c.code}>
                <td className="mono pc-title">{c.code}</td>
                <td className="small" data-label={t("documentCode.conflicts.holder")}>
                  {c.holder ? <span className="mono">{c.holder.path}</span> : <span className="muted">—</span>}
                </td>
                <td className="small" data-label={t("documentCode.conflicts.others")}>
                  {c.others.map((o) => (
                    <div key={o.fileId} className="mono">
                      {o.path}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
