# Modules

The boundary between the SiteKeep core (Community) and the paid modules (Enterprise). Product side:
SiteKeep editions and modules. This document covers the code side,
that is, how a module connects to the core.

The target is the same layout we use for the viewer: each module is developed in its own repository,
published as a versioned package and pulled into the application at a pinned version
([bim-viewer](../architecture/structure.md#221-external-private-package-sitekeephqbim-viewer)).

## Status

| Module | Repository | Package | Version in this repository | Status |
|---|---|---|---|---|
| **Cost**: contracts, progress payments (hakediş), quantity take-off (metraj), 2D take-off, 5D, Suggest Items | [sitekeep-cost](https://github.com/sitekeephq/sitekeep-cost) (private) | `@sitekeephq/sitekeep-ee-cost` | `0.8.0` | Separate repository, GitHub Packages. [Details](cost.md) |
| **Field**: form templates, forms, approval workflow, form PDFs | [sitekeep-field](https://github.com/sitekeephq/sitekeep-field) (private) | `@sitekeephq/sitekeep-ee-field` | `0.7.0` | Separate repository, GitHub Packages. [Details](field.md) |
| **Coordinate**: clash tests, parameter change | [sitekeep-coordinate](https://github.com/sitekeephq/sitekeep-coordinate) (private) | `@sitekeephq/sitekeep-ee-coordinate` | `0.6.0` | Separate repository, GitHub Packages. [Details](coordinate.md) |
| **Planning**: Schedule (P6, MS Project, Excel), CPM and authoring, time–distance view, resources, payments schedule, KPIs, versions, 4D | [sitekeep-planning](https://github.com/sitekeephq/sitekeep-planning) (private) | `@sitekeephq/sitekeep-ee-planning` | `0.6.0` | Separate repository, GitHub Packages. [Details](planning.md) |
| **AI**: providers, Ask the project, task queue, MCP | [sitekeep-ai](https://github.com/sitekeephq/sitekeep-ai) (private) | `@sitekeephq/sitekeep-ee-ai` | `0.6.2` | Separate repository, GitHub Packages. [Details](ai.md) |
| **Manage**: RFI, submittals, meetings, correspondence tools, Drop and save | [sitekeep-manage](https://github.com/sitekeephq/sitekeep-manage) (private) | `@sitekeephq/sitekeep-ee-manage` | `0.6.0` | Separate repository; the Works engine is in the core. [Details](manage.md) |
| **Connect**: Autodesk Forma / ACC sync and file import, Office editing in the browser (WOPI) | [sitekeep-connect](https://github.com/sitekeephq/sitekeep-connect) (private) | `@sitekeephq/sitekeep-ee-connect` | `0.5.2` | Separate repository; Office conversion is in the core. [Details](connect.md) |
| **Platform**: report dashboards (builder with AI, templates, HTML editor; dashboard frame and charts; sharing, versions, PDF snapshots); approval delegation (vekâlet) | [sitekeep-platform](https://github.com/sitekeephq/sitekeep-platform) (private) | `@sitekeephq/sitekeep-ee-platform` | `0.4.0` | Separate repository; the report datasets, queries, fixed lists and CSV are in the core. [Details](platform.md) |

| Package | Source | Version |
|---|---|---|
| `@sitekeephq/sitekeep-sdk` | this repository, `packages/sdk` | `0.21.0` |

The version rows are kept in line with `apps/server/package.json` and `apps/web/package.json` (`module-boundary.test.ts` requires pinned versions).

Steps (each a separate PR, tests green):

1. **SDK and boundary:** the module connects to the core only through the SDK; the core knows the module only from the module list. Behaviour does not change. (Cost: #24)
2. **Package:** the module becomes `packages/ee-<id>`: server, web, schema, migrations. The core loads it by package name; CI builds and tests without modules (Community). (Cost: #26)
3. **Repository:** `sitekeephq/sitekeep-<id>` (private); the package is published to GitHub Packages, this repository uses it at a pinned version, and `packages/ee-<id>` is deleted.

## Parts

| Part | Location | What |
|---|---|---|
| SDK (core side) | `apps/server/src/sdk/index.ts`, `apps/web/src/sdk/index.ts` | The only surface a module can use from the core |
| SDK package | `packages/sdk` → `@sitekeephq/sitekeep-sdk/server`, `/web`, `/shared` | The only name modules import. At runtime it forwards the object bound by the core (`server.js`, `web.js`, `shared.js`, generated). The published package contains the core's type declarations (`types/`, `.d.ts` only) |
| Binding | `apps/*/src/sdk/bind.ts` | Puts the SDK and `packages/shared` on `globalThis[Symbol.for("sitekeep.sdk.server" / ".web" / ".shared")]`; loaded before the modules |
| Module list | `apps/server/src/app/modules.ts`, `apps/web/src/app/modules.ts` + `apps/web/sitekeep-modules.ts` | Loads the modules in `SITEKEEP_MODULES` by package name |
| Module | `sitekeep-<id>` repository → `node_modules/@sitekeephq/sitekeep-ee-<id>` | `dist/server`, `dist/web/index.js`, `migrations/`, `locales/` (strings, [i18n §9](../architecture/i18n.md)); `exports`: `./server`, `./web`, `./internal/*` (core tests only) |

Why this bridge: a module package must build without knowing the core's source, but at runtime it must
share the same objects as the core (report registry, capabilities, React contexts, i18n).
It is the same pattern as VS Code extensions and the `vscode` module.

## Which modules are installed

`SITEKEEP_MODULES` is a comma-separated list of module IDs:

| Value | Result |
|---|---|
| undefined | All installed module packages (`node_modules/@sitekeephq/sitekeep-ee-*`). Modules are **optional** dependencies in `apps/server` and `apps/web` (`optionalDependencies`): an install that cannot reach the packages (`npm ci` without credentials) skips them and starts as Community |
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

- A module uses the core **only** through `@sitekeephq/sitekeep-sdk/server`, `/web` and `/shared`; it does not import `@sitekeep/*` packages directly.
- It does not leave its package via relative paths and does not import another module. Anything one module needs from another is offered as a **capability** and is optional.
- The core **never** imports a module's code; `app/modules.ts` loads modules by package name.
- Enforced by tests: on the module side in the module repository (`scripts/check-boundary.mjs`); in this repository `apps/server/test/architecture/module-boundary.test.ts` (the core does not import module code, modules are pinned packages) and `sdk-shim.test.ts` (the SDK package forwards the same names as the core's SDK and `shared`).

## ISO 19650 enforcement

When a project enforces the ISO 19650 transitions (`project_cde_settings.enforce_transitions`, opt-in per
project, D-8; [CDE states](../features/CDE_STATES.md#transitions)), the SDK functions modules use for writing
apply the transition table, with unchanged signatures:

- `assertDirectWriteAllowed` and `folderGate` refuse (or report as gated) a folder whose state is not
  written directly: with the ISO 19650 table, everything except Work in Progress. `GateInfo` has an optional
  `message` with the reason.
- `addVersion` refuses a new file or version in such a folder (403), whatever `source` the module passes.

Effects: a Connect import into Shared or Published is refused (import into WIP and send the files for review),
WOPI saving a document in Shared / Published is refused, Field and Manage writes into those states are refused.
Project administrators are refused too; they use the override route with a reason. Projects that do not
enforce the rules behave exactly as before. A module that must write outside WIP asks the user to go through
a review, or targets a WIP folder.

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
  modelFormats: [{ extensions: ["rvt"], label: "Revit", toIfc, version }], // formats converted to IFC for the model viewer (Connect; SDK 0.17.0, `version` 0.18.0)
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
  modelExtensions: ["rvt"],                 // opened with the model viewer; the server side converts them (Connect)
});
```

`modelFormats` / `modelExtensions` ([model formats](../features/MODEL_FORMATS.md)): a version of such a file is
converted to IFC by the module, then takes the IFC path unchanged (viewer derivative, element index, comparison,
"Modele sor"). Only while the module is on; without it the file stays a plain file. The optional `version()` (SDK
0.18.0) returns the installed converter in the same form as `toIfc`'s `tool` ("rvt-rs 0.25.0"): the core then converts
models from another converter version again at start-up and retries failed ones once per converter version.

### Notification channels (SDK 0.19.0)

The core e-mails review steps and work items ([workflow e-mail](../features/WORKFLOW_EMAIL.md)). A module adds a
channel (Teams, Slack, webhook) or a digest with `registerNotificationChannel`, called while the module loads:

```ts
const off = registerNotificationChannel({
  id: "digest",                                   // unique
  claims: (recipient, event) => chosenDigest(recipient.userId), // optional: true = the core sends this person no immediate e-mail
  async deliver(event) { … },                     // every typed event, once, with all recipients
});
```

`NotificationEvent`: `kind`, `type` (`assigned` | `due_soon` | `overdue` | `outcome`), `projectId`, `projectCode`,
`link` and the absolute `url`, `dueDate`, `actorId`, `recipients` (`userId`, `name`, `email`, `language`, `emailEnabled`:
the person's choice, project default applied; the actor, disabled and pending users are already left out) and
`text(language)` for the title and body. A throw is logged and never breaks the workflow. A channel registered by a
module that is off is not called. The channel makes its own outbound calls through `moduleOutboundFetch` with a
connection declared by `registerPrivacyConnection`.

### Files on object storage (SDK 0.21.0)

The core's files may be on a bucket ([object storage](../onprem/object-storage.md): `CDE_STORAGE=s3` or `gcs`).
A module never builds paths itself: it reads with `storage.get(key, range?)` and, when a worker needs a file on disk,
`await storage.withLocalCopy(key, async (path) => …)` (or `acquireLocal(key)` + `release()`, `withLocalCopies` for
several). On the local disk that is the stored file itself (no copy); on a bucket a temporary copy that is removed
afterwards. `storage.localPath(key)` is deprecated: it throws `StorageNotLocalError` on object storage. SDK 0.21.0 exports
`withLocalCopies`, `StorageNotLocalError` and the types `LocalCopy`, `ByteRange`, `StorageEntry`; the `Storage` type
gains `get(key, range?)`, `exists`, `list`, `acquireLocal`, `withLocalCopy`, `info`, `ping`. A module that reads stored
files from disk needs `>=0.21.0` (Coordinate 0.6.0: clash detection, parameter changes).

### Assignee resolution: approval delegation (SDK 0.20.0)

The workflow engine asks the modules who acts for the people a step or a work is assigned to
([approval delegation](../features/DELEGATION.md), issue #190). A module registers a resolver while it loads:

```ts
registerAssigneeResolver({
  id: "platform.delegation",
  async delegates({ db, projectId, userIds, at }) { return [{ forUserId, userId, delegationId }]; },
});
```

The core calls it when a step becomes current or a work is assigned and stores the answer
(`workflow_instances.step_delegates`, `works.assignee_delegates`). A module running its own flow on the core's
instances (Field forms) calls `enterStepDelegates` when it moves a step, `stepActing` to decide who may answer (the
person or their delegate; the first answer for a person wins), records `onBehalfOfUserId` on the `workflow_actions`
row and sends `notifyDelegates` with its assignment notification. Also: `openDelegateSteps` (task lists),
`dropStepDelegation`, `delegateAccessGaps`, `actingAs` (engine). Delegation never widens folder permissions.

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
| `platform.reports` (server) | Platform | `GET /reports/catalog`: templates, example prompts, `aiAvailable` | Catalog without builder parts (empty templates, `aiAvailable: false`) |
| `platform.reports` (web) | Platform | "Raporlar" Dashboards tab, "Rapor" shortcuts open the builder, "Save as report" in Modele Sor | Fixed lists only; shortcuts open the module's lists; button hidden |
| `manage.templateApply` (server) | Manage | Project from a template (format v2): the template's `rfi`, `submittals`, `meetings` ([project templates](../features/PROJECT_TEMPLATES.md#module-hook)) | The part is skipped and reported (`module_not_installed`, or `unsupported` for a version without the handler) |
| `field.templateApply` (server) | Field | Project from a template (format v2): the template's `forms` | As above |

New capability: add the type to `sdk/capabilities.ts`, the providing module registers it, and the consumer requests it with `capability(...)`
/ `webCapability(...)`.

## Adding to the SDK and releasing

If a module needs something new from the core, add an explicit export to `apps/*/src/sdk/index.ts`
(with a comment saying which section it belongs to), then `npm run build -w @sitekeephq/sitekeep-sdk` regenerates
the shims (`sdk-shim.test.ts` catches it if you forget).

The SDK uses semver: an addition is a minor version; removing an export or changing a signature is a major version. Throughout 0.x, modules write `>=<version they use> <1.0.0` in `peerDependencies` (npm treats `^0.1.0` as incompatible with `0.2.0`).
Release: `packages/sdk/package.json` version → PR → merge → `git tag -a sdk-vX.Y.Z -m "SDK X.Y.Z" && git push origin sdk-vX.Y.Z`
(`.github/workflows/sdk-release.yml`; `prepack` generates the type declarations). The module repository takes the new SDK
into `devDependencies` and updates the `peerDependencies` range if needed.

### Outbound connections

A module that connects to another server declares the connection when it loads, at the top level of its
server entry (so it is attributed to the module), and passes its id on every call:

```ts
import { msg, outboundFetch, registerPrivacyConnection } from "@sitekeephq/sitekeep-sdk/server";

registerPrivacyConnection({
  id: "autodesk",                                   // the `connection` of its calls
  name: msg("integrations:privacy.autodesk"),       // a text key of the module (or plain text)
  description: msg("integrations:privacy.autodeskSends"),
  hosts: ["developer.api.autodesk.com"],            // shown in the list; hosts the log sees are added
  defaultEnabled: true,                             // false: off until an administrator turns it on
});

await outboundFetch("entegrasyon:autodesk", url, init, { connection: "autodesk" });
```

The Privacy Centre lists it (while the module is on) with its servers, last use and an on/off switch
([privacy](../features/PRIVACY.md#external-connections-list)). The SDK's `outboundFetch` / `outboundCall`
throw `UndeclaredConnectionError` before connecting when the `connection` is missing or not declared;
the core's connections (`ai:<providerId>`, `ai:env`, `smtp`, `office:*`, `google`) need no declaration.
Since SDK 0.15.0.

### Third-party notices of a module

The core's `THIRD_PARTY_NOTICES.md` covers what SiteKeep Community ships and leaves the Enterprise modules out. A module that has
runtime `dependencies` of its own (beyond its `peerDependencies`, which the core provides) carries its own
`THIRD_PARTY_NOTICES.md`, generated by the core's tool from the module's `package-lock.json` and `node_modules`. It lists the
packages the module's dependencies reach that the core does not already ship (same name@version), with their licence texts.
Today only `sitekeep-ai` has such dependencies (`@cursor/sdk` and what it needs); the other modules have none and carry no file.

With the core checked out next to the module (`../sitekeep`, or set `SITEKEEP_CORE`) and `npm ci` run in the module:

```sh
npm run notices          # in the module: writes THIRD_PARTY_NOTICES.md
npm run notices:check    # in the module: exit 1 when it is out of date or a licence is not allowed
# the same from the core:
node tools/third-party-notices.mjs --module ../sitekeep-ai [--out ../sitekeep-ai/THIRD_PARTY_NOTICES.md] [--check]
```

- Licences: the core's allow-list applies. A proprietary package a module may ship is named in `MODULE_ACCEPTED`
  (`tools/third-party-notices.mjs`) with the note shown in the file (today `@cursor/sdk`, AI module only; it stays in
  `FORBIDDEN_PACKAGES` for the core).
- The file is in the package's `files` in `package.json`, so it is published with the module.
- Before tagging a module release: run `npm run notices:check` in the module (module CI has no core checkout, so it does
  not run there). When a dependency is added or upgraded, or the core starts or stops shipping one of the module's
  packages, regenerate the file and commit it with the change.
- Adding the first runtime dependency to a module: add the two scripts below to its `package.json`, add
  `THIRD_PARTY_NOTICES.md` to `files`, and generate the file.

```json
"notices": "node ${SITEKEEP_CORE:-../sitekeep}/tools/third-party-notices.mjs --module .",
"notices:check": "node ${SITEKEEP_CORE:-../sitekeep}/tools/third-party-notices.mjs --module . --check"
```

## Upgrading a module version

1. In the module repository: PR → merge → version → `vX.Y.Z` tag (CI publishes). A module with its own `THIRD_PARTY_NOTICES.md`: `npm run notices:check` first ([above](#third-party-notices-of-a-module)).
2. Here: `npm install @sitekeephq/sitekeep-ee-<id>@X.Y.Z --save-exact -w @sitekeep/server -w @sitekeep/web`, the version row in this document → PR → green CI → merge.
   Check `package-lock.json` afterwards: the module must stay at `node_modules/@sitekeephq/sitekeep-ee-<id>`. When the
   module's SDK range was raised, npm can mistake the workspace SDK link for a conflict and nest the module under
   `apps/server/node_modules` and `apps/web/node_modules` instead; the Community image removes modules only from the
   root `node_modules`, so a nested copy would ship closed code. Move the entry back to the root (one entry, same
   `resolved` / `integrity`) and confirm with `npm ci` (seen with Connect 0.5.0 / 0.5.1, 18.11.2026).
3. Production: deploy (the `.npm_token` on the server must have read access).

## GitHub Packages access

The packages are private. A repository's CI (`GITHUB_TOKEN`) can read a package published from another repository only if the package's
settings allow it: package page → **Package settings → Manage Actions access → Add
repository** (Read).

| Package | Repositories that need to read it |
|---|---|
| `bim-viewer` | `7d-cde` and module repositories that use the viewer types (`sitekeep-coordinate`, `sitekeep-planning` …) |
| `sitekeep-sdk` | `sitekeep-cost`, `sitekeep-field`, `sitekeep-coordinate`, `sitekeep-planning`, `sitekeep-ai`, `sitekeep-manage`, `sitekeep-connect`, `sitekeep-platform` (and later module repositories) |
| `sitekeep-ee-cost` | `7d-cde` |
| `sitekeep-ee-field` | `7d-cde` |
| `sitekeep-ee-coordinate` | `7d-cde` |
| `sitekeep-ee-planning` | `7d-cde` |
| `sitekeep-ee-ai` | `7d-cde` |
| `sitekeep-ee-manage` | `7d-cde` |
| `sitekeep-ee-connect` | `7d-cde` |
| `sitekeep-ee-platform` | `7d-cde` |

Developer machines and the production server use a personal token with `read:packages` (`NODE_AUTH_TOKEN`, `.npmrc`).

## Extracting a new module (checklist)

1. List what the module takes from the core; find the places where the core connects to it directly (routes, reminders, tasks, reports, menus, buttons on other pages).
2. Add what is needed to the SDK; turn the links from the core to the module into contract fields or capabilities.
3. Move the code to `packages/ee-<id>` (`server/`, `web/`), take its schema and migrations (idempotent), add it to `KNOWN_MODULES` (server, web, vitest); access the core only through `@sitekeephq/sitekeep-sdk/*`.
4. Move its tests to `apps/*/test/modules/<id>`; in mixed tests, make the module steps depend on the module being installed.
5. `npm test` and `SITEKEEP_MODULES="" npm test`, e2e, Dockerfile.
6. Create the `sitekeep-<id>` repository using `sitekeep-cost` as the model, publish the package, delete `packages/ee-<id>` here and add the pinned version; grant package access; update this document and the module page.
