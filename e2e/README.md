# End-to-end tests

The root Playwright harness runs the production server and web builds in Chromium: Desktop Chrome
plus an iPhone 13 viewport (Chromium) and a Safari/WebKit iPhone 13 smoke. Specs provide smoke
coverage for critical browser journeys:

- authentication guards, invalid credentials, real password login, and logout;
- the API-created project on home, project-shell redirects, top-bar actions, and primary navigation;
- document folder metadata and a tiny upload/delete/restore lifecycle;
- system, project, and account settings plus regular-member access boundaries;
- coordination empty states and issue/BCF export UI;
- form creation, editing, persistence, and reload;
- works correspondence creation, review visibility/actions, and dashboard creation;
- CSV schedule import;
- contracts and progress payments: contract card (consultant, responsible person, SGK), unit price item
  with lump-sum weight and activity, period formula, document link box, payment fill → submit → approve,
  Excel/PDF export, approved variation with time extension, guarantee letter, spent/remaining board and delete;
  subcontract item margin and a new revision of a rejected payment; multi-step payment approval on the
  workflow engine (flow picked on the contract, a non-admin assignee answers from the project task list,
  a rejection without a reason fails, the admin approves the last step);
- metraj (quantities): two versions of a fixture IFC, the inventory by class and storey (gross area,
  openings, net area), a group's elements with the source property, grouping by material, the
  difference to the previous version (changed groups and elements) and the Excel download;
