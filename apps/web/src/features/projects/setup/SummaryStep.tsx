/** Wizard step 11 (summary and the server's dry run) and the report after the project was created. */
import { useTranslation } from "react-i18next";
import {
  TEMPLATE_PARTS,
  resolveModules,
  type ProjectDto,
  type ProjectSetupPersonReportDto,
  type TemplatePartReportDto,
} from "@sitekeep/shared";
import { moduleName } from "./StartSteps";
import { InvitationLink } from "../../../shared/ui/InvitationLink";
import type { StepProps } from "./ProjectSetupWizard";

export type CreatedProject = ProjectDto & { warnings: string[]; parts: TemplatePartReportDto[]; people: ProjectSetupPersonReportDto[] };

export function SummaryStep({ draft, template, companies, preview, refreshPreview }: StepProps) {
  const { t } = useTranslation(["projects", "cde", "common"]);
  if (!template) return null;
  const teams = template.cde?.taskTeams ?? template.slots.map((s) => ({ slot: s.key, lead: false }));
  const modules = resolveModules(template.modules);
  const company = (slot: string) => companies.find((c) => c.id === draft.slotCompanies[slot])?.name;
  const cde = template.cde ?? {};
  const rows: [string, string][] = [
    [t("setup.summary.project"), `${draft.code} · ${draft.name}`],
    [t("setup.summary.language"), draft.language.toUpperCase()],
    [t("setup.summary.template"), template.name],
    ...(draft.startDate || draft.endDate ? [[t("setup.summary.dates"), `${draft.startDate || "…"} – ${draft.endDate || "…"}`] as [string, string]] : []),
    ...(draft.location ? [[t("setup.basics.location"), draft.location] as [string, string]] : []),
    [t("cde:settings.codes.scheme"), t(`cde:schemes.${cde.codeScheme ?? "iso_uk_na"}`)],
    [t("cde:transitionEditor.enforce"), cde.enforceTransitions ? t("common:actions.yes") : t("common:actions.no")],
    [t("cde:settings.teams.wipPolicy"), t(`cde:wipPolicies.${cde.wipPolicy ?? "grants"}`)],
    [t("cde:settings.teams.adminSeesWip"), cde.adminSeesWip === false ? t("common:actions.no") : t("common:actions.yes")],
    [t("cde:documentCode.standard.label"), cde.containerStandard ?? t("common:status.none")],
    [t("setup.summary.people"), String(draft.people.filter((p) => p.email.trim()).length)],
    ...(draft.people.length
      ? [[t("setup.summary.invitations"), draft.invite ? t("setup.summary.inviteOn", { language: draft.inviteLanguage ? t(`setup.people.languages.${draft.inviteLanguage}`) : t("setup.people.inviteLanguageDefault") }) : t("setup.summary.inviteOff")] as [string, string]]
      : []),
  ];
  return (
    <div className="stack" data-testid="setup-summary">
      <dl className="setup-summary-list">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div>
        <h4>{t("setup.summary.teams")}</h4>
        <ul className="setup-teams">
          {teams.map((team) => {
            const slot = template.slots.find((s) => s.key === team.slot);
            const name = company(team.slot);
            return (
              <li key={team.slot}>
                <strong>{slot?.label ?? team.slot}</strong>: {name ?? <span className="muted">{t("setup.summary.noCompany")}</span>}
                {team.lead && <span className="badge info">{t("cde:teams.lead")}</span>}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="row">
        <h4 className="spacer-right">{t("setup.summary.check")}</h4>
        <button type="button" className="small" onClick={refreshPreview}>
          {t("wizard.preview.actions.refresh")}
        </button>
      </div>
      {!preview && <p className="muted">{t("wizard.preview.loading")}</p>}
      {preview && (
        <>
          <div className="wizard-stats">
            <div>
              <strong>{preview.counts.folders}</strong>
              <span>{t("wizard.preview.stats.foldersNow", { count: preview.counts.folders })}</span>
            </div>
            <div>
              <strong>{preview.counts.virtualFolders}</strong>
              <span>{t("wizard.preview.stats.foldersOnDemand", { count: preview.counts.virtualFolders })}</span>
            </div>
            <div>
              <strong>{preview.counts.workflows}</strong>
              <span>{t("wizard.preview.stats.workflows", { count: preview.counts.workflows })}</span>
            </div>
            <div>
              <strong>{preview.counts.grants}</strong>
              <span>{t("wizard.preview.stats.grants", { count: preview.counts.grants })}</span>
            </div>
          </div>
          {preview.ok ? (
            <p className="ok-text" role="status">
              {t("setup.summary.ready")}
            </p>
          ) : (
            <ul className="error" role="alert" data-testid="setup-dry-run-errors">
              {preview.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {preview.warnings.length > 0 && (
            <ul className="notice wizard-warnings">
              {preview.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {preview.people.length > 0 && (
            <div data-testid="setup-people-check">
              <h4>{t("setup.summary.peopleCheck")}</h4>
              <ul className="setup-teams">
                {preview.people.map((p) => (
                  <li key={p.email} data-email={p.email} data-status={p.status}>
                    {p.name ? `${p.name} · ` : ""}
                    {p.email}: <span className={`badge ${PERSON_BADGE[p.status]}`}>{t(`setup.report.personStatus.${p.status}`)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.parts.length > 0 && (
            <table className="data-table phone-cards setup-parts" data-testid="setup-expected-parts">
              <caption className="setup-caption">{t("setup.summary.parts")}</caption>
              <thead>
                <tr>
                  <th>{t("setup.parts.part")}</th>
                  <th>{t("setup.parts.expected")}</th>
                </tr>
              </thead>
              <tbody>
                {preview.parts.map((p) => {
                  const info = TEMPLATE_PARTS.find((x) => x.part === p.part)!;
                  const off = info.projectModule && !modules[info.projectModule];
                  return (
                    <tr key={p.part} data-part={p.part}>
                      <td className="pc-title">{t(`setup.parts.names.${p.part}`)}</td>
                      <td data-label={t("setup.parts.expected")}>
                        {off ? (
                          <span className="badge">{t("setup.parts.reasons.module_off")}</span>
                        ) : !p.available && p.module ? (
                          <span className="badge warn">{t("setup.parts.requiresModule", { module: moduleName(p.module) })}</span>
                        ) : (
                          <span className="badge ok">{t("setup.parts.willApply")}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

const STATUS_BADGE: Record<TemplatePartReportDto["status"], string> = { applied: "ok", partial: "info", skipped: "", failed: "danger" };
const PERSON_BADGE: Record<ProjectSetupPersonReportDto["status"], string> = { added: "ok", invite: "info", invited: "info", no_account: "warn", group_address: "warn" };

export function SetupReport({ project, onOpen }: { project: CreatedProject; onOpen(): void }) {
  const { t } = useTranslation(["projects", "common"]);
  return (
    <div className="stack setup-report" data-testid="setup-report">
      <p className="ok-text" role="status">
        {t("setup.report.created", { code: project.code, name: project.name })}
      </p>
      {project.parts.length > 0 && (
        <table className="data-table phone-cards setup-parts">
          <caption className="setup-caption">{t("setup.report.parts")}</caption>
          <thead>
            <tr>
              <th>{t("setup.parts.part")}</th>
              <th>{t("setup.report.status")}</th>
              <th>{t("setup.report.notes")}</th>
            </tr>
          </thead>
          <tbody>
            {project.parts.map((p) => (
              <tr key={p.part} data-part={p.part} data-status={p.status}>
                <td className="pc-title">{t(`setup.parts.names.${p.part}`)}</td>
                <td data-label={t("setup.report.status")}>
                  <span className={`badge ${STATUS_BADGE[p.status]}`}>{t(`setup.report.statuses.${p.status}`)}</span>
                  {p.count !== undefined && p.status !== "skipped" && <span className="muted small"> {t("setup.report.count", { count: p.count })}</span>}
                </td>
                <td data-label={t("setup.report.notes")}>
                  {p.reason && (
                    <div>
                      {p.reason === "module_not_installed" && p.module
                        ? t("setup.parts.requiresModule", { module: moduleName(p.module) })
                        : t(`setup.parts.reasons.${p.reason}`)}
                    </div>
                  )}
                  {p.notes?.map((n) => (
                    <div key={n} className="muted small">
                      {n}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {project.people.length > 0 && (
        <div>
          <h4>{t("setup.report.people")}</h4>
          <ul className="setup-teams">
            {project.people.map((p) => (
              <li key={p.email} data-email={p.email} data-status={p.status}>
                {p.name ? `${p.name} · ` : ""}
                {p.email}: <span className={`badge ${PERSON_BADGE[p.status]}`}>{t(`setup.report.personStatus.${p.status}`)}</span>
                {p.invitation && <InvitationLink email={p.email} delivery={p.invitation} />}
              </li>
            ))}
          </ul>
        </div>
      )}
      {project.warnings.length > 0 && (
        <ul className="notice wizard-warnings">
          {project.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={onOpen}>
          {t("setup.report.open")}
        </button>
      </div>
    </div>
  );
}
