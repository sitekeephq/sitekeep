/** Wizard steps 4–5: parties → companies → task teams and lead; people into parties and project roles. */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PARTIES, asciiUpper, companyCodeInput, isGroupAddress, type Party, type TemplateTaskTeam } from "@sitekeep/shared";
import { api, dataLocale } from "../../../shared/api/api";
import { useLabel } from "../../../i18n";
import { NEW_COMPANY, templateTaskTeams, type SetupPerson } from "./draft";
import type { StepProps } from "./ProjectSetupWizard";

/** "Client technical unit" → "client-technical-unit" (unique among `taken`). */
function partyKey(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ı/g, "i")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "party";
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}-${i}`;
  return key;
}

export function PartiesStep({ draft, update, base, template, companies, setCompanies }: StepProps) {
  const { t } = useTranslation(["projects", "common"]);
  const label = useLabel();
  const [newCompany, setNewCompany] = useState<Record<string, { name: string; code: string }>>({});
  const [party, setParty] = useState<{ label: string; party: Party; code: string }>({ label: "", party: "other", code: "" });
  const [error, setError] = useState<string | null>(null);
  if (!template || !base) return null;
  const teams: TemplateTaskTeam[] = template.cde?.taskTeams ?? templateTaskTeams(template);
  const teamOf = (slot: string) => teams.find((x) => x.slot === slot);
  const setTeams = (next: TemplateTaskTeam[]) => update({ taskTeams: next });

  function toggleTeam(slot: string, on: boolean) {
    const order = template!.slots.map((s) => s.key);
    const next = on ? [...teams, { slot }] : teams.filter((x) => x.slot !== slot);
    setTeams(next.sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot)));
  }

  function pickCompany(slot: string, companyId: string, list = companies) {
    const company = list.find((c) => c.id === companyId);
    update((d) => ({
      slotCompanies: { ...d.slotCompanies, [slot]: companyId },
      slotCodes: { ...d.slotCodes, [slot]: company?.code ?? d.slotCodes[slot] ?? "" },
    }));
  }

  async function addCompany(slot: string) {
    const entry = newCompany[slot];
    if (!entry?.name.trim()) return;
    setError(null);
    try {
      const c = await api.createCompany(entry.name.trim(), entry.code || null);
      const list = [...companies, c].sort((a, b) => a.name.localeCompare(b.name, dataLocale()));
      setCompanies(list);
      pickCompany(slot, c.id, list);
      setNewCompany((m) => ({ ...m, [slot]: { name: "", code: "" } }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function addParty() {
    if (!party.label.trim()) return;
    const key = partyKey(party.label, new Set(template!.slots.map((s) => s.key)));
    update((d) => ({
      parties: [...d.parties, { key, label: party.label.trim(), party: party.party, ...(party.code ? { code: party.code } : {}) }],
      ...(d.taskTeams ? { taskTeams: [...d.taskTeams, { slot: key }] } : {}),
    }));
    setParty({ label: "", party: "other", code: "" });
  }

  function removeParty(key: string) {
    update((d) => ({
      parties: d.parties.filter((p) => p.key !== key),
      ...(d.taskTeams ? { taskTeams: d.taskTeams.filter((x) => x.slot !== key) } : {}),
      people: d.people.map((p) => (p.slot === key ? { ...p, slot: "" } : p)),
    }));
  }

  const added = new Set(draft.parties.map((p) => p.key));
  return (
    <div className="stack">
      <table className="data-table wizard-table phone-cards setup-parties">
        <thead>
          <tr>
            <th>{t("wizard.companies.columns.role")}</th>
            <th>{t("wizard.companies.columns.company")}</th>
            <th>{t("wizard.companies.columns.code")}</th>
            <th>{t("setup.parties.team")}</th>
            <th>{t("setup.parties.lead")}</th>
          </tr>
        </thead>
        <tbody>
          {template.slots.map((s) => {
            const companyId = draft.slotCompanies[s.key] ?? "";
            const team = teamOf(s.key);
            return (
              <tr key={s.key} data-slot={s.key}>
                <td className="pc-title">
                  <strong>{s.label}</strong>
                  {s.party && <div className="muted small">{label("party", s.party)}</div>}
                  {added.has(s.key) && (
                    <button type="button" className="ghost small" onClick={() => removeParty(s.key)}>
                      {t("common:actions.remove")}
                    </button>
                  )}
                </td>
                <td data-label={t("wizard.companies.columns.company")}>
                  <select
                    aria-label={t("setup.parties.companyFor", { party: s.label })}
                    value={companyId}
                    onChange={(e) => (e.target.value === NEW_COMPANY ? update((d) => ({ slotCompanies: { ...d.slotCompanies, [s.key]: NEW_COMPANY } })) : pickCompany(s.key, e.target.value))}
                  >
                    <option value="">{t("wizard.companies.options.leaveEmpty")}</option>
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                    <option value={NEW_COMPANY}>{t("wizard.companies.options.newCompany")}</option>
                  </select>
                  {companyId === NEW_COMPANY && (
                    <div className="row wrap setup-inline-form">
                      <input
                        aria-label={t("wizard.companies.companyNamePlaceholder")}
                        placeholder={t("wizard.companies.companyNamePlaceholder")}
                        value={newCompany[s.key]?.name ?? ""}
                        onChange={(e) => setNewCompany((m) => ({ ...m, [s.key]: { name: e.target.value, code: m[s.key]?.code ?? "" } }))}
                        onKeyDown={(e) => e.key === "Enter" && void addCompany(s.key)}
                      />
                      <input
                        aria-label={t("wizard.companies.companyCodeHint")}
                        placeholder={t("wizard.companies.columns.code")}
                        className="setup-code-input"
                        maxLength={8}
                        value={newCompany[s.key]?.code ?? ""}
                        onChange={(e) => setNewCompany((m) => ({ ...m, [s.key]: { name: m[s.key]?.name ?? "", code: companyCodeInput(e.target.value) } }))}
                        onKeyDown={(e) => e.key === "Enter" && void addCompany(s.key)}
                      />
                      <button type="button" onClick={() => void addCompany(s.key)}>
                        {t("common:actions.add")}
                      </button>
                    </div>
                  )}
                </td>
                <td data-label={t("wizard.companies.columns.code")}>
                  <input
                    aria-label={t("setup.parties.codeFor", { party: s.label })}
                    className="setup-code-input"
                    value={draft.slotCodes[s.key] ?? ""}
                    placeholder={s.code ?? ""}
                    maxLength={20}
                    onChange={(e) => update((d) => ({ slotCodes: { ...d.slotCodes, [s.key]: asciiUpper(e.target.value) } }))}
                  />
                </td>
                <td data-label={t("setup.parties.team")}>
                  <label className="check">
                    <input type="checkbox" checked={!!team} onChange={(e) => toggleTeam(s.key, e.target.checked)} />
                    {t("setup.parties.hasTeam")}
                  </label>
                </td>
                <td data-label={t("setup.parties.lead")}>
                  <label className="check">
                    <input
                      type="radio"
                      name="setup-lead"
                      checked={!!team?.lead}
                      disabled={!team}
                      onChange={() => setTeams(teams.map((x) => ({ slot: x.slot, ...(x.slot === s.key ? { lead: true } : {}) })))}
                    />
                    {t("setup.parties.isLead")}
                  </label>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="field-hint">{t("setup.parties.teamsHint")}</p>
      {error && <p className="error">{error}</p>}
      <fieldset className="card setup-fieldset">
        <legend>{t("setup.parties.addHeading")}</legend>
        <div className="row wrap setup-inline-form">
          <input
            aria-label={t("setup.parties.partyName")}
            placeholder={t("setup.parties.partyName")}
            value={party.label}
            maxLength={100}
            onChange={(e) => setParty((p) => ({ ...p, label: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && addParty()}
          />
          <select aria-label={t("setup.parties.partyType")} value={party.party} onChange={(e) => setParty((p) => ({ ...p, party: e.target.value as Party }))}>
            {PARTIES.map((p) => (
              <option key={p} value={p}>
                {label("party", p)}
              </option>
            ))}
          </select>
          <input
            aria-label={t("wizard.companies.columns.code")}
            placeholder={t("wizard.companies.columns.code")}
            className="setup-code-input"
            value={party.code}
            maxLength={20}
            onChange={(e) => setParty((p) => ({ ...p, code: asciiUpper(e.target.value) }))}
          />
          <button type="button" onClick={addParty} disabled={!party.label.trim()}>
            {t("setup.parties.add")}
          </button>
        </div>
      </fieldset>
    </div>
  );
}

const SPLIT = /[\s,;]+/;

export function PeopleStep({ draft, update, template, users }: StepProps) {
  const { t } = useTranslation(["projects", "common"]);
  const [bulk, setBulk] = useState("");
  if (!template) return null;
  const known = new Map(users.map((u) => [u.email.toLowerCase(), u]));
  const setPerson = (index: number, patch: Partial<SetupPerson>) =>
    update((d) => ({ people: d.people.map((p, i) => (i === index ? { ...p, ...patch } : p)) }));
  const addEmails = () => {
    const emails = bulk.split(SPLIT).map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!emails.length) return;
    update((d) => {
      const have = new Set(d.people.map((p) => p.email.toLowerCase()));
      const rows = emails.filter((e) => !have.has(e) && !!have.add(e)).map((email) => ({ email, slot: "", roles: [], projectAdmin: false }));
      return { people: [...d.people, ...rows] };
    });
    setBulk("");
  };
  const roles = template.roles ?? [];
  return (
    <div className="stack">
      <div className="setup-bulk">
        <label htmlFor="setup-emails">{t("setup.people.emails")}</label>
        <div className="row wrap setup-inline-form">
          <textarea
            id="setup-emails"
            rows={2}
            value={bulk}
            placeholder={t("setup.people.emailsPlaceholder")}
            onChange={(e) => setBulk(e.target.value)}
          />
          <button type="button" onClick={addEmails} disabled={!bulk.trim()}>
            {t("setup.people.add")}
          </button>
        </div>
        <p className="field-hint">{t("setup.people.hint")}</p>
      </div>
      <datalist id="setup-users">
        {users.map((u) => (
          <option key={u.id} value={u.email}>
            {u.name}
          </option>
        ))}
      </datalist>
      {!draft.people.length && <p className="muted">{t("setup.people.empty")}</p>}
      {draft.people.length > 0 && (
        <table className="data-table wizard-table phone-cards setup-people">
          <thead>
            <tr>
              <th>{t("setup.people.email")}</th>
              <th>{t("setup.people.party")}</th>
              <th>{t("setup.people.roles")}</th>
              <th>{t("setup.people.admin")}</th>
              <th>
                <span className="visually-hidden">{t("common:actions.remove")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {draft.people.map((person, index) => {
              const user = known.get(person.email.trim().toLowerCase());
              const group = person.email && isGroupAddress(person.email);
              const partyRoles = roles.filter((r) => !r.slot || !person.slot || r.slot === person.slot);
              return (
                <tr key={index} data-email={person.email}>
                  <td className="pc-title">
                    <input
                      aria-label={t("setup.people.email")}
                      type="email"
                      list="setup-users"
                      value={person.email}
                      onChange={(e) => setPerson(index, { email: e.target.value })}
                    />
                    {user && <div className="muted small">{user.name}</div>}
                    {!user && person.email && !group && <div className="small warn-text">{t("setup.people.noAccount")}</div>}
                    {group && <div className="small warn-text">{t("setup.people.groupAddress")}</div>}
                  </td>
                  <td data-label={t("setup.people.party")}>
                    <select aria-label={t("setup.people.partyFor", { email: person.email })} value={person.slot} onChange={(e) => setPerson(index, { slot: e.target.value, roles: [] })}>
                      <option value="">{t("setup.people.ownCompany")}</option>
                      {template.slots.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td data-label={t("setup.people.roles")}>
                    {partyRoles.length ? (
                      <details className="setup-roles">
                        <summary>{person.roles.length ? t("setup.people.rolesChosen", { count: person.roles.length }) : t("setup.people.rolesNone")}</summary>
                        {partyRoles.map((role) => (
                          <label key={role.key} className="check">
                            <input
                              type="checkbox"
                              checked={person.roles.includes(role.key)}
                              onChange={(e) =>
                                setPerson(index, { roles: e.target.checked ? [...person.roles, role.key] : person.roles.filter((r) => r !== role.key) })
                              }
                            />
                            {role.name}
                          </label>
                        ))}
                      </details>
                    ) : (
                      <span className="muted">{t("setup.people.noRoles")}</span>
                    )}
                  </td>
                  <td data-label={t("setup.people.admin")}>
                    <label className="check">
                      <input type="checkbox" checked={person.projectAdmin} onChange={(e) => setPerson(index, { projectAdmin: e.target.checked })} />
                      {t("setup.people.isAdmin")}
                    </label>
                  </td>
                  <td className="pc-actions">
                    <button type="button" className="ghost small" onClick={() => update((d) => ({ people: d.people.filter((_, i) => i !== index) }))}>
                      {t("common:actions.remove")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
