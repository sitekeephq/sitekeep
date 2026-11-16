/**
 * Wizard step 5: people from a CSV or Excel file (docs/features/PROJECT_SETUP_WIZARD.md#importing-people).
 * The server reads the file into a table; the columns are matched here against the template's
 * parties, roles and task teams (parsePeopleTable). The preview shows each row with its problems and
 * what will happen (added, invited, not added); only rows without problems are added to the list.
 */
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isGroupAddress, parsePeopleTable, type CompanyDto, type PeopleImportResult, type ProjectTemplate, type UserDto } from "@sitekeep/shared";
import { invitationsApi } from "../../../shared/api/api-invitations";
import { templateTaskTeams, type SetupDraft } from "./draft";
import { importRowOutcome, mergeImportedPeople, type ImportRowOutcome } from "./people-import";

const BADGE: Record<ImportRowOutcome, string> = { error: "danger", group_address: "warn", added: "ok", invite: "info", no_account: "warn" };

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

export function PeopleImport({
  draft,
  update,
  template,
  companies,
  users,
}: {
  draft: SetupDraft;
  update(patch: (d: SetupDraft) => Partial<SetupDraft>): void;
  template: ProjectTemplate;
  companies: CompanyDto[];
  users: UserDto[];
}) {
  const { t, i18n } = useTranslation(["projects", "common"]);
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ fileName: string; result: PeopleImportResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(file: File) {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error(t("setup.people.import.tooBig"));
      const { table } = await invitationsApi.peopleFile(file.name, await readBase64(file));
      const result = parsePeopleTable(
        table,
        {
          slots: template.slots.map((s) => ({
            key: s.key,
            label: s.label,
            code: draft.slotCodes[s.key] || s.code || null,
            companyName: companies.find((c) => c.id === draft.slotCompanies[s.key])?.name ?? null,
          })),
          roles: (template.roles ?? []).map((r) => ({ key: r.key, name: r.name, slot: r.slot ?? null })),
          taskTeams: templateTaskTeams(template).map((team) => team.slot),
        },
        i18n.language,
      );
      setPreview({ fileName: file.name, result });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  const rows = preview?.result.rows ?? [];
  const usable = rows.filter((r) => !r.errors.length && !isGroupAddress(r.email));
  const slotLabel = (key: string) => template.slots.find((s) => s.key === key)?.label ?? t("setup.people.ownCompany");
  const roleName = (key: string) => template.roles?.find((r) => r.key === key)?.name ?? key;

  return (
    <div className="setup-import" data-testid="setup-people-import">
      <div className="row wrap">
        <label className="setup-file-label">
          {t("setup.people.import.choose")}
          <input
            ref={input}
            className="visually-hidden"
            type="file"
            accept=".csv,.xlsx,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={busy}
            aria-label={t("setup.people.import.file")}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void load(file);
            }}
          />
        </label>
        <span className="muted small">{t("setup.people.import.hint")}</span>
      </div>
      {busy && <p className="muted small">{t("setup.people.import.reading")}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <div className="stack" data-testid="setup-import-preview">
          <p className="small" style={{ margin: 0 }}>
            {t("setup.people.import.summary", { file: preview.fileName, count: rows.length, usable: usable.length })}
          </p>
          {preview.result.errors.length > 0 && (
            <ul className="error" role="alert">
              {preview.result.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {rows.length > 0 && (
            <table className="data-table wizard-table phone-cards setup-import-table">
              <thead>
                <tr>
                  <th>{t("setup.people.import.line")}</th>
                  <th>{t("setup.people.email")}</th>
                  <th>{t("setup.people.party")}</th>
                  <th>{t("setup.people.roles")}</th>
                  <th>{t("setup.people.import.outcome")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const outcome = importRowOutcome(row, users, draft.invite);
                  return (
                    <tr key={row.line} data-line={row.line} data-outcome={outcome}>
                      <td data-label={t("setup.people.import.line")}>{row.line}</td>
                      <td className="pc-title">
                        {row.email || "—"}
                        {row.name && <div className="muted small">{row.name}</div>}
                      </td>
                      <td data-label={t("setup.people.party")}>{row.slot ? slotLabel(row.slot) : t("setup.people.ownCompany")}</td>
                      <td data-label={t("setup.people.roles")}>{row.roles.length ? row.roles.map(roleName).join(", ") : "—"}</td>
                      <td data-label={t("setup.people.import.outcome")}>
                        <span className={`badge ${BADGE[outcome]}`}>{t(`setup.people.import.outcomes.${outcome}`)}</span>
                        {row.errors.map((e) => (
                          <div key={e} className="small error-text">
                            {e}
                          </div>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="row wrap">
            <button
              type="button"
              className="primary"
              disabled={!usable.length}
              onClick={() => {
                update((d) => ({ people: mergeImportedPeople(d.people, rows) }));
                setPreview(null);
              }}
            >
              {t("setup.people.import.add", { count: usable.length })}
            </button>
            <button type="button" onClick={() => setPreview(null)}>
              {t("common:actions.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
