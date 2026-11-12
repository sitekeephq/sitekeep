# Planning module

SiteKeep Planning: Schedule (iş programı; Primavera P6 XER, MS Project XML, Excel / CSV import, versions,
comparison, Gantt, S-curve) and 4D (link rules, activity links, 4D status, the viewer's
4D panel). Product description: SiteKeep editions and modules §2.
Feature document: [4D / 5D](../features/4D_5D.md).

| | |
|---|---|
| Repository | [7Dimensions-Project/sitekeep-planning](https://github.com/7Dimensions-Project/sitekeep-planning) (private); local clone `~/Desktop/7dimensions/sitekeep-planning` |
| Package | `@7dimensions-project/sitekeep-ee-planning` (GitHub Packages) |
| Version in this repository | `0.3.0` (`apps/server/package.json`, `apps/web/package.json`) |
| SDK used | `@7dimensions-project/sitekeep-sdk` `>=0.11.0 <1.0.0` |
| ID | `planning` (`SITEKEEP_MODULES`) |

The history before the move is in this repository (`apps/server/src/{schedule,sim}`,
`apps/web/src/features/{schedule,sim}`).

## Boundary

5D cost is in Cost ([cost.md](cost.md)); Cost accesses schedules through the `planning.schedules` capability.
SDK 0.4.0 removed the old temporary exports (`loadActivities`, `scheduleFor`, `refDate`, `canPlan`,
`elementActivities`, `scheduleApi` …); this is why it ships together with Cost `0.2.0`.

Shared parts moved into the core:

| Core | What |
|---|---|
| `apps/server/src/core/formats/{xml,zip,text,dates}.ts` | XML reader (also used by BCF), ZIP, text decoding, date helpers |
| `apps/server/src/i18n` `Translate`, `defaultTranslate` | Language of the parsers' warnings |
| `apps/server/src/model/versions.ts` | Visible IFC versions, detailed index (shared by 4D and 5D) |
| `apps/server/src/model/rule-match.ts`, web `shared/ui/RuleMatchEditor.tsx` | Rule engine and its editor (shared with Cost) |
| `apps/web/src/sim.css` | 4D / 5D panel styles (loaded by `main.tsx`) |

## What is in the package

| Location (in the repository) | Contents |
|---|---|
| `server/index.ts` | Module: migrations, routes, `tables`; registers the `planning.schedules` capability and the `schedule_activities` dataset when loaded |
| `server/schedule/` | Import (XER, MSPDI, Excel / CSV and formulas), schedules, activities, version comparison, routes |
| `server/routes.ts`, `service.ts`, `fourd.ts`, `suggest.ts` | 4D: link rules, suggestions, 4D status |
| `server/schema-tables.ts` | `schedules`, `schedule_activities`, `schedule_dependencies`, `activity_links`, `schedule_link_rules` |
| `web/` | Schedule page (Gantt, activity drawer, import), 4D panel, link rules dialog, API client |
| `migrations/0000_planning` | Own journal `drizzle.__drizzle_migrations_planning`; idempotent, from the core's earlier migrations |

## Where it connects to the core

| Core | How |
|---|---|
| Routes | `ServerModule.routes` |
| "Today": schedule labels | `planning.schedules.labels` |
| Cost: 5D activities, cash flow, planner permission | `planning.schedules` |
| Reports: `schedule_activities` | registered while the module loads |
| Viewer: 4D panel (`?takvim=1`) | `planning.fourD`; otherwise the 4D button is hidden |
| Menu, page, Model tab, legacy addresses | `projectNav` (at the top of the Planning group), `projectRoutes`; `MODEL_TABS.webModule`, `LEGACY_URLS.module` |
| Developer tools (demo schedule, reset, date shifting) | `moduleTable("planning", …)` |

The project module switch (`schedule`, project settings) did not change: while Planning is installed, Schedule can be
turned off in a project.

## Tests

| Location | What |
|---|---|
| `sitekeep-planning`: `npm test` | Boundary check, Excel formula evaluator unit test |
| `apps/server/test/modules/planning/` | Import and schedule API, 4D engine, 4D + 5D HTTP scenario (5D steps if Cost is installed) |
| `e2e/specs/` | schedule and 4D scenarios |

## What stays in the core

No open work (10.11.2026). The following stay in the core on purpose or are shared with other modules:

- Schedule DTOs, activity status labels and 4D link rules are in the package (`shared/schedule.ts`, `shared/sim.ts`); activity dates, date helpers, rule matching and cash flow types, also used by the core, are in the core. Strings are in the module (`locales/`); the `schedule` / `sim` keys also used by Cost are in the core.
