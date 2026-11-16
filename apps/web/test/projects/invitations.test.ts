// Invitations in the web app (docs/features/INVITATIONS.md): people imported from a CSV / Excel table
// in the set-up wizard (parsing, per-row problems, outcomes, merging), the request with invitations,
// and the accept page's token.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { localizeTemplate, parseCsvTable, parsePeopleTable, type PeopleImportOptions, type ProjectTemplate, type UserDto } from "@sitekeep/shared";
import { emptyDraft, loadDraft, saveDraft, toRequest, withTemplate, type SetupDraft } from "../../src/features/projects/setup/draft";
import { importRowOutcome, mergeImportedPeople } from "../../src/features/projects/setup/people-import";
import { invitationToken } from "../../src/features/auth/invitation-token";

const here = path.dirname(fileURLToPath(import.meta.url));
const template = localizeTemplate(
  JSON.parse(readFileSync(path.resolve(here, "../../../server/templates/iso19650-yapim-en.json"), "utf8")) as ProjectTemplate,
  "en",
);

const options: PeopleImportOptions = {
  slots: template.slots.map((s) => ({ key: s.key, label: s.label, code: s.key === "tasarimci" ? "DSG" : null, companyName: s.key === "yuklenici" ? "Build Co" : null })),
  roles: (template.roles ?? []).map((r) => ({ key: r.key, name: r.name, slot: r.slot ?? null })),
  taskTeams: (template.cde?.taskTeams ?? template.slots.map((s) => ({ slot: s.key }))).map((t) => t.slot),
};
const designerRole = template.roles!.find((r) => r.key === "tasarimci-yetki")!;
const otherPartyRole = template.roles!.find((r) => r.slot && r.slot !== "tasarimci")!;

function draft(patch: Partial<SetupDraft> = {}): SetupDraft {
  return { ...emptyDraft("en"), template: { kind: "builtin", id: "iso19650-yapim-en" }, code: "WIZ", name: "Wizard", ...patch };
}

describe("people table import", () => {
  it("reads CSV with any of ; , tab and quoted cells", () => {
    expect(parseCsvTable('﻿E-mail;Name\r\na@x.com;"Doe; Jane"\n\n')).toEqual([
      ["E-mail", "Name"],
      ["a@x.com", "Doe; Jane"],
    ]);
    expect(parseCsvTable("email,name\nb@x.com,Bob")).toEqual([
      ["email", "name"],
      ["b@x.com", "Bob"],
    ]);
    expect(parseCsvTable("email\tname\nc@x.com\tCem")[1]).toEqual(["c@x.com", "Cem"]);
  });

  it("matches Turkish and English headers, parties by label, code or company, roles by key or name, task teams", () => {
    const table = [
      ["E-posta", "Ad Soyad", "Firma", "Rol", "Görev Ekibi"],
      ["Ayse@Example.com", "Ayşe Yılmaz", "Designer", designerRole.name, ""],
      ["bora@example.com", "Bora", "DSG", designerRole.key, "Designer"],
      ["cem@example.com", "Cem", "build co", "", ""],
      ["deniz@example.com", "", "", "", "Contractor"],
    ];
    const { rows, errors } = parsePeopleTable(table, options, "en");
    expect(errors).toEqual([]);
    expect(rows.map((r) => [r.line, r.email, r.slot, r.roles, r.errors])).toEqual([
      [2, "ayse@example.com", "tasarimci", ["tasarimci-yetki"], []],
      [3, "bora@example.com", "tasarimci", ["tasarimci-yetki"], []],
      [4, "cem@example.com", "yuklenici", [], []],
      [5, "deniz@example.com", "yuklenici", [], []],
    ]);
    expect(rows[0]!.name).toBe("Ayşe Yılmaz");
  });

  it("reports problems per row: address, duplicate, unknown party, team or role, team or role of another party", () => {
    const table = [
      ["email", "name", "company", "role", "task team"],
      ["", "No Mail", "", "", ""],
      ["not-an-address", "", "", "", ""],
      ["dup@example.com", "", "", "", ""],
      ["dup@example.com", "", "", "", ""],
      ["p@example.com", "", "Nowhere Ltd", "", ""],
      ["t@example.com", "", "", "", "Nobody"],
      ["r@example.com", "", "", "No Such Role", ""],
      ["o@example.com", "", "Designer", "", "Contractor"],
      ["q@example.com", "", "Designer", otherPartyRole.name, ""],
    ];
    const rows = parsePeopleTable(table, options, "en").rows;
    const problems = rows.map((r) => r.errors.join(" | "));
    expect(problems[0]).toContain("No e-mail address");
    expect(problems[1]).toContain("is not an e-mail address");
    expect(problems[2]).toBe("");
    expect(problems[3]).toContain("listed twice");
    expect(problems[4]).toContain('"Nowhere Ltd" is not a party');
    expect(problems[5]).toContain('"Nobody" is not a task team');
    expect(problems[6]).toContain('"No Such Role" is not in the template');
    expect(problems[7]).toContain("does not belong to");
    expect(problems[8]).toContain("belongs to another party");
    // Turkish texts.
    expect(parsePeopleTable(table, options, "tr").rows[4]!.errors[0]).toContain("projenin bir tarafı değil");
  });

  it("refuses a file without an e-mail column or rows", () => {
    expect(parsePeopleTable([["Name"], ["Bob"]], options, "en").errors[0]).toContain("e-mail column");
    expect(parsePeopleTable([["Email"]], options, "en").errors[0]).toContain("no people");
    expect(parsePeopleTable([], options, "en").errors[0]).toContain("empty");
    const many = [["Email"], ...Array.from({ length: 205 }, (_, i) => [`p${i}@example.com`])];
    const big = parsePeopleTable(many, options, "en");
    expect(big.rows).toHaveLength(200);
    expect(big.errors[0]).toContain("At most 200");
  });

  it("outcome per row: added (account), invited (none or pending, invitations on), listed only, shared mailbox, error", () => {
    const users = [
      { id: "1", email: "has@example.com", name: "Has", isAdmin: false, companyId: null },
      { id: "2", email: "pending@example.com", name: "Pending", isAdmin: false, companyId: null, pending: true },
    ] as UserDto[];
    const row = (email: string, errors: string[] = []) => ({ line: 2, email, name: "", slot: "", roles: [], errors });
    expect(importRowOutcome(row("has@example.com"), users, true)).toBe("added");
    expect(importRowOutcome(row("pending@example.com"), users, true)).toBe("invite");
    expect(importRowOutcome(row("new@example.com"), users, true)).toBe("invite");
    expect(importRowOutcome(row("new@example.com"), users, false)).toBe("no_account");
    expect(importRowOutcome(row("info@example.com"), users, true)).toBe("group_address");
    expect(importRowOutcome(row("bad", ["x"]), users, true)).toBe("error");
  });

  it("merges rows without problems into the list; an address already listed is updated, its administrator flag kept", () => {
    const people = [{ email: "keep@example.com", slot: "", roles: [], projectAdmin: true }];
    const merged = mergeImportedPeople(people, [
      { line: 2, email: "keep@example.com", name: "Keep", slot: "tasarimci", roles: ["tasarimci-yetki"], errors: [] },
      { line: 3, email: "new@example.com", name: "", slot: "", roles: [], errors: [] },
      { line: 4, email: "bad@example.com", name: "", slot: "", roles: [], errors: ["problem"] },
      { line: 5, email: "info@example.com", name: "", slot: "", roles: [], errors: [] },
    ]);
    expect(merged).toEqual([
      { email: "keep@example.com", name: "Keep", slot: "tasarimci", roles: ["tasarimci-yetki"], projectAdmin: true },
      { email: "new@example.com", slot: "", roles: [], projectAdmin: false },
    ]);
  });
});

