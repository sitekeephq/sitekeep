# Delivery plan: TIDP and MIDP (ISO-7)

ISO 19650-2 asks each task team to plan what it will deliver, by when, and in which form: the task
information delivery plan (TIDP, §5.4.4). The lead appointed party aggregates the TIDPs into the
master information delivery plan (MIDP, §5.4.5), against the project's milestones and the
information container breakdown structure (§5.4.3). SiteKeep Community keeps a simple delivery plan
beside the documents and reads each planned deliverable's status from the CDE. Part of the
[CDE states](CDE_STATES.md) work; conformance: [ISO 19650](../compliance/ISO19650.md).

The plan is a feature, not a document: a project can still keep its MIDP as a spreadsheet in
`03-BIM Execution Plan and Delivery Plans` of the construction templates; the export below gives one.

## Model

| Concept | Where it lives | Notes |
|---|---|---|
| Milestone | `delivery_milestones (project_id, code, name, due_date, position)`, migration 0051 | Project-level dates of the MIDP ("M1 · Concept Design", 2027-03-31). A milestone without a date is allowed until the dates are agreed |
| Planned deliverable | `delivery_deliverables (project_id, team_id, code, code_norm, title, discipline, doc_type, targets, due_shared, due_published, notes, position)` | One row per information container the team will deliver. `code_norm` (the code upper-cased, as in the [document code register](DOCUMENT_CODES.md)) is unique per project. `targets` is the planned suitability and revision per milestone (`[{ milestoneId, suitabilityCode, revisionCode }]`) |
| TIDP | the rows of one task team (`team_id`, a [task team](TASK_TEAMS.md)) | A deleted team leaves its rows in the MIDP without a team |
| MIDP | every row, with the milestones | |
| TIDP lead | `delivery_team_leads (team_id, project_id, user_id)` | A member of the team who edits its TIDP besides the project administrators |

## The planned document code

The code is checked when a row is saved or imported, against the project's naming standard: the
**Document Code Standard** (Project Settings → CDE, `container_standard_id`), else any naming standard
of the project. A code typed in lower case is accepted when its upper-case form follows the standard;
with `allowSuffix`, a suffix after the last field is not part of the code. A project without a naming
standard takes any code. Two rows cannot plan the same code (409).

## Status and late

The status of a row comes from the CDE, not from the person who planned it:

1. The [document code register](DOCUMENT_CODES.md) gives the information container of the code; live
   files carrying the code (`files.document_code`) count as well, for codes from before the register.
2. The most advanced live file of the container gives the status: **Published** (a file in a Published
   folder, or an Archived publication), **Shared** (a file in a Shared folder that is not *withdrawn*),
   **Work in Progress** (any other file: WIP, a withdrawn Shared copy, a folder without a state),
   **Not started** (no file).
