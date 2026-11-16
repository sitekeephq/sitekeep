# Platform module

SiteKeep Platform: **report dashboards**. Decided in issue #82 §2: the report builder (dashboards, templates,
AI) is Enterprise; Community keeps fixed lists per area with CSV export. Product description:
SiteKeep editions and modules.

| | |
|---|---|
| Repository | `7Dimensions-Project/sitekeep-platform` (private; to be created); local clone `~/Desktop/7dimensions/sitekeep-platform` |
| Package | `@7dimensions-project/sitekeep-ee-platform` (GitHub Packages) |
| Version in this repository | `0.1.0` (`apps/server/package.json`, `apps/web/package.json`, once published) |
| SDK used | `@7dimensions-project/sitekeep-sdk` `>=0.14.0 <1.0.0` |
| ID | `platform` (`SITEKEEP_MODULES`, licence `modules`) |

## What moved and what stayed

| Moved to the module | Stayed in the core (Community) |
|---|---|
| Saved dashboards: `GET/POST /projects/:pid/reports`, `GET/PATCH/DELETE /reports/:id`, sharing (private / company / project admins / project), owner-or-admin editing | The **dataset registry** (`reports/datasets.ts`, `datasets-works.ts`, `datasets-modules.ts`, `model/report-dataset.ts`): the core's datasets and those other modules register (`reportDatasets.register`, SDK) |
| Version history: `/reports/:id/versions`, `/versions/:v`, `/restore` | The **query engine** (`engine.ts`, `run.ts`, `spec.ts`): filters, grouping, buckets, metrics, with the caller's permissions |
| Dashboard data and live refresh: `/reports/:id/data`, `/reports/:id/stamp` | **Change stamps** (`stamp.ts`, table `report_change_stamps`, the triggers of migration 0020) and `GET /reports/stamp?datasets=` |
| AI builder `POST /reports/generate`: dataset router, prompt (`router.ts`, `prompt.ts`), draft validation (`parseDraft`), the direct model (`llm.ts`, `AI_BASE_URL` / `AI_MODEL`) | `GET /reports/catalog` (datasets, module families; the module adds templates, example prompts and `aiAvailable` through `platform.reports`) and `POST /reports/query` (ad-hoc queries, MCP `cde_report_run`) |
| "Yapay zekâ ile onar" `POST /reports/:id/repair` (`repair.ts`) | **Fixed lists**: "Raporlar" shows one list per dataset, grouped by area, and `GET /reports/datasets/:name/csv` |
| Built-in templates (`templates.ts`, `templates-modules.ts`, `template-text.ts`) and example prompts | `reportDraftSchema` (SDK; the AI module validates task answers against it) and `extractJson` (now `ai/json.ts`) |
| The sandboxed dashboard frame and its `CDE.*` chart library (`report-frame.ts`, formerly in `packages/shared`), PDF snapshot (print) | Dataset permissions (each dataset's own visibility rule) |
| Web: Dashboards tab, `reports/:rid` (view, edit, HTML editor, versions, repair), "Save as report" in Modele Sor | The project switch `reports` (Proje Ayarları → Modüller) |
| Tables `dashboards`, `dashboard_versions` | `report_change_stamps` |
| Texts: `reports` keys of templates, examples, builder errors (server) and the builder screens and frame texts (web) | `reports` keys of datasets, values, validation, lists |

No scheduled reports existed before the split; none were added.

## Data: the tables stay where they are

Live installations have dashboards. Nothing is copied or renamed:

- The core created `dashboards` and `dashboard_versions` in `0005_reports` and still does on a new install (its migrations are history).
- The core's `0046_reports_to_platform` is the drizzle-kit output with the two generated `DROP TABLE` statements removed (as `0042`): it changes nothing and only moves the snapshot past the tables, so a later generated migration does not drop them. The core never creates, alters or drops them again.
- The module's `migrations/0000_dashboards.sql` (journal `drizzle.__drizzle_migrations_platform`) adopts them: `CREATE TABLE IF NOT EXISTS`, constraints in `DO … EXCEPTION WHEN duplicate_object`, `CREATE INDEX IF NOT EXISTS`. On an old database it changes nothing.
- Without the module the tables and rows stay untouched (no route reads them); installing the module later brings them back as they were.
- `apps/server/test/reports/platform-upgrade.test.ts` checks both: a database migrated up to `0045` with dashboards and versions, then upgraded without the module (rows unchanged) and with it (rows unchanged, dashboards list, open, run and save a new version).
- The SDK still exports `dashboards` (deprecated, `sdk/legacy-tables.ts`, outside drizzle-kit's schema glob) for modules built against older SDKs (the AI module's evaluation fixture).

## Where it connects to the core

| Core | How |
|---|---|
| Routes | `ServerModule.routes` (`/projects/:pid/reports…` except `catalog`, `query`, `stamp`, `datasets/:name/csv`) |
| Catalog | server capability `platform.reports` (`catalog(deps, access, lang)` → templates, example prompts, `aiAvailable`) |
| Datasets, queries, stamps | SDK: `reportDatasets`, `enabledDatasets`, `createReportContext`, `runQueries`, `queryProblems`, `readStamp`, `querySpecSchema` … |
| Direct model | `AppDeps.reportLlm` (tests' fake); unset, the module fills it from `AI_BASE_URL` / `AI_MODEL`, and Gizlilik Merkezi lists it |
| Web | capability `platform.reports` (`Dashboards`, `createDashboard`), `projectRoutes: reports/:rid` |
| MCP | `cde_reports_list` and `cde_report_save` need the module (`TOOL_MODULES`); `cde_report_datasets` and `cde_report_run` with `queries` are core |

Without the module: "Raporlar" shows the lists only; the "Rapor" buttons on module pages open the module's lists
(`reports?view=lists&module=…`); builder links (`?new=ai`, `?template=`) land on the lists; `reports/<id>` is not a route;
"Save as report" in Modele Sor is hidden; `/reports` (dashboards) answers 404.

## Follow-ups in other repositories

- **AI module**: the `report_generate` / `report_repair` features call the module's routes; give them `product: "platform"` (as `form_flow` has `"field"`) so they are hidden without it. Move the evaluation fixture off the deprecated `dashboards` export.

## Tests

| Where | What |
|---|---|
| `sitekeep-platform/test` | boundary, locales, router, draft ids, repair, frame (CSP, nonce, runtime, warnings) |
| `apps/server/test/modules/platform` | dashboards API, sharing, versions, AI builder with a fake model, repair, templates on seeded module data, MCP by name |
| `apps/server/test/reports` | Community: engine, datasets, permissions, catalog without builder parts, CSV, stamps, the upgrade path |
| `e2e` | `reports.spec.ts` builder journeys `needsModules("platform")`; `reports-lists.spec.ts` (Community lists and CSV) |
