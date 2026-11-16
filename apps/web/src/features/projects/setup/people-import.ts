/** Imported people rows in the wizard: what creating the project will do with each, and merging them into the draft. */
import { isGroupAddress, type PeopleImportRow, type UserDto } from "@sitekeep/shared";
import type { SetupPerson } from "./draft";

export type ImportRowOutcome = "error" | "group_address" | "added" | "invite" | "no_account";

/** What creating the project will do with an imported row. */
export function importRowOutcome(row: PeopleImportRow, users: readonly UserDto[], invite: boolean): ImportRowOutcome {
  if (row.errors.length) return "error";
  if (isGroupAddress(row.email)) return "group_address";
  const user = users.find((u) => u.email.toLowerCase() === row.email);
  if (user && !user.pending) return "added";
  return invite ? "invite" : "no_account";
}

/** The draft's people with the imported rows (rows without problems; an address already listed is updated). */
export function mergeImportedPeople(people: readonly SetupPerson[], rows: readonly PeopleImportRow[]): SetupPerson[] {
  const out = people.map((p) => ({ ...p }));
  for (const row of rows) {
    if (row.errors.length || isGroupAddress(row.email)) continue;
    const next: SetupPerson = { email: row.email, slot: row.slot, roles: row.roles, projectAdmin: false, ...(row.name ? { name: row.name } : {}) };
    const at = out.findIndex((p) => p.email.trim().toLowerCase() === row.email);
    if (at >= 0) out[at] = { ...out[at]!, ...next, projectAdmin: out[at]!.projectAdmin };
    else out.push(next);
  }
  return out;
}
