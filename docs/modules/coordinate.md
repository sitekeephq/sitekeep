# Coordinate module

SiteKeep Coordinate: clash tests and parameter change requests. Product description:
SiteKeep editions and modules §2. Feature document:
[Parameter Change](../features/PARAMETER_CHANGE.md).

| | |
|---|---|
| Repository | [7Dimensions-Project/sitekeep-coordinate](https://github.com/7Dimensions-Project/sitekeep-coordinate) (private); local clone `~/Desktop/7dimensions/sitekeep-coordinate` |
| Package | `@7dimensions-project/sitekeep-ee-coordinate` (GitHub Packages) |
| Version in this repository | `0.3.0` (`apps/server/package.json`, `apps/web/package.json`) |
| SDK used | `@7dimensions-project/sitekeep-sdk` `>=0.11.0 <1.0.0` |
| ID | `coordinate` (`SITEKEEP_MODULES`) |

The history before the move is in this repository (`apps/server/src/{coordination,param-change}`,
`apps/web/src/features/coordination`).

## Boundary

What stays in the core: model sets and saved views (federation, viewer), issues,
markups, BCF, IDS checks (in Community, decision §8.1-3), model query and version
comparison. The Coordination page always shows the model sets and IDS tabs, and shows the Clash
Tests tab if Coordinate is installed.

The clash and parameter change **workers** (`apps/server/src/jobs/clash-worker.ts`,
`param-change-worker.ts`) stay in the core: they are geometry engines that run on web-ifc and read their own
translations from the core's folder. The module runs them with the SDK's `runWorker` / `workerFile`.

The AI parameter plan schema is in the core: `apps/server/src/contracts/param-change.ts`.

## What is in the package

| Location (in the repository) | Contents |
|---|---|
| `server/index.ts` | Module: migrations, routes, `tables`; registers the capabilities and the `clash_results` dataset when loaded |
| `server/routes/clash.ts`, `clash-service.ts`, `clash-access.ts` | Clash tests, runs, results, groups, statuses, issue from a group, summary |
| `server/param-change/` | Requests, plan (query + values), AI plan, applying to IFC, checks on the next version |
| `server/capabilities.ts` | `coordinate.modelSets`, `coordinate.linkTargets`, `coordinate.paramChanges` |
| `server/schema-tables.ts` | `clash_tests`, `clash_runs`, `clash_groups`, `clashes`, `param_change_requests`, `param_change_items`, `param_change_checks` |
| `web/` | Clash Tests tab, the viewer's clash panel, parameter change pages, file drawer parts, API client |
| `migrations/0000_coordinate` | Own journal `drizzle.__drizzle_migrations_coordinate`; idempotent, from the core's 0011, 0020, 0027 |

## Where it connects to the core

| Core | How |
|---|---|
| Routes | `ServerModule.routes` |
| Editing / deleting model sets (files used by tests) | `coordinate.modelSets` |
| Issue ↔ clash group link (markup / issue links) | `coordinate.linkTargets` |
| "Today": parameter change labels | `coordinate.paramChanges` |
| Reports: `clash_results`; Coordination template | registered with the module; the template appears if the dataset exists |
| Manage's work items (linking a work item to a request, label) | `manage.workExists`, `manage.workLabels` |
| Coordination page: Clash Tests tab | `coordinate.clashTests` |
| Viewer: clash mode (`?clash=…&ct=…`) | `coordinate.viewerClash`; otherwise the parameter is ignored |
| File drawer: parameter change button and badge | `coordinate.paramFile` |
| Menu, pages, Model tab, "+ New" → Change request, legacy addresses | `projectNav`, `projectRoutes`; `MODEL_TABS.webModule`, `LEGACY_URLS.module` |
| Developer tools | `moduleTable("coordinate", …)` |

## Tests

| Location | What |
|---|---|
| `sitekeep-coordinate`: `npm test` | Boundary check, clash ID unit test |
| `apps/server/test/modules/coordinate/` | Parameter change API |
| `apps/server/test/coordination/coordination.test.ts` | Model sets and IDS always; clash steps if Coordinate is installed (`hasCoordinate`) |
| `apps/server/test/coordination/{clash-depth,param-change-worker}.test.ts` | Workers in the core |

## What stays in the core

No open work (10.11.2026). The following stay in the core on purpose or are shared with other modules:

- Parameter change DTOs and helpers, and clash status labels, are in the package (`shared/param-change.ts`, `shared/coordination.ts`); the status/ownership labels also used by the core, `ParamChangeSettings`, and the model set and clash DTOs are in the core. Strings are in the module (`locales/`); the `coordination` keys also used by the core are in the core.
