# Project templates

A project template is a project's structure as one JSON document, without files, records or people:
folders and their permissions, naming standards, attributes, review workflows, the ISO 19650 CDE
settings and, since format v2, project roles, issue types, transmittal settings and the settings of
the Enterprise modules (RFI, submittals, meetings, forms). A project is created from a template in one
step (Projects → **New Project** → Quick Create, or `POST /api/v1/projects/from-template`) or with the
[project set-up wizard](PROJECT_SETUP_WIZARD.md), which adds explicit choices (parties and task teams,
people, folders, codes, approvers, ISO 19650 rules) on top of the template; any project can be exported
as a template (Project Settings → **Export as Template**).

Templates are Community ([map](../MAP.md#2-community-or-enterprise)): ISO 19650 requirements that are
documents (BEP, information requirements, delivery plans) are delivered as template folders, not as
features ([ISO 19650 conformance](../compliance/ISO19650.md#covered-by-documents-and-templates)).

## Built-in templates

`apps/server/templates/*.json`, read once at start-up; the file name is the template id.

| Id | Name (en / tr) | Content language | What it sets up |
|---|---|---|---|
| `iso19650-temel` | ISO 19650 Basic / ISO 19650 Temel | tr | Four parties, WIP per party, Shared (review, approval), Published, Archived; one naming standard; the D-7 transitions on ([CDE states](CDE_STATES.md#transitions)) |
| `iso19650-yapim-en` | ISO 19650 Construction Project (multi-party, English names) | en | Client, consultant, designer, contractor: general area with information requirement, BEP / delivery plan and standards folders, WIP per party, Shared (for review, for approval, construction documents), Published (+ as-built), Archived; document and correspondence naming with the UK NA codes; 8 workflows; ISO 19650 rules on; every v2 part |
| `iso19650-yapim-tr` | ISO 19650 Yapım Projesi (çok taraflı, Türkçe adlarla) | tr | The same in Turkish, with 3-letter Turkish discipline codes (MIM, INS, MEK …) |
| `metro-ibb` | Metro / Rail System (İBB type) | tr | Zone × discipline × document type skeleton, on-demand folders, party WIP areas 96–99 |
| `bina-veri-merkezi` | Building (data-centre type) | tr | Demo: state folders, discipline folders in WIP, a data-centre naming system and a four-step approval. Company codes are invented examples |

The two construction templates are generated from one source: see [authoring](#authoring-with-the-generator).

Suitability and revision codes follow ISO 19650 in the ISO templates (`codeScheme: "iso_uk_na"`: S0–S4,
A, B, CR; P01 / C01). The R00 scheme used on many sites is chosen per project in Project Settings → CDE
→ **Code Scheme** (`legacy_r`), or by a template with `"cde": { "codeScheme": "legacy_r" }`. Letter
revisions A, B, C … (projects imported from Autodesk Forma / ACC) are `letter_rev`.

## Format

```jsonc
{
  "format": "7d-cde/project-template@2",       // informative; @1 files are read the same way
  "name": { "tr": "…", "en": "…" },            // any value may be per language (below)
  "description": "…",
  "language": "en",                            // language of the content (folder names, codes)
  "family": "iso19650-yapim",                  // templates that differ only in language
  "slots": [{ "key": "yuklenici", "label": "Contractor", "party": "contractor", "code": "CTR" }],
  "dimensions": { "Discipline": ["A", "S", "M"] },
  "root": { "naming": "…", "attributes": ["…"], "grants": [{ "slot": "*", "level": "view" }] },
  "folders": [/* tree: name, state, stateLabel, naming, attributes, grants, gate, lazy, children, skeleton */],
  "namingStandards": [/* tokens {PROJE}, {slot:key}, {firma:key} */],
  "attributes": [{ "name": "Sheet / Document Title", "type": "text" }],
  "workflows": [/* steps with { slot } / { role } / { projectRole } assignees, review chains */],
  "modules": { "rfi": true, "forms": false },  // project module switches; missing = on
  "cde": { /* ISO 19650 settings, below */ },
  "notes": ["…"],
  // v2 parts
  "roles": [], "issues": {}, "transmittal": {}, "rfi": {}, "submittals": {}, "meetings": [], "forms": []
}
```

The types are in `packages/shared/src/platform/template.ts` (v1 keys) and
`packages/shared/src/platform/template-v2.ts` (v2 parts, per-language values); the server validates
with zod (`apps/server/src/projects/template-schemas.ts`) and checks references with
`checkProjectTemplate` (unknown slots, naming standards, attributes, workflows, project roles).
Unknown top-level keys are ignored.

The folder tree, slots, skeletons, on-demand folders and naming tokens are described in the header of
`template.ts`; the concept behind them in [concept](../product/CONCEPT.md).

### Per-language values

Any value may be an object whose keys are two-letter language codes, one of them `tr` or `en`:

```json
"name": { "tr": "ISO 19650 Temel", "en": "ISO 19650 Basic" },
"slots": [{ "key": "idare", "label": { "tr": "İdare", "en": "Client" } }]
```

The **project language** picks one value: `language` of the create or preview request, else the
requester's language; then English, then Turkish, then the first value. The template list
(`GET /templates?language=en`) and `GET /templates/:id` resolve the same way. The project language is
stored in the project settings (`settings.language`). A value can be any JSON, not only a string, so one
file can carry two folder trees; the built-in construction templates use two files instead, because
their discipline codes differ (3-letter Turkish codes and ISO 19650 role codes), and give their names,
descriptions and slot labels in both languages.

### `cde` block

Applied when the project is created ([CDE states](CDE_STATES.md#project-templates)); "export as
template" writes it back when the settings differ from the defaults.

| Key | Effect |
|---|---|
| `codeScheme` | `iso_uk_na` (default), `legacy_r` (R00, R01 …), `custom`, `letter_rev` (A, B, C …) |
| `enforceTransitions` | The transition table is enforced from the start (D-8) |
| `wipPolicy`, `adminSeesWip` | `team_only`: a task team's WIP is closed to the other teams |
| `archiveFolder` | Folder path of the archive (D-10) |
| `transitions` | The transition table; `workflow` names a workflow of the template |
| `containerStandard` | Name of a naming standard of the template: the **Document Code Standard**, so document codes are unique from WIP on ([document codes](DOCUMENT_CODES.md)) |
| `taskTeams` | `[{ "slot": "yuklenici", "lead": true }, …]`: the slots whose companies get a task team, and the lead appointed party's team. Absent: one team per mapped slot ([task teams](TASK_TEAMS.md)) |

The ISO templates set every key; their naming standard is the document code standard.

### v2 parts

| Part | Applied by | What happens on creation |
|---|---|---|
| `roles`: `[{ key, name, description?, color?, slot? }]` | core | Project roles (kind `role`), created before the workflows so a step can be assigned to one with `{ "projectRole": "<key>" }`. The description defaults to the slot's label. People are added by the administrator |
| `issues`: `{ categories: [{ category, types[] }], customFields? }` | core | Stored in the project settings (`settings.issueTypes`) and offered, grouped by category, when an issue is created (viewer, markup). `customFields` are kept (`settings.issueFields`) and reported: issues have no custom fields yet |
| `transmittal`: `{ name?, numbering?, attributes? }` | core (works engine) | The built-in transmittal work type gets the name and the number pattern (work numbering tokens: `{Proje}`, `{Gönderen}`, `{Alıcı}`, `{YYYY}`, `{0000}` …; tokens are syntax and the same in every language). An invalid pattern is reported, not applied. `attributes` are informative (the cover sheet columns are fixed) |
| `rfi`: `{ types, defaultType, categories, responseDays, numbering, workflow, permissions }` | **Manage** | RFI types (disciplines), categories, answer days, number pattern, default workflow (a template workflow of kind `rfi`), who creates / coordinates / reviews / manages / watches (slot or project role keys) |
| `submittals`: `{ itemTypes, responses, specSections, responseDays, numbering, workflow, watchers }` | **Manage** | Material / method approval item types, the responses and the outcome each stands for, specification sections, default workflow (kind `submittal`) |
| `meetings`: `[{ name, agenda[], attendees?, minutesFolder? }]` | **Manage** | Meeting templates: a meeting kind with its standard agenda, invited slots and the folder for the minutes |
| `forms`: `[{ key, name, category?, workflow?, sections: [{ name, editor? }] }]` | **Field** | Form templates with their sections, the slot filling each section and the approval workflow (kind `form`) |

A part whose project module switch is off (`modules`) is skipped. The create answer reports every part:

```json
"parts": [
  { "part": "roles", "module": null, "status": "applied", "count": 11 },
  { "part": "transmittal", "module": null, "status": "partial", "count": 1, "notes": ["…"] },
  { "part": "rfi", "module": "manage", "status": "skipped", "reason": "module_not_installed" }
]
```

`status`: `applied`, `partial` (applied with notes on what was not), `skipped`, `failed`. `reason`:
`module_not_installed` (the module is not installed or not licensed), `module_off` (project switch),
`unsupported` (the installed module version does not apply this part), `error` (the handler threw;
the project is kept and the message is in `notes`). The same list goes to the audit entry
`project.created_from_template`. `POST /templates/preview` answers `parts: [{ part, module, available }]`
so a wizard can say beforehand what will be skipped.

## Module hook

The core never imports module code ([boundary rules](../modules/README.md#boundary-rules)); a module
applies its parts through a capability (`apps/server/src/sdk/capabilities.ts`, SDK 0.13.0):

| Capability | Handlers |
|---|---|
| `manage.templateApply` | `rfi(ctx, TemplateRfiSettings)`, `submittals(ctx, TemplateSubmittalSettings)`, `meetings(ctx, TemplateMeeting[])` |
| `field.templateApply` | `forms(ctx, TemplateForm[])` |

Each handler is optional and returns `{ status: "applied" | "partial", count?, notes? }`. It runs after
the project exists, once per part, with `TemplateApplyContext`: `db`, `projectId`, `projectCode`,
`userId`, `language` (names it writes), `requesterLanguage` (notes it returns), the slots (label, mapped
company, code), and what the core created from the template: workflow template ids by name, project
role ids by `roles[].key`, folder ids by path. A module registers it while it loads:

```ts
provideCapability("manage.templateApply", {
  async rfi(ctx, rfi) {
    // update the project's RFI work type: field options, dueDays, numbering, default workflow …
    return { status: "applied", count: 1 };
  },
});
```

What each module applies, and what is left: [Manage](../modules/manage.md#project-templates),
[Field](../modules/field.md#project-templates). The handlers are on the `feat/template-apply` branches
of `sitekeep-manage` and `sitekeep-field` and need SDK 0.13.0; until those versions are released and
pinned, the module parts are reported as `unsupported`. Core work types (RFI, submittal, meeting,
transmittal) are changed through the SDK's `patchWorkType(db, projectId, key, { name, numberingPattern,
fieldOptions, settings, defaultWorkflowTemplateId })`, which checks the number pattern and reports what
it could not apply.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/templates?language=` | Built-in templates: id, name, description, `language`, `family`, `parts`, slots, dimensions, counts |
| GET | `/api/v1/templates/:id?language=` | The template JSON, per-language values resolved |
| POST | `/api/v1/templates/preview` | `{ templateId \| template, code?, slotCompanies, slotCodes, dimensions, language?, setup? }` → errors, warnings, counts, folder tree, `parts` |
| POST | `/api/v1/projects/setup/preview` | The set-up wizard's dry run (system administrators): the preview plus the project code and the people's accounts ([wizard](PROJECT_SETUP_WIZARD.md#server)) |
| POST | `/api/v1/projects/from-template` | The same plus `code`, `name`, `description`, and the wizard's `setup`, `details`, `people` (system administrators) → the project, `warnings`, `counts`, `parts`, `people` |
| GET | `/api/v1/projects/:pid/export-template` | The project as a template: folders, grants by slot, naming, attributes, workflows (project-role steps as `{ projectRole }`), `roles`, `modules`, `cde` (with `containerStandard`) |

## Authoring with the generator

Large templates are written as code and generated, so the language versions stay identical:
`apps/server/templates/src/iso19650-yapim.mjs` writes `iso19650-yapim-tr.json` and
`iso19650-yapim-en.json`. Do not edit the JSON files; change the source and run (Node 22):

```bash
node apps/server/templates/src/iso19650-yapim.mjs          # regenerate both files
node apps/server/templates/src/iso19650-yapim.mjs --check  # fail when the files are out of date
```

`apps/server/test/projects/template-v2.test.ts` runs the check, so a hand edit or a forgotten
regeneration fails the tests. In the source, `t({ tr, en })` picks the language of the file being
written and `both({ tr, en })` writes a per-language value (names shown in the template list).

To add a template: put the JSON (or a generator writing it) in `apps/server/templates/`, add its id to
`PROJECT_TEMPLATES` in `packages/cde-tools/src/tools/dev.ts` (developer tools) and to the built-in list
in `apps/server/test/projects/templates.test.ts`, which checks that every built-in template parses,
passes `checkProjectTemplate` and previews without errors.

## Planned

- `perDiscipline` project roles (one role per discipline value, resolved from the file's Role field by
  `assigneeRule`).
- Working-day calendars for step durations, and holidays.
- Importing an Autodesk Forma naming standard workbook into a template's naming standard.
- A selectable naming profile following the 2026 Turkish Ministry of Environment, Urbanisation and
  Climate Change (ÇŞB) coding; the Turkish construction template uses the 3-letter discipline codes
  common on sites.
- Issue custom fields.
- The set-up wizard is done ([project set-up wizard](PROJECT_SETUP_WIZARD.md)); its planned additions
  (invitations, disciplines step, verification run) are listed there.

## Tests

| What | Test |
|---|---|
| Built-in templates parse, check and preview; projects from them; export round trip | `apps/server/test/projects/templates.test.ts` |
| Construction templates: generator up to date, both languages, `cde` block, teams, roles, issue types, transmittal, folders for ISO-8 / ISO-14, on-demand folders, part report without modules; per-language values; project-role steps and export; module hook with fake handlers; anonymised demo | `apps/server/test/projects/template-v2.test.ts` |
| Template `cde` block applied and exported | `apps/server/test/cde/settings.test.ts` |
| `patchWorkType` (SDK) | `apps/server/test/projects/template-v2.test.ts` |
| Module parts against the real modules (run when the installed version has the handler) | `apps/server/test/modules/manage/template-apply.test.ts`, `apps/server/test/modules/field/template-apply.test.ts` |
| A project from the English construction template in the browser (with and without modules) | `e2e/specs/project-templates.spec.ts` |