- openings from geometry (Boşluklar): `openings.ifc` (mm units) with door, Revit-style window, round and shaft
  openings plus one that cannot be measured; the source note, wall totals with openings deducted, the opening
  cell (count, fillings, the model's own value) and geometric sources; on the iPhone the same on the cards;
- poz suggestions (Poz Öner): own projects with a fixture IFC and unit prices; keyword suggestions with model
  quantities, changing a poz, rejecting one, accepting into cost rules, the learned pair suggested first in the
  next project, and the 5D dialog with the rules and the learned mappings (delete via the confirm dialog);
- 2D take-off (2B Metraj): a fixture PDF (`fixtures/takeoff-plan.pdf`, 600 × 400 pt with a 10 m line) opened from
  the PDF viewer, page calibration, an area priced by a unit price, a deducted opening, a length and a count,
  editing and deleting (confirm dialog), the Excel download, **Metraja Ekle** in the CAD viewer for `tiny.dxf`
  and the drawing list on the Metraj page; on the iPhone the same by touch with the bottom sheet;
- quantity approval (Metraj Onayı): approving `openings.ifc` with a note, the Onaylar tab and its groups, binding
  groups to contract items on **Metraj Bağları**, filling a draft payment from the approval (quantity, source note,
  payment source) and revoking with a reason; on the iPhone approve, bind and fill by touch without sideways scroll;
- Forma Eşitleme: the "not configured" state, and the Autodesk'ten Getir dialog with Autodesk endpoints
  answered in the browser (browse, select, target folder, queued/rejected, recent list);
- iPhone 13: hamburger navigation, ask panel, create dialogs, CSV Gantt bars, document
  upload/delete/restore, empty model-viewer sheet, administration tabs, and no sideways page scroll;
  filled-data dialogs for forms, reviews, BCF export/import, correspondence/letter, schedule
  Özet/S-eğrisi/5D, folder permissions/settings, start-review, location CSV, project-settings
  create dialogs, admin OAuth/AI provider, form templates, reports AI-off boundary, new user, and
  contract tabs with an editable green book; metraj group cards, element details and the version difference;
  poz suggestion cards and accepting one row; 2D take-off by touch (calibration, area, bottom sheet, drawing cards);
  fixture IFC/4D, clash run, IDS check, IFC locations, param-change, a generated multi-storey
  site IFC, PDF markup tools plus seeded-markup issue, DXF viewer, and Yeni Sorun; Safari/WebKit
  iPhone 13 smoke for hamburger, create dialogs, and login.

These are journey-level checks, not an exhaustive permutation suite. Pure business-rule variants
belong in package, server, or web tests.

## Architecture and isolation

`e2e/playwright.config.ts` owns the Chromium, Chromium iPhone 13, and (in CI) WebKit iPhone 13
projects, diagnostics, retries, and the isolated web server. Desktop specs ignore `mobile-*.spec.ts`;
the Chromium iPhone project runs those files except `mobile-safari.spec.ts`, which is WebKit-only.
Playwright's WebKit build is frozen on macOS 14 ARM and often fails to launch, so the Safari project
is off locally unless `E2E_SAFARI=1`. `e2e/support/launch.mjs` requires an existing root build, serves `apps/web/dist` through the
production server, and creates a temporary `e2e/.tmp/run-*` data directory backed by an in-memory
database. It disables AI, SMTP, Office conversion, Google, Autodesk, and developer tooling. The
temporary data directory is removed when the server stops.

Global setup logs in through the REST API and creates a fresh ISO 19650 project. Authentication and
run metadata are generated under `e2e/.auth/`; both that directory and `e2e/.tmp/` are ignored by
Git. Specs run serially with one worker against `127.0.0.1:18080` by default. Set `E2E_PORT` to an
unused port when necessary.

Tests may use Playwright's API request context to create expensive prerequisites such as a member,
issue, form template, or review. The browser must still perform and assert the user-visible journey
under test. Do not replace the behavior being tested with direct API calls, and never seed from
live, shared, customer, or production data.

## Commands

Use Node 22 or later:

```sh
npm ci
npm run build
npm run e2e:install
npm run e2e
```

The build is mandatory because the harness launches `apps/server/dist/index.js` and serves
`apps/web/dist`. For interactive debugging:

```sh
npm run e2e:headed
npm run e2e:ui
```

To run one spec or match one test title, pass Playwright arguments after `--`:

```sh
npm run e2e -- e2e/specs/auth.spec.ts
npm run e2e -- e2e/specs/mobile-smoke.spec.ts
npm run e2e -- --grep "login and logout"
E2E_SAFARI=1 npm run e2e -- --project=safari
```

## CI and diagnostics

CI installs Chromium, WebKit and their OS dependencies, then runs `npm run e2e` after build, typecheck, and
unit/integration tests. CI retries failures according to the Playwright config and uploads
`playwright-report/` and `test-results/playwright/` when the job fails.

Unexpected same-origin API failures, failed API requests, and browser page errors fail otherwise
successful tests. Expected negative-path responses must be narrowly declared with the fixture's
allow-failure helper. On failure, screenshots and retained video are written under
`test-results/playwright/`; a trace is captured on the first retry. The HTML report is written to
`playwright-report/` and can be opened with:

```sh
npx playwright show-report
```

A new screen is not done until unit tests, a desktop spec, a `mobile-*.spec.ts` journey, and a
`mobile-smoke.spec.ts` route entry exist and pass. The binding rule is
[docs/architecture/tests.md](../docs/architecture/tests.md).

## Adding a spec

1. Add a focused `*.spec.ts` file under `e2e/specs/` and import the shared fixtures.
2. Reuse the project and module metadata from `runState()`; add only minimal deterministic fixtures.
3. Seed prerequisites through the isolated API only when UI setup is not the behavior under test.
4. Drive the critical user action through the browser and assert its visible result, route, and
   important network outcome where relevant.
5. Keep the test independent of execution order, wall-clock assumptions, external services, and
   data from another run.
6. Run the focused spec, then `npm run e2e`.

Prefer accessible, user-facing selectors such as `getByRole`, `getByLabel`, and stable names. Use
`getByText` for meaningful visible copy. Add a dedicated test id only when no semantic selector is
available; avoid brittle CSS structure, generated classes, positional selectors, and arbitrary
timeouts.

Google login, Autodesk, live OpenCDE partners, Office editors/converters, SMTP delivery, AI
providers, large model conversion, and other external or heavy workflows are intentionally
deferred. Cover their boundaries with contract tests or mocks, or run them in a dedicated,
explicitly configured integration environment.
