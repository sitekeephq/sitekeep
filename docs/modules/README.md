# Modules

The boundary between the SiteKeep core (Community) and the paid modules (Enterprise). Product side:
SiteKeep editions and modules. This document covers the code side,
that is, how a module connects to the core.

The target is the same layout we use for the viewer: each module is developed in its own repository,
published as a versioned package and pulled into the application at a pinned version
([bim-viewer](../architecture/structure.md#221-external-private-package-7dimensions-projectbim-viewer)).

## Status

| Module | Repository | Package | Version in this repository | Status |
|---|---|---|---|---|
| **Cost**: contracts, progress payments (hakediş), quantity take-off (metraj), 2D take-off, 5D, Suggest Items | [sitekeep-cost](https://github.com/7Dimensions-Project/sitekeep-cost) (private) | `@7dimensions-project/sitekeep-ee-cost` | `0.6.1` | Separate repository, GitHub Packages. [Details](cost.md) |
| **Field**: form templates, forms, approval workflow, form PDFs | [sitekeep-field](https://github.com/7Dimensions-Project/sitekeep-field) (private) | `@7dimensions-project/sitekeep-ee-field` | `0.3.2` | Separate repository, GitHub Packages. [Details](field.md) |
| **Coordinate**: clash tests, parameter change | [sitekeep-coordinate](https://github.com/7Dimensions-Project/sitekeep-coordinate) (private) | `@7dimensions-project/sitekeep-ee-coordinate` | `0.3.0` | Separate repository, GitHub Packages. [Details](coordinate.md) |
| **Planning**: Schedule (P6, MS Project, Excel), versions, 4D | [sitekeep-planning](https://github.com/7Dimensions-Project/sitekeep-planning) (private) | `@7dimensions-project/sitekeep-ee-planning` | `0.3.0` | Separate repository, GitHub Packages. [Details](planning.md) |
| **AI**: providers, Ask the project, task queue, MCP | [sitekeep-ai](https://github.com/7Dimensions-Project/sitekeep-ai) (private) | `@7dimensions-project/sitekeep-ee-ai` | `0.4.0` | Separate repository, GitHub Packages. [Details](ai.md) |
| **Manage**: RFI, submittals, meetings, correspondence tools, Drop and save | [sitekeep-manage](https://github.com/7Dimensions-Project/sitekeep-manage) (private) | `@7dimensions-project/sitekeep-ee-manage` | `0.3.1` | Separate repository; the Works engine is in the core. [Details](manage.md) |
| **Connect**: Autodesk Forma / ACC sync and file import, Office editing in the browser (WOPI) | [sitekeep-connect](https://github.com/7Dimensions-Project/sitekeep-connect) (private) | `@7dimensions-project/sitekeep-ee-connect` | `0.3.2` | Separate repository; Office conversion is in the core. [Details](connect.md) |

| Package | Source | Version |
|---|---|---|
| `@7dimensions-project/sitekeep-sdk` | this repository, `packages/sdk` | `0.12.0` |

The version rows are kept in line with `apps/server/package.json` and `apps/web/package.json` (`module-boundary.test.ts` requires pinned versions).

Steps (each a separate PR, tests green):

1. **SDK and boundary:** the module connects to the core only through the SDK; the core knows the module only from the module list. Behaviour does not change. (Cost: #24)
2. **Package:** the module becomes `packages/ee-<id>`: server, web, schema, migrations. The core loads it by package name; CI builds and tests without modules (Community). (Cost: #26)
3. **Repository:** `7Dimensions-Project/sitekeep-<id>` (private); the package is published to GitHub Packages, this repository uses it at a pinned version, and `packages/ee-<id>` is deleted.

## Parts

| Part | Location | What |
|---|---|---|
| SDK (core side) | `apps/server/src/sdk/index.ts`, `apps/web/src/sdk/index.ts` | The only surface a module can use from the core |
| SDK package | `packages/sdk` → `@7dimensions-project/sitekeep-sdk/server`, `/web`, `/shared` | The only name modules import. At runtime it forwards the object bound by the core (`server.js`, `web.js`, `shared.js`, generated). The published package contains the core's type declarations (`types/`, `.d.ts` only) |
| Binding | `apps/*/src/sdk/bind.ts` | Puts the SDK and `packages/shared` on `globalThis[Symbol.for("sitekeep.sdk.server" / ".web" / ".shared")]`; loaded before the modules |
| Module list | `apps/server/src/app/modules.ts`, `apps/web/src/app/modules.ts` + `apps/web/sitekeep-modules.ts` | Loads the modules in `SITEKEEP_MODULES` by package name |
| Module | `sitekeep-<id>` repository → `node_modules/@7dimensions-project/sitekeep-ee-<id>` | `dist/server`, `dist/web/index.js`, `migrations/`, `locales/` (strings, [i18n §9](../architecture/i18n.md)); `exports`: `./server`, `./web`, `./internal/*` (core tests only) |

Why this bridge: a module package must build without knowing the core's source, but at runtime it must
share the same objects as the core (report registry, capabilities, React contexts, i18n).
It is the same pattern as VS Code extensions and the `vscode` module.

## Which modules are installed

`SITEKEEP_MODULES` is a comma-separated list of module IDs:

| Value | Result |
|---|---|
| undefined | All installed module packages (`node_modules/@7dimensions-project/sitekeep-ee-*`). Modules are **optional** dependencies in `apps/server` and `apps/web` (`optionalDependencies`): an install that cannot reach the packages (`npm ci` without credentials) skips them and starts as Community |
| `""` (empty) | None: **Community** |
| `cost` | Cost only |

The server reads it at runtime. The web build bundles the installed module packages (Vite; if `SITEKEEP_MODULES` is
set at build time, only those); at startup the app asks the server which ones it runs (`GET /api/v1/app-info`,
also open before login) and enables only their pages, menus, capabilities and strings (`app/modules.ts`). This way
the server (later, the licence) decides which modules are enabled in a single Enterprise image. The `community` job in CI
deletes the module packages after install and leaves `SITEKEEP_MODULES` undefined (the real state of an install
without modules); it runs the server and web tests, and module tests (`apps/*/test/modules/<id>`) are skipped in that job.
Core tests that rely on a module's internal code load the module only if it is installed (`hasAi ? await import(...)`).

## Boundary rules

- A module uses the core **only** through `@7dimensions-project/sitekeep-sdk/server`, `/web` and `/shared`; it does not import `@sitekeep/*` packages directly.
- It does not leave its package via relative paths and does not import another module. Anything one module needs from another is offered as a **capability** and is optional.
- The core **never** imports a module's code; `app/modules.ts` loads modules by package name.
- Enforced by tests: on the module side in the module repository (`scripts/check-boundary.mjs`); in this repository `apps/server/test/architecture/module-boundary.test.ts` (the core does not import module code, modules are pinned packages) and `sdk-shim.test.ts` (the SDK package forwards the same names as the core's SDK and `shared`).

## Module contract

Server (`sdk/module.ts`), the default export of the package's `./server` entry:

```ts
export default defineServerModule({
  id: "cost",
  migrations: path.join(packageRoot(), "migrations"), // own journal: drizzle.__drizzle_migrations_cost
  locales: path.join(packageRoot(), "locales/server"), // server strings, added to the core's namespaces
  async routes(api, deps) { … },          // routes under /api/v1
  async reminders(db, now) { … },          // daily reminder round, returns { dueSoon, overdue }
  taskSources: [paymentTasks],             // contribution to the "My Tasks" list
  async rootRoutes(app, deps) { … },       // endpoints outside /api/v1 with their own authentication (AI: /mcp)
  devTools: { cde_dev_ai_eval: devAiEval }, // developer tools (CDE_DEV_TOOLS=1)
  async start({ db, jobs, log }) { … },     // background jobs at startup (Connect: sync scheduler); returns a stop function
});
```

Report datasets are registered while the module loads, with `reportDatasets.register(...)`. The optional `tables` exposes the module's tables to developer tools only (`moduleTable("field", "forms")`; demo data, reset, scripts); feature code uses capabilities. When the database
opens, the core's migrations run first, then those of each installed module (`db/index.ts`).

Web (`sdk/module.ts`), the default export of the package's `./web` entry:

```ts
export default defineWebModule({
  id: "cost",
  projectRoutes: [{ path: "contracts", element: <ContractsPage /> }, …], // under /projects/:pid/
  projectNav: [{ group: "planning", to: "contracts", labelKey: "…", icon: "doc" }, …],
  capabilities: { cost: { CostDialog, cashflow, … }, "cost.takeoff": { get, add } },
});
```

In the core's `LEGACY_URLS` table (`app/navigation/routes-table.ts`), a module's own pages are marked with
`module: "<id>"`; if the module is not installed, those addresses are not expected.

## Capabilities

An optional service that a module offers to another module or to the core. If the capability is missing,
the consumer hides the feature; the provider may not be installed.

| Capability | Provider | Consumer | If missing |
|---|---|---|---|
| `manage.workExists` (server) | Core Works engine (`works/capabilities.ts`) | Cost: linking a work item to a variation | Work link is rejected |
| `manage.workLabels` (server) | Core Works engine | Coordinate: label of the work item linked to a request | Label is empty |
| `connect.ui` (web) | Connect | File drawer: Edit and lock; Administration → Forma Sync | Hidden |
| `manage.ui` (web) | Manage | Work detail (package, meeting), registers, specification import, RFI draft, Drop and save | Hidden; Manage switches off |
| `ai.provider` (server) | AI | Every feature that needs a model (the core's `ai/provider.ts` gate) | `403 ai_off`; features fall back to the rule-based result |
| `ai.tasks` (server) | AI | Today: open "Today's Summary" task | No task |
| `ai.ui` (web) | AI | Ask panel, "Send to AI", Administration and project AI settings | Buttons and tabs hidden |
| `planning.schedules` (server) | Planning | Cost: schedule activities, data date, 4D links and planner permission in 5D; "Today" labels | Cost is not linked to activities, planner = project manager; no labels |
| `planning.fourD` (web) | Planning | The viewer's 4D panel (`?takvim=1`) | 4D button hidden |
| `coordinate.modelSets` (server) | Coordinate | Editing / deleting model sets | No check (no tests) |
| `coordinate.linkTargets` (server) | Coordinate | Issue ↔ clash group link | 404 |
| `coordinate.paramChanges` (server) | Coordinate | "Today" labels | No rows |
| `coordinate.clashTests` (web) | Coordinate | Coordination: Clash Tests tab | Tab hidden |
| `coordinate.viewerClash` (web) | Coordinate | The viewer's clash mode | `?clash=` is ignored |
| `coordinate.paramFile` (web) | Coordinate | File drawer parameter button / badge | Hidden |
| `field.forms` (server) | Field | "Today", hub labels, locations, two report datasets | Form rows and counts empty |
| `field.externalForms` (server) | Field | Forma Sync: Autodesk forms | Forms are not synced |
| `field.newFormDialog` (web) | Field | Works "+ New" → Form | Option hidden |
| `cost` (web) | Cost | 4D panel (cost colour mode, cash flow, element cost), Schedule "Cost" dialog | Cost buttons and colour mode hidden |
| `cost.takeoff` (web) | Cost | PDF viewer "2D Take-off", saving a DWG measurement to the take-off | Button hidden, measurement only measures |

New capability: add the type to `sdk/capabilities.ts`, the providing module registers it, and the consumer requests it with `capability(...)`
/ `webCapability(...)`.

## Adding to the SDK and releasing

If a module needs something new from the core, add an explicit export to `apps/*/src/sdk/index.ts`
(with a comment saying which section it belongs to), then `npm run build -w @7dimensions-project/sitekeep-sdk` regenerates
the shims (`sdk-shim.test.ts` catches it if you forget).

The SDK uses semver: an addition is a minor version; removing an export or changing a signature is a major version. Throughout 0.x, modules write `>=<version they use> <1.0.0` in `peerDependencies` (npm treats `^0.1.0` as incompatible with `0.2.0`).
Release: `packages/sdk/package.json` version → PR → merge → `git tag -a sdk-vX.Y.Z -m "SDK X.Y.Z" && git push origin sdk-vX.Y.Z`
(`.github/workflows/sdk-release.yml`; `prepack` generates the type declarations). The module repository takes the new SDK
into `devDependencies` and updates the `peerDependencies` range if needed.

## Upgrading a module version

1. In the module repository: PR → merge → version → `vX.Y.Z` tag (CI publishes).
2. Here: `npm install @7dimensions-project/sitekeep-ee-<id>@X.Y.Z --save-exact -w @sitekeep/server -w @sitekeep/web`, the version row in this document → PR → green CI → merge.
3. Production: deploy (the `.npm_token` on the server must have read access).

## GitHub Packages access

The packages are private. A repository's CI (`GITHUB_TOKEN`) can read a package published from another repository only if the package's
settings allow it: package page → **Package settings → Manage Actions access → Add
repository** (Read).

| Package | Repositories that need to read it |
|---|---|
| `bim-viewer` | `7d-cde` and module repositories that use the viewer types (`sitekeep-coordinate`, `sitekeep-planning` …) |
| `sitekeep-sdk` | `sitekeep-cost`, `sitekeep-field`, `sitekeep-coordinate`, `sitekeep-planning`, `sitekeep-ai`, `sitekeep-manage`, `sitekeep-connect` (and later module repositories) |
| `sitekeep-ee-cost` | `7d-cde` |
| `sitekeep-ee-field` | `7d-cde` |
| `sitekeep-ee-coordinate` | `7d-cde` |
| `sitekeep-ee-planning` | `7d-cde` |
| `sitekeep-ee-ai` | `7d-cde` |
| `sitekeep-ee-manage` | `7d-cde` |
| `sitekeep-ee-connect` | `7d-cde` |

Developer machines and the production server use a personal token with `read:packages` (`NODE_AUTH_TOKEN`, `.npmrc`).

## Extracting a new module (checklist)

1. List what the module takes from the core; find the places where the core connects to it directly (routes, reminders, tasks, reports, menus, buttons on other pages).
2. Add what is needed to the SDK; turn the links from the core to the module into contract fields or capabilities.
3. Move the code to `packages/ee-<id>` (`server/`, `web/`), take its schema and migrations (idempotent), add it to `KNOWN_MODULES` (server, web, vitest); access the core only through `@7dimensions-project/sitekeep-sdk/*`.
4. Move its tests to `apps/*/test/modules/<id>`; in mixed tests, make the module steps depend on the module being installed.
5. `npm test` and `SITEKEEP_MODULES="" npm test`, e2e, Dockerfile.
6. Create the `sitekeep-<id>` repository using `sitekeep-cost` as the model, publish the package, delete `packages/ee-<id>` here and add the pinned version; grant package access; update this document and the module page.
