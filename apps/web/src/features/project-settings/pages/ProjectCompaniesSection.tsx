import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CompanyDto } from "@sitekeep/shared";
import { api } from "../../../shared/api/api";
import { useLoad, useProject } from "../../../app/context/project";
import { useAsk } from "../../../shared/ui/Ask";

/**
 * Proje Ayarları → Üyeler → Companies on the project (docs/features/COMPANIES.md): the only companies
 * the project's pickers offer. A project administrator adds one from the companies they can see and
 * takes one off while nothing in the project uses it.
 */
export function ProjectCompaniesSection({ companies, onChanged }: { companies: CompanyDto[]; onChanged(): void }) {
  const { t } = useTranslation(["projectSettings", "common"]);
  const { confirm } = useAsk();
  const project = useProject();
  const { data: registry } = useLoad(() => api.companies().catch(() => [] as CompanyDto[]), []);
  const [pick, setPick] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const onProject = new Set(companies.map((c) => c.id));
  const candidates = (registry ?? []).filter((c) => !onProject.has(c.id));

  async function act(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <section style={{ marginTop: 24 }} aria-labelledby="project-companies-heading" data-testid="project-companies">
      <h3 id="project-companies-heading">{t("companies.heading")}</h3>
      <p className="muted small">{t("companies.hint")}</p>
      {companies.length ? (
        <table className="phone-cards">
          <thead>
            <tr>
              <th>{t("companies.columns.name")}</th>
              <th style={{ width: 120 }}>{t("companies.columns.code")}</th>
              <th style={{ width: 100 }} />
            </tr>
          </thead>
          <tbody>
            {companies.map((c) => (
              <tr key={c.id}>
                <td className="pc-title">{c.name}</td>
                <td className="muted" data-label={t("companies.columns.code")}>
                  {c.code ?? "—"}
                </td>
                <td className="pc-actions">
                  <button
                    className="small danger"
                    onClick={() =>
                      void confirm({
                        title: t("companies.remove.title"),
                        message: t("companies.remove.confirm", { name: c.name }),
                        confirmLabel: t("companies.remove.action"),
                        danger: true,
                      }).then((ok) => {
                        if (ok) return act(() => api.removeProjectCompany(project.id, c.id));
                      })
                    }
                  >
                    {t("companies.remove.action")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">{t("companies.empty")}</p>
      )}
      <div className="row wrap" style={{ marginTop: 8 }}>
        <select style={{ flex: 1, minWidth: 240 }} value={pick} onChange={(e) => setPick(e.target.value)} aria-label={t("companies.add.label")}>
          <option value="">{t("companies.add.choose")}</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.code ? ` (${c.code})` : ""}
            </option>
          ))}
        </select>
        <button
          className="primary"
          disabled={!pick}
          onClick={() =>
            void act(async () => {
              await api.addProjectCompany(project.id, pick);
              setPick("");
            })
          }
        >
          {t("common:actions.add")}
        </button>
      </div>
      {msg && <p className="error">{msg}</p>}
    </section>
  );
}
