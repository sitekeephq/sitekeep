# Cost module

SiteKeep Cost: contracts and progress payments (hakediş), IFC quantity take-off (metraj) inventory and quantity approval, 2D take-off, 5D cost and
Suggest Items. Product description: SiteKeep editions and modules §2.
Feature documents: [Quantity take-off](../features/QUANTITIES.md), [Quantity Approval](../features/QUANTITY_APPROVAL.md),
[2D Take-off](../features/2D_TAKEOFF.md), [Suggest Items](../features/POZ_SUGGEST.md), [4D / 5D](../features/4D_5D.md).

| | |
|---|---|
| Repository | [7Dimensions-Project/sitekeep-cost](https://github.com/7Dimensions-Project/sitekeep-cost) (private); local clone `~/Desktop/7dimensions/sitekeep-cost` |
| Package | `@7dimensions-project/sitekeep-ee-cost` (GitHub Packages) |
| Version in this repository | `0.6.1` (`apps/server/package.json`, `apps/web/package.json`) |
| SDK used | `@7dimensions-project/sitekeep-sdk` `>=0.11.0 <1.0.0` |
| ID | `cost` (`SITEKEEP_MODULES`) |

Extraction: #24 (SDK boundary), #26 (own package, migration journal, Community build), then
the `sitekeep-cost` repository. The history before the move is in this repository.

## Boundary

5D cost (unit price, cost rule, Suggest Items, cost results) used to be part of Planning under `sim/`.
It moved to Cost because the progress payment and take-off tables are linked to `cost_items`.
4D (link rules, 4D status) stays in Planning. The rule engine shared by both sides is in the core:
`apps/server/src/model/rule-match.ts`.

As before, the 5D routes depend on the Schedule module switch (`schedule`).

## What is in the package

| Location (in the repository) | Published | Contents |
|---|---|---|
| `server/index.ts` | `dist/server/index.js` (`./server`) | Module definition: migrations, routes, reminders, My Tasks source, report datasets |
| `server/contracts/` | `dist/server/contracts/` | Contract, item, variation, guarantee, progress payment, approval workflow, progress payment PDF / Excel |
| `server/quantities/` | `dist/server/quantities/` | Take-off inventory, 2D take-off, quantity approval |
| `server/fived/` | `dist/server/fived/` | Unit price, cost rule, import, Suggest Items, cost and cash flow |
| `server/schema/` | `dist/server/schema/` | 13 tables: `contracts`, `contract_items`, `contract_variations`, `contract_guarantee_reminders`, `progress_payments`, `progress_payment_lines`, `takeoff_items`, `takeoff_scales`, `quantity_approvals`, `quantity_bindings`, `cost_items`, `cost_rules`, `poz_mappings` |
| `web/` | `dist/web/index.js` (`./web`, single file) | Pages, menu, capabilities |
| `migrations/` | `migrations/` | Own Drizzle journal |

The published code is minified and contains no source or source maps. `./internal/*` is only for this repository's
Cost tests (`dist/server/*`) and is not an API.

Strings are in the package (`locales/server`, `locales/web`: `contracts`, `quantities` and the 5D `sim` keys). Of the shared types, only those Cost uses are in the package (`shared/`: contracts and progress payments, take-off inventory, quantity approval, Suggest Items, 2D take-off calculations (`takeoff`), opening deductions (`openings`), 5D cost rules and summary (`sim`); `./shared/*`). Contract, progress payment and cost quantity labels are in the package too (Turkish `*_LABELS_TR`, English `locales/shared/en/labels.json`). What stays in the core is what the core also uses: 2D take-off DTOs and line/area calculation, `OpeningSolid`, rule matching, cost row and cash flow DTOs (`cost` capability, report datasets); the module accesses them through `@7dimensions-project/sitekeep-sdk/shared`.

## Migrations

| Cost | Previous core name |
|---|---|
| `0000_fived` | `cost_items`, `cost_rules` in `0025_sim_4d_5d` (+ report triggers) |
| `0001_contracts_payment` | `0042_contracts_payment` |
| `0002_contracts_payment_extras` | `0043_…` |
| `0003_contracts_payment_workflow` | `0044_…` |
| `0004_poz_mappings` | `0045_…` |
| `0005_takeoff` | `0046_…` |
| `0006_quantity_approvals` | `0047_…` |

The journal table is `drizzle.__drizzle_migrations_cost`; it runs after the core's (`db/index.ts`).
All are idempotent (`IF NOT EXISTS`, catching `duplicate_object`, `CREATE OR REPLACE TRIGGER`).
In existing installs (production, `v1.0.0-rc1`) the tables already exist: on first startup the Cost journal writes seven
entries and the database does not change (`apps/server/test/modules/cost/migrations.test.ts`). The core's
`0025` was not changed; a Community install gets empty `cost_items` / `cost_rules`, and they are removed when the core
journal starts from scratch in the clean open-source repository.

`contract_variations.work_id` → Manage's `works` table: the foreign key is added only if `works` exists
(`0001`); the code checks this with the `manage.workExists` capability.

## Where it connects to the core

| Core | How |
|---|---|
| Loading | `SITEKEEP_MODULES` → `app/modules.ts` (server), `virtual:sitekeep-modules` (web) |
| Migrations | `ServerModule.migrations` → `db/index.ts` |
| Routes | `ServerModule.routes` → `build-app.ts` |
| Reminders (progress payment step, guarantee due date) | `ServerModule.reminders` → `workflow/reminders.ts` |
| My Tasks (progress payment approval) | `ServerModule.taskSources` → `workflow/routes/notifications.ts` |
| Reports (`sozlesmeler`, `hakedisler`, `model_costs`, `cost_cashflow`) | `reportDatasets.register` while the module loads; the "Cost (5D)" template appears if the datasets exist |
| Progress payment PDF fonts | SDK `pdfFontBytes()` (the core's `assets/fonts`) |
| Project menu, pages | `WebModule.projectNav`, `projectRoutes` |
| 4D panel, Schedule | `cost` capability |
| Schedules, activities, planner permission (5D) | `planning.schedules` (without Planning, cost is not linked to activities) |
| PDF / DWG viewer | `cost.takeoff` capability |
| Linking a work item to a variation | `manage.workExists` capability (provided by Manage) |
| AI tools (`cde_cost_summary`, `cde_quantity_inventory`) | Through HTTP routes; no import |

## Tests

| Location | What |
|---|---|
| `sitekeep-cost`: `npm test` | Boundary check (`scripts/check-boundary.mjs`), unit tests of pure helpers (test copies instead of the SDK) |
| `apps/server/test/modules/cost/` | With the app set up: contract / progress payment / approval workflow API, take-off and 2D take-off, quantity approval, Suggest Items, 5D calculation and import, migrations |
| `apps/server/test/simulation/sim-api.test.ts` | 4D + 5D scenario; 5D steps run when Cost is installed |
| `e2e/specs/` | `contracts*`, `quantities*`, `quantity-approvals`, `takeoff`, `poz-suggest` and their mobile counterparts |

The behaviour tests live here because they run the published package against the real core. A change in Cost
→ `npm pack` in `sitekeep-cost`, install the tarball here and run the tests (repository README), then release and
upgrade the version ([Upgrading a module version](README.md#upgrading-a-module-version)).

## Later

- Move Cost-specific shared types into the package (once the core's capability types are separated).
- Run the behaviour tests in the module repository's CI as well (against the core's published image).
