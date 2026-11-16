/**
 * People imported from a CSV or Excel table in the project set-up wizard
 * (docs/features/PROJECT_SETUP_WIZARD.md#importing-people): columns e-mail, name, company / party,
 * role and task team, matched against the template's parties, roles and task teams. Every row is
 * checked on its own; rows with errors are shown and not added. Pure: used by the web wizard and tests.
 */
import { SHARED_DEFAULT_LANGUAGE, sharedText } from "./i18n.js";
import { PROJECT_SETUP_MAX_PEOPLE } from "./project-setup.js";

export type PeopleImportColumn = "email" | "name" | "party" | "role" | "taskTeam";

/** Header names understood (compared without case, spaces, punctuation and Turkish accents). */
const HEADER_ALIASES: Record<string, PeopleImportColumn> = {
  email: "email",
  emailaddress: "email",
  mail: "email",
  eposta: "email",
  epostaadresi: "email",
  name: "name",
  fullname: "name",
  ad: "name",
  adsoyad: "name",
  adisoyadi: "name",
  isim: "name",
  kisi: "name",
  party: "party",
  company: "party",
  companyparty: "party",
  organisation: "party",
  organization: "party",
  firma: "party",
  sirket: "party",
  taraf: "party",
  firmataraf: "party",
  role: "role",
  roles: "role",
  projectrole: "role",
  projectroles: "role",
  rol: "role",
  roller: "role",
  projerolu: "role",
  projerolleri: "role",
  taskteam: "taskTeam",
  team: "taskTeam",
  gorevekibi: "taskTeam",
  ekip: "taskTeam",
};

/** Lower-case ASCII letters and digits only ("Görev Ekibi" → "gorevekibi"). */
export function importKey(value: string): string {
  return value
    .replace(/İ/g, "i")
    .replace(/I/g, "i")
    .toLowerCase()
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export interface PeopleImportOptions {
  /** The template's parties after the wizard's choices, with the company chosen for each. */
  slots: { key: string; label: string; code?: string | null; companyName?: string | null }[];
  /** The template's project roles (`slot`: the party the role belongs to). */
  roles: { key: string; name: string; slot?: string | null }[];
  /** Slot keys that get a task team. */
  taskTeams: string[];
}

export interface PeopleImportRow {
  /** Line in the file (the header is line 1). */
  line: number;
  email: string;
  name: string;
  /** Slot key, "" = the person's own company. */
  slot: string;
  roles: string[];
  errors: string[];
}

export interface PeopleImportResult {
  rows: PeopleImportRow[];
  /** Problems of the whole file (no e-mail column, too many rows). */
  errors: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Minimal RFC 4180 reader; the delimiter (; , or tab) is the most frequent on the first line. */
export function parseCsvTable(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const counts = [";", ",", "\t"].map((d) => [d, first.split(d).length - 1] as const).sort((x, y) => y[1] - x[1]);
  const delim = counts[0]![1] > 0 ? counts[0]![0] : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** Rows of a people table (first row: the header) checked against the template's choices. */
export function parsePeopleTable(table: string[][], options: PeopleImportOptions, lang: string = SHARED_DEFAULT_LANGUAGE): PeopleImportResult {
  const rowsIn = table.filter((r) => r.some((c) => String(c ?? "").trim()));
  if (!rowsIn.length) return { rows: [], errors: [sharedText(lang, "peopleImport.empty")] };
  const header = rowsIn[0]!.map((h) => HEADER_ALIASES[importKey(String(h ?? ""))]);
  if (!header.includes("email")) return { rows: [], errors: [sharedText(lang, "peopleImport.noEmailColumn")] };
  const body = rowsIn.slice(1);
  if (!body.length) return { rows: [], errors: [sharedText(lang, "peopleImport.noRows")] };
  const errors: string[] = [];
  if (body.length > PROJECT_SETUP_MAX_PEOPLE) errors.push(sharedText(lang, "peopleImport.tooManyRows", { max: PROJECT_SETUP_MAX_PEOPLE }));

  const slotOf = (value: string, among = options.slots) => {
    const k = importKey(value);
    return among.find((s) => [s.key, s.label, s.code ?? "", s.companyName ?? ""].some((v) => v && importKey(v) === k));
  };
  const teamSlots = options.slots.filter((s) => options.taskTeams.includes(s.key));
  const seen = new Set<string>();
  const rows = body.slice(0, PROJECT_SETUP_MAX_PEOPLE).map((cells, i) => {
    const get = (column: PeopleImportColumn) => {
      const index = header.indexOf(column);
      return index >= 0 ? String(cells[index] ?? "").trim() : "";
    };
    const row: PeopleImportRow = { line: i + 2, email: get("email").toLowerCase(), name: get("name").slice(0, 200), slot: "", roles: [], errors: [] };
    if (!row.email) row.errors.push(sharedText(lang, "peopleImport.emailMissing"));
    else if (!EMAIL.test(row.email) || row.email.length > 320) row.errors.push(sharedText(lang, "setup.emailInvalid", { email: row.email }));
    else if (seen.has(row.email)) row.errors.push(sharedText(lang, "setup.emailDuplicate", { email: row.email }));
    if (row.email) seen.add(row.email);

    const party = get("party");
    if (party) {
      const slot = slotOf(party);
      if (slot) row.slot = slot.key;
      else row.errors.push(sharedText(lang, "peopleImport.partyUnknown", { value: party }));
    }
    const team = get("taskTeam");
    if (team) {
      const slot = slotOf(team, teamSlots);
      if (!slot) row.errors.push(sharedText(lang, "peopleImport.teamUnknown", { value: team }));
      else if (party && row.slot && row.slot !== slot.key)
        row.errors.push(sharedText(lang, "peopleImport.teamOtherParty", { team, party }));
      else row.slot = slot.key;
    }
    for (const value of get("role").split(/[;,|\n]/).map((v) => v.trim()).filter(Boolean)) {
      const k = importKey(value);
      const role = options.roles.find((r) => importKey(r.key) === k || importKey(r.name) === k);
      if (!role) row.errors.push(sharedText(lang, "peopleImport.roleUnknown", { value }));
      else if (role.slot && row.slot && role.slot !== row.slot) row.errors.push(sharedText(lang, "peopleImport.roleOtherParty", { role: role.name }));
      else if (!row.roles.includes(role.key)) row.roles.push(role.key);
    }
    return row;
  });
  return { rows, errors };
}