3. **Late** when `due_shared` is before today and the status is below Shared, or `due_published` is
   before today and the status is below Published (the server's day, UTC). Published is reported first.

The row also shows the matched document: its state, revision and suitability, and its name with a link
to the file. The name and link are given only to people who can see the file's folder: folder
permissions and the task-team WIP rule apply ([task teams](TASK_TEAMS.md)). Someone kept out (for
example a project administrator while **Project Administrators See All WIP** is off) sees the status
and the codes, not the file. The status is plan data, so it is not withheld.

## Who sees and edits

| Who | Sees | Edits |
|---|---|---|
| Project administrator | The whole MIDP: every TIDP and the milestones | Milestones, TIDP leads, every row |
| TIDP lead | The TIDPs of their teams and the team they lead | The rows of the team they lead (create, edit, delete, import) |
| Member of a task team | The TIDPs of their teams | Nothing |
| Member without a task team | Nothing (an empty plan) | Nothing |

A lead cannot move a row into a team they do not lead, nor import rows of another team.

## API

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/v1/projects/:pid/delivery-plan` | members | `DeliveryPlanDto`: `milestones`, `teams` (with `leadUserId`, `canEdit`, `count`, `late`), `deliverables` (with `status`, `late`, `registered`, `document`, `canEdit`), `canManage`, `today`. `?teamId=` one TIDP |
| POST / PATCH / DELETE | `/api/v1/projects/:pid/delivery-plan/milestones[/:mid]` | project administrators | `{ code?, name, dueDate?, position? }`. Names are unique per project. Deleting a milestone removes its targets from every row |
| PUT | `/api/v1/projects/:pid/delivery-plan/teams/:tid/lead` | project administrators | `{ userId \| null }`; the user must be a member of the team |
| POST | `/api/v1/projects/:pid/delivery-plan/deliverables` | administrators, the team's lead | `{ teamId, code, title, discipline?, docType?, targets?, dueShared?, duePublished?, notes? }`. Dates `YYYY-MM-DD`; Published not before Shared. Suitability and revision codes are normalised (`s2` → `S2`, `p1` → `P01`) and must be codes of the project's profile |
| PATCH / DELETE | `/api/v1/projects/:pid/delivery-plan/deliverables/:id` | administrators, the team's lead | Any subset of the fields above |
| GET | `/api/v1/projects/:pid/delivery-plan/export?format=xlsx\|csv&teamId=` | members | What the caller sees |
| POST | `/api/v1/projects/:pid/delivery-plan/import` | administrators, leads | `{ fileName, content (base64), teamId?, dryRun? }` → `DeliveryPlanImportReportDto` |

Types: `packages/shared/src/documents/delivery-plan.ts`. Server: `apps/server/src/cde/delivery-plan.ts`
(scope, code check, status), `apps/server/src/cde/delivery-plan-routes.ts`.

## Export and import

The export (XLSX with a second sheet of milestones, or CSV with `;` for Excel) has the columns
Document Code, Title, Task Team, Discipline, Type, one column per milestone (`M1 · Concept Design`,
cells `S2 / P01`), Due Shared, Due Published, Notes, and the information columns Status, Late and
Document. Headers are in the requester's language.

The import reads the first sheet of an `.xlsx` file or a CSV (`;`, `,` or tab; UTF-8, UTF-16 or
Windows-1254), with the existing XLSX reader, no new dependency:

- Headers are matched in English or Turkish, case-insensitively, by the exported names and a few
  aliases (`Code`, `Kod`, `Team`, `Ekip` …). A Document Code column is required; Status, Late and
  Document are ignored. A milestone column is matched by its header, code or name.
- Rows are matched by document code: a new code adds a row, an existing one updates it. Only the
  columns present change; an empty milestone cell clears that target.
- The team is the Task Team cell (name or code), else the team chosen for the import, else the row's
  own team.
- Dates: `YYYY-MM-DD`, `DD.MM.YYYY`, `DD/MM/YYYY` or an Excel date.
- All or nothing: a file with any error writes nothing and lists the errors by spreadsheet row. A dry
  run (`dryRun: true`, **Check** in the dialog) reports what would change. At most 5000 rows.

## Audit

| Action | Details |
|---|---|
| `delivery_plan.milestone_created`, `_updated`, `_deleted` | name, code, date (before and after; targets removed) |
| `delivery_plan.lead_set` | team, `userId`, `previousUserId` |
| `delivery_plan.deliverable_created`, `_updated`, `_deleted` | code, title, team; on update the changed fields with their values before and after |
| `delivery_plan.imported` | file name, team, codes created, codes updated with their changed fields |
| `delivery_plan.exported` | format, row count, team |

## Project templates

A template may seed the milestones with an optional `deliveryPlan` block
([project templates](PROJECT_TEMPLATES.md#deliveryplan-block)):

```json
"deliveryPlan": {
  "milestones": [
    { "code": "M1", "name": { "tr": "Konsept Tasarım", "en": "Concept Design" }, "offsetDays": 90 }
  ]
}
```

`offsetDays` dates the milestone that many days after the project start (the set-up wizard's start
date, else the creation day); without it the milestone has no date. "Export as template" writes the
milestones back with `offsetDays` counted from the project's creation. The ISO 19650 templates
(`iso19650-temel`, `iso19650-yapim-tr`, `iso19650-yapim-en`) seed four or five stage milestones.

## Web

Project menu → **Delivery Plan** (`/projects/:pid/delivery-plan`,
`apps/web/src/features/delivery-plan/DeliveryPlanPage.tsx`):

- **Master Plan (MIDP)** tab: the milestones (administrators add, edit and delete them), the rows of
  every team the user sees, filters by team, status, **Late Only** and a search on code and title.
- One **TIDP** tab per team: the team's lead (administrators choose among the team's members) and its
  rows.
- **Add Deliverable** and the row actions for administrators and leads; **Import** (choose a file,
  **Check**, then **Import**); **Export Excel** / **Export CSV** of the current tab.
- Status badges (Not Started, Work in Progress, Shared, Published), a red **Late** badge and date, and
  the matched document with its revision and suitability.

## Tests

ISO19650-2 5.4.4 / 5.4.5:

- `apps/server/test/cde/delivery-plan.test.ts`: milestones from the template, code check against the
  naming standard, lead and member rights, MIDP and TIDP views, status from WIP to Published and the
  late rule, the WIP rule on the matched document, XLSX / CSV export, import (dry run, errors, English
  and Turkish headers), audit events, template export.
- `packages/shared/test/delivery-plan.test.ts`: status and late rules, date and target cells, header
  matching, the template check.
- e2e `e2e/specs/delivery-plan.spec.ts`: plan a deliverable, see its status follow an upload, filter,
  export; a member of another team does not see it. Core only.

## Not included

Kept simple on purpose: no responsibility matrix (§5.4.2) beyond the responsible team, no
dependencies between deliverables, no notifications for late rows, no history of plan revisions other
than the audit log, no Gantt view.
