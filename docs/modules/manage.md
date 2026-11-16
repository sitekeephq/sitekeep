# Manage module

SiteKeep Manage: project management categories. These are RFIs (bilgi talebi), submittals (teknik onay) and their
packages, meetings and minutes (tutanak), actions, formal correspondence (yazışma) and the specification register. Product description:
SiteKeep editions and modules §2, §3.2.

| | |
|---|---|
| Repository | [sitekeephq/sitekeep-manage](https://github.com/sitekeephq/sitekeep-manage) (private); local clone `~/Desktop/7dimensions/sitekeep-manage` |
| Package | `@sitekeephq/sitekeep-ee-manage` (GitHub Packages) |
| Version in this repository | `0.5.0` (`apps/server/package.json`, `apps/web/package.json`) |
| SDK used | `@sitekeephq/sitekeep-sdk` `>=0.16.0 <1.0.0` |
| ID | `manage` (`SITEKEEP_MODULES`) |

## Boundary: the Works engine is in the core

"Works" (İşler: work types, records, numbering, links, events, workflow, attachments, letter and transmittal
infrastructure, receipt record) is in the core. The reasons:

- **Transmittal** is ISO 19650's information transmittal and is in Community (product document §6, ISO-6). As a work category it uses this engine.
- The automatic transmittal from a review (`works/transmittal-listener.ts`) and general work items with workflow templates also use this engine.
- Letter data (subject, recipient, signatory, PDF, email, KEP) is shared with the transmittal cover and the sending channels.

Manage adds its own categories and the tools specific to them on top of this engine. When it is not installed,
the `correspondence`, `rfi`, `submittals`, `meetings` and `spec` project switches are **off in every project**
(`apps/server/src/projects/modules.ts` `PRODUCT_SWITCHES`). The stored setting is kept; when Manage is
reinstalled, it returns to its previous state. The switches that are off apply everywhere through the existing mechanism. A new record
gets `403 module_disabled`. The Works sections in the menu, the "+ New" options, the Ask tools, the report
catalogue and the Modules tab do not show these categories. Existing records can be opened and read.

Parts moved into the core:

| Core | What |
|---|---|
| `works/detail.ts` | Detail attachments of work items with workflow (`buildDetail`), visible work items, workflow status |
| `works/meeting-data.ts` | Reading meeting data (detail and reports) |
| `works/routes/work-flow.ts` | `submit`, `respond`, `revise`, `cancel` and the automatic transmittal listener |
| `works/letter-translate.ts` | Letter translation (through the AI gate) |
| `contracts/works.ts` | AI schemas for actions, RFI draft and "Drop and save" (the AI module also validates them) |
| `reports/datasets-works.ts` | `correspondence`, `rfis`, `submittals`, `meetings`, `actions` datasets; registered only when Manage is installed |
| web `BuildPanel` | The workflow panel in the work detail |

## What is in the package

| Location (in the repository) | Contents |
|---|---|
| `server/index.ts` | Module: routes |
| `server/routes/build-works.ts` | Submittal package items, meetings (agenda, minutes, next meeting, PDF), submittal register and RFI log (Excel), import from the specification register, numbering preset, AI action suggestion and RFI draft |
| `server/routes/intake.ts`, `intake*.ts` | "Drop and save": record draft from a PDF / email / Office file, optional AI pass |
| `server/build.ts`, `meetings.ts`, `build-ai.ts` | Registers, meetings, AI drafts |
| `web/` | Package items, meeting box, register views, import, RFI draft, "Drop and save" (`manage.ui`) |

It has no tables or migrations of its own; the records are in the core's `works` tables.

## Where it connects to the core

| Core | How |
|---|---|
| Routes | `ServerModule.routes` |
| Project switches | `PRODUCT_SWITCHES.manage` (off if not installed) |
| Report datasets | In the core, with `moduleInstalled("manage")` |
| Work detail: package items, meeting | web `manage.ui` (`PackageItems`, `MeetingBox`) |
| Works: register and log views | `manage.ui.RegisterView` |
| Specification analysis: import the register | `manage.ui.ImportDialog` |
| New work item: RFI draft; "+ New": record from file, dropping a file onto Works | `manage.ui.RfiDraftBox`, `FileRecordDialog`, `FileDropZone` |
| Project Settings → Modules | Manage switches are visible only when installed |
| `manage.workExists`, `manage.workLabels` | Provided by the core's Works engine (used by Cost, Coordinate) |
| Project templates: the template's `rfi`, `submittals`, `meetings` | `manage.templateApply` ([below](#project-templates)) |

## Project templates

A project template (format v2, [project templates](../features/PROJECT_TEMPLATES.md#module-hook)) may carry
RFI, submittal and meeting settings. The core hands them to Manage through the `manage.templateApply`
capability after the project is created; without Manage, or with a version without the handler, they are
skipped and reported (`module_not_installed` / `unsupported`).

| Part | Applied (branch `feat/template-apply` of `sitekeep-manage`, `server/template-apply.ts`) | Not applied yet (reported as a note) |
|---|---|---|
| `rfi` | On the project's RFI work type through the SDK's `patchWorkType`: `types` → options of the `disiplin` field (the `defaultType` first), `categories` → `kategori`, `responseDays` → `dueDays`, `numbering` → number pattern (checked), `workflow` → the default workflow | `permissions` (creator, coordinator, reviewer, manager, watcher): RFI roles follow the steps of the RFI workflow; a per-type role list needs a place on the work type and checks in the Works engine |
| `submittals` | On the submittal item type: `itemTypes` → `tur`, `specSections` → `disiplin` (also on the package type), `responseDays`, `numbering`, `workflow` | `responses` (the answers come from the workflow steps' outcome options), `watchers` |
| `meetings` | The meeting kinds: names → options of the meeting type's `tur` field | Standard agenda per kind, invited parties and the minutes folder: Manage has no meeting templates yet. Needed: store them per kind (for example on the meeting type's settings), fill the agenda and attendees of a new meeting of that kind, and file the minutes PDF in `minutesFolder` when the minutes are published |

Release: the handler needs SDK 0.13.0 (`patchWorkType`, `TemplateApplyContext`). Publish the SDK
(`sdk-v0.13.0`), raise the module's SDK `devDependencies` to `0.13.0` and `peerDependencies` to
`>=0.13.0 <1.0.0`, release the module and pin it here. `apps/server/test/modules/manage/template-apply.test.ts`
runs once the installed version has the handler.

## Tests

| Location | What |
|---|---|
| `sitekeep-manage`: `npm test` | Boundary check, matching for record from file |
| `apps/server/test/modules/manage/` | Registers, meetings, workflow steps, "Drop and save", formal correspondence, project template settings (`template-apply.test.ts`, skipped while the installed version has no handler) |
| Cross-cutting tests | Steps that create RFIs / correspondence / meetings run with `hasManage` |

## What stays in the core

No open work (10.11.2026). The following stay in the core on purpose or are shared with other modules:

- Submittal list import, Drop and save helpers and meeting action extraction are in the package (`shared/`); the Works engine DTOs (work types, fields, response options, RFI/submittal rows) are in the core. Strings are in the module (`locales/`); the Works engine's `works` keys are in the core.
- In an install without Manage, the Works engine is tested through transmittals (`test/works/works.test.ts`: transmittal form, automatic transmittal from a review, draft visibility, numbering, list filters). The receipt chain, KEP and "Today" inbox scenarios are set up with correspondence, so they only run when Manage is installed.
- Specification analysis (`docintel/spec.ts`) is in the core; since the `spec` switch is off without Manage, its page is hidden.