describe("wizard request with invitations", () => {
  it("invites by default: names of people and the invitation language go into the request", () => {
    const d = draft({
      people: [
        { email: "New@Example.com", name: " New Person ", slot: "tasarimci", roles: [], projectAdmin: false },
        { email: "plain@example.com", slot: "", roles: [], projectAdmin: false },
      ],
    });
    expect(d.invite).toBe(true);
    const req = toRequest(d, template);
    expect(req.invite).toEqual({});
    expect(req.people).toEqual([{ email: "new@example.com", name: "New Person", slot: "tasarimci" }, { email: "plain@example.com" }]);
    expect(toRequest({ ...d, inviteLanguage: "tr" }, template).invite).toEqual({ language: "tr" });
  });

  it("without invitations or people the request has no invite and no names", () => {
    const d = draft({ invite: false, people: [{ email: "a@example.com", name: "A", slot: "", roles: [], projectAdmin: false }] });
    const req = toRequest(d, template);
    expect(req.invite).toBeUndefined();
    expect(req.people).toEqual([{ email: "a@example.com" }]);
    expect(toRequest(draft(), template).invite).toBeUndefined();
  });

  it("keeps the invitation choices when the template changes and in an older stored draft", () => {
    const d = withTemplate(draft({ invite: false, inviteLanguage: "tr" }), { kind: "builtin", id: "other" });
    expect([d.invite, d.inviteLanguage]).toEqual([false, "tr"]);
    const store = new Map<string, string>();
    const g = globalThis as { window?: unknown };
    g.window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } };
    try {
      const { invite: _i, inviteLanguage: _l, ...older } = draft();
      saveDraft("u-old", older as SetupDraft);
      expect(loadDraft("u-old")).toMatchObject({ invite: true, inviteLanguage: "" });
    } finally {
      delete g.window;
    }
  });
});

describe("accept page", () => {
  it("takes the token from the link's fragment", () => {
    expect(invitationToken("#7dcde_invite_abc")).toBe("7dcde_invite_abc");
    expect(invitationToken("#token=7dcde_invite_abc")).toBe("7dcde_invite_abc");
    expect(invitationToken("")).toBe("");
    expect(invitationToken("#%E0%A4%A")).toBe("");
  });
});
