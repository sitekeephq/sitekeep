# Project set-up wizard

Projects → **New Project** offers two ways to create a project:

- **Quick Create**: a template (or a blank project), a name and a code. Everything else is what the
  template sets; parties, people and settings are changed later in Project Settings.
- **Setup Wizard**: eleven steps on top of a [project template](PROJECT_TEMPLATES.md). Every choice of
  the wizard is an explicit override of the template, checked by the same template checks, so a wizard
  project is a template project plus these choices.

Community ([map](../MAP.md#2-community-or-enterprise)). Only system administrators create projects,
with either path. The design and its background (in Turkish) are in
PROJE_KURULUM_SIHIRBAZI.md.

## Steps

| # | Step | What is chosen | Becomes |
|---|---|---|---|
| 1 | Language | The project language (English or Turkish): folder, workflow and list names. The interface language stays each person's own | `language` of the request: picks the template file of a family (`iso19650-yapim-en` / `-tr`) and the per-language values |
| 2 | Template | A built-in template or a template file. The card shows what the template brings (parties, naming standards, workflows, ISO 19650 rules) and each v2 part with who applies it: SiteKeep Community, or SiteKeep Manage / Field. A part whose module is not installed shows **Requires SiteKeep Manage** and is skipped; the rest of the template is set up. Parts with a project module switch (issues, transmittals, RFI, submittals, meetings, forms) can be left out | `setup.modules` (an off switch reports the part as `skipped`, `module_off`) |
| 3 | Project basics | Name, code (proposed from the name), description, start and end dates, location, client | `code`, `name`, `description`; `details` → project settings (`settings.details`, returned as `details` on the project) |
| 4 | Parties and task teams | A company per party (pick or create, with its short code), the party code used by the naming tokens, more parties (e.g. the client's technical unit), which parties get a task team, and the lead appointed party | `slotCompanies`, `slotCodes`, `setup.parties` (added slots), `setup.taskTeams` (replaces `cde.taskTeams`) |
| 5 | People and roles | People by e-mail (several at once, or [from a CSV / Excel file](#importing-people)), the party each joins and the template's project roles; project administrators; **Invite People Without an Account** (on by default) and the invitation language | `people`: members in the company of their party, in its task team, with the roles. With `invite`, addresses without an account are [invited](INVITATIONS.md) (a name can be given); without it they are listed and not added. Shared mailboxes (info@, noreply@ …) are never added |
| 6 | Folder structure | The tree of the template (server preview), the skeleton dimensions (disciplines, zones …), folders added below template folders, template folders left out | `dimensions`, `setup.folders.add` / `remove` |
| 7 | Document codes | The document code standard; the codes of the list fields of each naming standard (one per line, code then description; fields filled from the project and party codes are shown resolved); a sample name checked against the standard while typing | `setup.containerStandard`, `setup.naming` |
| 8 | Revision and suitability codes | ISO 19650 (UK NA: S0–S4, A, B, CR; P01.01 / P01 / C01) or legacy R00, with the codes each state allows | `setup.cde.codeScheme` |
| 9 | Workflows | The ISO 19650 transition table (D-7) with the workflow of each review transition, and every workflow step: duration, rule (any / all) and approvers: a party's task team, a project role or the project administrators | `setup.transitions`, `setup.workflows` |
| 10 | ISO 19650 rules | Enforce the transition table; who sees work in progress (folder permissions / owning task team only); whether project administrators see all WIP | `setup.cde.enforceTransitions`, `wipPolicy`, `adminSeesWip` |
| 11 | Summary | The choices (invitations on or off, their language), the task teams with the lead, and the server's dry run: errors, warnings (parties without a company, people without an account when invitations are off), each person with what will happen (added, will be invited, no account, shared mailbox), folder and workflow counts, and per part whether it will be applied, is switched off or requires a module | `POST /projects/setup/preview`; **Create Project** sends the request to `POST /projects/from-template` |

After creation the wizard shows the report of the create answer: per part **Applied**, **Partly
Applied**, **Skipped** or **Failed** with the reason (module not installed, switched off, the installed
module version does not apply it, error) and the notes, the people (added, invited, no account, shared
mailbox) and the warnings; **Open Project** opens it. An invited person whose e-mail was not sent (no
e-mail server, e-mail switched off in the Privacy Centre, or sending failed) has the invitation link
next to it, to copy and hand over.

"Next" is blocked while the step has a problem (listed under the step); each step checks only its own
choices (`apps/web/src/features/projects/setup/steps.ts`), the summary checks everything and runs the
server's dry run, and **Create Project** is enabled only when the dry run passes.

### Limits

What the wizard may change is kept within the template's structure, so ISO 19650 behaviour does not
depend on the choices:

- Folders: at most 50 additions and removals. New folders go below folders the template declares (they
  inherit the state, permissions and naming of their parent). A folder can be left out only when neither
  it nor anything below it carries a CDE state or a skeleton, and the template does not use it (archive
  folder, review copy targets, meeting minutes folders).
- Naming: only the codes of list fields change; fields, their order and the separator stay.
- Workflows: assignees, duration and rule of existing steps; steps are not added or removed. Review
  transitions take a workflow of the template or any approved review; modes stay those of the template.
- Code profiles: ISO 19650 and legacy R00. A project's own suitability list (`custom`) is set in Project
  Settings → CDE after creation.
- People: at most 200. Without an account they are invited ([invitations](INVITATIONS.md)) or, with
  invitations off, reported.
- Parties: at most 10 added; keys are generated from the name.

### Importing people

**Import from CSV / Excel…** in the people step reads a `.csv` (`;`, `,` or tab; UTF-8 or the usual
Windows encodings) or `.xlsx` file (first sheet), at most 2 MB and 200 rows. The first row is the
header; columns are found by name (case, spaces and Turkish accents ignored):

| Column | Header names | Matched against |
|---|---|---|
| E-mail (required) | E-mail, Email, Mail, E-posta | — |
| Name | Name, Full name, Ad, Ad Soyad, İsim | the invitation's name |
| Company / party | Company, Party, Organisation, Firma, Şirket, Taraf | a party's key, name or code, or the company chosen for it in step 4 |
| Role | Role, Roles, Project role, Rol, Roller (several: `;` `,` or `\|`) | a project role's key or name |
| Task team | Task team, Team, Görev Ekibi, Ekip | a party with a task team; the person joins that party (it must be the same as the company column when both are given) |

The preview lists every row with its result: **has an account: added**, **no account: invited** (or
**listed only** with invitations off), **shared mailbox: not added**, or **not added** with the
problems (no or invalid address, listed twice, unknown party, team or role, a team or role of another
party). **Add N People** adds the rows without problems to the list (an address already listed gets
the file's party, roles and name; its administrator flag stays). The server only reads the file
(`POST /projects/setup/people-file`); matching and checks are in
`packages/shared/src/platform/people-import.ts`.

### Draft

The wizard keeps its state in the browser, per user (`localStorage`,
`sitekeep.projectSetup.draft.v1.<userId>`), on every change. Opening **New Project** with a draft goes
straight to the wizard and says it was restored; **Start Over** discards it. The draft is removed when
the project is created. Storage that is blocked or full is ignored; the wizard works without it.
Nothing is stored on the server before **Create Project**.

## Server

The wizard's choices are a `setup` object (`ProjectSetupOverrides`,
`packages/shared/src/platform/project-setup.ts`) on the template preview and create requests. The
server applies them to the template (`applySetupOverrides`), parses the result again with the template
schema and runs `checkProjectTemplate` and the usual preparation on it: a wizard request without
choices is exactly a template request.

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/api/v1/templates/preview` | signed-in users | Also takes `setup`, `details` and `people`; their problems are `errors` |
| POST | `/api/v1/projects/setup/preview` | system administrators | The dry run: the preview with the choices, plus the project code checked against active projects and the people resolved (`people: [{ email, status: "added" \| "invite" \| "no_account" \| "group_address", userId?, name? }]`, warnings for the last two). Writes nothing; read-only API tokens may call it |
| POST | `/api/v1/projects/from-template` | system administrators | Also takes `setup`, `details`, `people`, `invite`. Answer: the project (with `details`), `warnings`, `counts`, `parts`, `people` (`invited` people with `invitation: { id, expiresAt, mailed, url?, mailSkipped? }`) |
| POST | `/api/v1/projects/setup/people-file` | system administrators | `{ fileName, content }` (base64 of a `.csv` / `.xlsx`, at most 4 MB of base64) → `{ table }`: the first sheet as strings |

```jsonc
{
  "templateId": "iso19650-yapim-en", "language": "en", "code": "ZAVM", "name": "Zafer Shopping Centre",
  "slotCompanies": { "idare": "…", "tasarimci": "…", "teknik": "…" },
  "setup": {
    "parties": [{ "key": "teknik", "label": "Client technical unit", "party": "client", "code": "CTU" }],
    "taskTeams": [{ "slot": "idare" }, { "slot": "tasarimci", "lead": true }, { "slot": "teknik" }],
    "folders": { "add": [{ "parent": "00-GENERAL", "name": "09-Photographs" }], "remove": ["00-GENERAL/08-Site Handover Records"] },
    "containerStandard": "ISO 19650 Document Naming",
    "naming": [{ "standard": "ISO 19650 Document Naming", "field": "Volume", "values": [{ "code": "ZZ" }, { "code": "B1", "description": "Block 1" }] }],
    "workflows": [{ "workflow": "Approval: …", "step": 1, "assignees": [{ "slot": "idare" }, { "projectRole": "idare-onay" }], "rule": "all", "days": 3 }],
    "transitions": [{ "from": "wip", "to": "shared", "workflow": "Designer internal check → share for approval" }],
    "cde": { "codeScheme": "legacy_r", "enforceTransitions": true, "wipPolicy": "team_only", "adminSeesWip": false },
    "modules": { "meetings": false }
  },
  "details": { "startDate": "2026-12-01", "endDate": "2028-06-30", "location": "Istanbul", "client": "…" },
  "people": [
    { "email": "ayse@designer.example", "slot": "tasarimci", "roles": ["tasarimci-yetki"], "projectAdmin": false },
    { "email": "new.person@client.example", "name": "New Person", "slot": "idare" }
  ],
  "invite": { "language": "tr" }
}
```

Creation writes the project, folders, permissions, naming standards, attributes, project roles,
workflows, CDE settings, slots, members of the wizard with their roles, the default roles and the task
teams (with the lead and the WIP owner teams) in **one transaction**; a failure leaves nothing behind.
People invited by the wizard become pending members in the same transaction; their invitation e-mails
(or links) follow once the project exists.
The v2 parts are applied afterwards, each reported on its own, as for any template
([project templates](PROJECT_TEMPLATES.md#v2-parts)). The audit entry
`project.created_from_template` records the choices (`setup`) and the people with their outcome; each
invitation has its own `invitation.created` row.

## Code

| What | Where |
|---|---|
| Choices, checks, folder options, shared mailboxes (pure, shared by server and web) | `packages/shared/src/platform/project-setup.ts` |
| Request schema (`setup`, `details`, `people`) | `apps/server/src/projects/template-schemas.ts` |
| Applying the choices, dry run, people, one transaction | `apps/server/src/projects/template-apply.ts` (`requestTemplate`, `dryRunProjectSetup`, `createProjectFromTemplate`) |
| Routes | `apps/server/src/templates/routes.ts` |
| New Project dialog, quick create | `apps/web/src/features/projects/components/NewProjectWizard.tsx` |
| Wizard, steps, draft | `apps/web/src/features/projects/setup/` |
| People from CSV / Excel: columns, matching, row checks | `packages/shared/src/platform/people-import.ts`, `apps/web/src/features/projects/setup/PeopleImport.tsx` |
| Invitations | [invitations](INVITATIONS.md) |

## Tests

| What | Test |
|---|---|
| Choices applied to a copy, refused outside the limits, references checked; dry run (choices, code taken, accounts, administrators only); create with choices: task teams from parties and the lead, people in their party's company, team and roles, CDE settings, document code standard and codes, approvers, transition workflow, folders, details, part report with a switched-off module, audit; a request without choices equals a template request | `apps/server/test/projects/setup-wizard.test.ts` |
| Step validation, request built from the draft, template change, code proposal, browser draft | `apps/web/test/projects/setup-wizard.test.ts` |
| The full wizard with the English construction template (teams, lead, people, folder, codes profile, approver, ISO rules, part report with and without modules); the draft after a reload; quick create | `e2e/specs/project-setup-wizard.spec.ts` |
| iPhone: every step without sideways scrolling, a project created | `e2e/specs/mobile-project-setup-wizard.spec.ts` |
| Invitations in the dry run and on create, people files; people import, the request with invitations | `apps/server/test/auth/invitations.test.ts`, `apps/web/test/projects/invitations.test.ts` |
| A new address invited, the link accepted, the project visible; people from a CSV file | `e2e/specs/invitations.spec.ts` |

## Planned

- Disciplines and levels as their own step (today: the skeleton dimensions and the naming codes).
- Working-day calendars for step durations; importing a Forma naming workbook; the ÇŞB 2026 naming
  profile ([project templates](PROJECT_TEMPLATES.md#planned)).
- A set-up report (PDF) and an end-to-end trial (WIP → check → Shared → approval → Published) after
  creation, as in the design's verification step.
