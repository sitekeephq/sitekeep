# SiteKeep Repository Structure & Architecture Rules
## 1. Purpose, scope and authority
This document is the living, binding architecture contract of the SiteKeep repository. Its goals are to:
- describe the current monorepo structure and define the owner of every directory and file type;
- keep dependency directions explicit, and make security, privacy and project isolation the default;
- make it easy to add new code in the right place, and establish a single contract across backend, frontend, shared packages and MCP;
- standardise review and Definition of Done criteria.
Scope:
- `apps/server`; `apps/web`;
- `apps/mcp`; `packages/shared`;
- `packages/cde-tools`; tests;
- database migrations; root build and runtime setup;
- architecture documents.
This document is not a historical migration plan. The current refactored structure on disk is authoritative. The old flat `src/routes`, `src/pages` or `src/components` layouts are not an architectural surface for new code. In case of conflict, the order of precedence is:
1. security and data isolation;
2. the working API contract and migration safety;
3. this document;
4. feature documents;
5. local implementation preference.
Responsibility for updating this document lies with:
- the developer who changes an architectural boundary, and anyone who adds a new workspace, domain or public API;
- the owning team member who performs the code review.
If the code structure changes but this document does not, the change is not considered complete.
### 1.1 RFC-style rule keywords
In this document:
- **MUST:** The default without exception; any deviation is justified by a written architecture decision; **MUST NOT:** Cannot be used in new code.
- **SHOULD:** A strong default; any deviation is explained in review; **SHOULD NOT:** Chosen only when there is a concrete benefit and low risk.
- **MAY:** A free choice depending on context.
"The existing code does it this way" is not, on its own, a reason for an exception.
## 2. Monorepo and workspaces
The repository is a single monorepo using npm workspaces. Root:
```text
7d-cde/
├── apps/
│   ├── server/
│   ├── web/
│   └── mcp/
├── packages/
│   ├── shared/
│   ├── cde-tools/
│   └── sdk/              the package through which modules access the core (@7dimensions-project/sitekeep-sdk)
├── docs/                 server/ (our production), onprem/ (customer installation), product/, features/…
├── deploy/               deploy.sh (to production), onprem/ (installation bundle, docs/onprem/installation-bundle.md)
├── tools/                harden-dist.mjs (shrinks the release build; Dockerfile)
├── .github/workflows/    ci.yml, release.yml (v* tag → installation bundle)
├── package.json
├── package-lock.json
├── tsconfig.base.json
├── Dockerfile
└── docker-compose.yml
```

The root `package.json` requires Node.js **22 or later**:

```json
{ "engines": { "node": ">=22" } }
```

The package manager is npm. `package-lock.json` is the authoritative lock file.

### 2.1 Workspace responsibilities
| Workspace | Ownership |
|---|---|
| `@sitekeep/server` | Fastify API, security, persistence, storage, jobs and integrations |
| `@sitekeep/web` | React application, user interaction and viewers |
| `@sitekeep/mcp` | stdio MCP transport adapter and local file capability |
| `@sitekeep/shared` | Shared pure contracts, constants and domain rules |
| `@sitekeep/cde-tools` | Transport-independent CDE/MCP tool definitions |

### 2.2 Workspace dependency direction
Allowed main directions:

```text
apps/web ────────────────> packages/shared
apps/web ────────────────> @7dimensions-project/bim-viewer
apps/server ─────────────> packages/shared
apps/server ─────────────> packages/cde-tools
apps/mcp ────────────────> packages/cde-tools
packages/cde-tools ──────> packages/shared
packages/shared ─────────> external runtime-independent libraries
sitekeep-<id> (module repository) → @7dimensions-project/sitekeep-sdk (reaches the core only through the SDK; docs/modules/README.md)
apps/server, apps/web ───> @7dimensions-project/sitekeep-ee-<id> only by package name, at runtime (app/modules.ts)
```

Forbidden directions:

```text
packages/shared ─X─> any apps/*
packages/cde-tools ─X─> apps/server or apps/web
packages/cde-tools ─X─> DB, Drizzle or storage
apps/web ─X─> apps/server source files
apps/server ─X─> apps/web source files
app/package ─X─> a deep path inside another package's src
```

Packages are imported only through the package's public export surface:

```ts
// Good
import type { WorkSummary } from "@sitekeep/shared";
// Bad
import type { WorkSummary } from "../../../packages/shared/src/works/work-summary";
```

### 2.2.1 External private package: `@7dimensions-project/bim-viewer`

The IFC / 3D model engine is not in this monorepo. `apps/web` consumes it from GitHub Packages
as a versioned dependency:

- package: `@7dimensions-project/bim-viewer`
- source repository: https://github.com/7Dimensions-Project/7dimensions-bim-viewer
- setup: root `.npmrc` → `npm.pkg.github.com`; `NODE_AUTH_TOKEN` + `read:packages`
- pin: `apps/web/package.json` (`--save-exact`; the current version is recorded there, `0.4.6` as of 08.11.2026)

The CDE is the wrapper: `features/coordination/pages/Viewer.tsx` and the related HUD/tools
come from the `bim-viewer`, `bim-viewer/react` and `bim-viewer/tools` public exports.
Changes to the section box, federation, measurement and the Fragments/That Open engine are made in the package
repository; the published version is then upgraded in the CDE. Do not embed the engine as `vendor/*.tgz`;
`apps/web` does not deep-import from the package's `src`.

### 2.3 Root scripts and strict order
Root `package.json` scripts:

```text
dev
  starts the server dev and web dev processes together
build
  shared
  → cde-tools
  → server
  → mcp
  → web
test
  shared build
  → cde-tools build
  → shared test
  → cde-tools test
  → server test
  → web test
typecheck
  checks every workspace that has a typecheck script
e2e
  runs the critical-path tests in Chromium against the production server/web build
scenarios
  shared build
  → cde-tools build
  → server scenarios
```

Exact commands:

```bash
npm run dev
npm run build
npm test
npm run typecheck
npm run e2e
npm run scenarios -- <arguments>
```

The build order must not be changed. The `shared` declaration outputs are used by `cde-tools`, server and web. `cde-tools` is compiled before server and MCP. Web is compiled last. `e2e` uses the previously produced server and web `dist` outputs.

## 3. General architecture principles
SiteKeep is developed as:
- a single monorepo; a modular monolith backend;
- a feature-first frontend; an MCP tool package that talks over REST;
- a shared pure domain package; a persistent job queue for long-running work.
Basic flow:

```text
HTTP route / React page / MCP host
        ↓
service / feature API / tool definition
        ↓
domain rule and access decision
        ↓
DB / storage / REST / provider adapter
```

Mandatory rules:
- A component does not import a page; a service does not import a route.
- Shared does not import app code; CDE tools do not access the DB.
- No deep imports into a package's internal files; no import cycles.
- Security decisions are never left to the frontend or MCP; the same business rule is not copied separately into the route, UI and tool.
- A new screen or user-visible change is not done until unit, desktop e2e and mobile smoke tests are written. Rule: [Tests](tests.md).

## 4. Current repository tree and ownership

### 4.1 `apps/server`
Current top-level structure:

```text
apps/server/
├── drizzle/
├── scripts/
├── src/
│   ├── access/
│   ├── admin/
│   ├── ai/
│   ├── app/
│   ├── auth/
│   ├── bcf/
│   ├── coordination/
│   ├── core/
│   │   ├── platform/
│   │   └── security/
│   ├── db/
│   ├── dev/
│   ├── doccompare/
│   ├── docintel/
│   ├── files/
│   ├── integrations/
│   │   ├── autodesk/
│   │   └── mcp/
│   ├── jobs/
│   ├── locations/
│   ├── model/
│   ├── modules/
│   │   ├── documents/
│   │   └── forms/
│   ├── oauth/
│   ├── office/
│   ├── opencde/
│   ├── param-change/
│   ├── previews/
│   ├── privacy/
│   ├── projects/
│   ├── reports/
│   ├── schedule/
│   ├── scripts/
│   ├── sdk/                # the single entry point from modules into the core
│   ├── sim/
│   ├── templates/
│   ├── today/
│   ├── workflow/
│   ├── works/
│   └── index.ts
├── test/
├── package.json
├── drizzle.config.ts
└── tsconfig.json
```

Ownership:
- `src/app/`: Fastify composition root and dependency contract; `src/core/platform/`: HTTP error model, audit, storage, secrets, process infrastructure.
- `src/core/security/`: auth, roles, access and token scopes; `src/db/`: Drizzle connection and schema exports.
- `drizzle/`: ordered SQL migrations and metadata; domain directories: their own routes, services, access and helpers.
- `src/jobs/`: queue and CPU/long-running workers; `src/admin/`: system administrator (users, companies, `GET /admin/status`).
- `src/auth/`: session, password and Google sign-in (§7.1). `src/oauth/` is its counterpart: the CDE's OpenCDE OAuth2 server.
- `src/integrations/`: third-party adapters.
- `test/`: category-based backend integration and behaviour tests.
- `src/sdk/`: the only surface modules can use from the core (`bind.ts` exposes it to modules); `src/app/modules.ts`: loads installed modules (`SITEKEEP_MODULES`) by package name. Modules live in their own repositories and arrive as pinned-version packages (`@7dimensions-project/sitekeep-ee-<id>`). Rules and capabilities: [Modules](../modules/README.md).

### 4.2 `apps/web`

```text
apps/web/
├── scripts/
├── src/
│   ├── app/
│   │   ├── context/
│   │   ├── layout/
│   │   ├── navigation/
│   │   ├── providers/
│   │   └── routes/
│   ├── features/
│   │   ├── admin/
│   │   ├── ai/
│   │   ├── auth/
│   │   ├── coordination/
│   │   ├── documents/
│   │   ├── forms/
│   │   ├── contracts/
│   │   ├── integrations/
│   │   ├── project-settings/
│   │   ├── projects/
│   │   ├── reports/
│   │   ├── reviews/
│   │   ├── schedule/
│   │   ├── sim/
│   │   └── works/
│   ├── shared/
│   │   ├── api/
│   │   ├── lib/
│   │   └── ui/
│   ├── viewers/
│   │   ├── cad/
│   │   └── office/
│   ├── pdf/
│   ├── main.tsx
│   ├── styles.css
│   └── theme.css
├── test/
├── package.json
├── tsconfig.json
└── vite.config.ts
```

Ownership:
- `app`: composition, router, providers, layout and global context; `features`: domain pages, components, hooks and domain APIs.
- `sdk`: the only surface modules can use from the web core; `app/modules.ts`: installed modules (`virtual:sitekeep-modules`, `sitekeep-modules.ts`) ([Modules](../modules/README.md)).
- `shared/api`: transport and API adapters used by more than one feature; `shared/ui`: domain-independent UI primitives.
- `shared/lib`: pure, domain-independent frontend helpers; `viewers`: CAD/office and the general viewer lifecycle. The IFC/3D engine is `@7dimensions-project/bim-viewer` (see §2.2.1).
- `features/admin`: Administration (users, AI, Office, OAuth, Privacy, System Status, Forma Sync). System Status: §4.8. Forma: §4.9.
- `features/auth`: `/login`. The Google button depends on the `google` flag from `GET /auth/methods` (§7.1).
- `pdf`: PDF.js, comparison and the worker boundary.

### 4.3 `apps/mcp`

```text
apps/mcp/
├── src/
│   ├── index.ts
│   └── ai-connector.ts
├── package.json
└── tsconfig.json
```

`index.ts` is the stdio MCP host. It uses the REST base URL and a bearer token. The local file upload/download capability is enabled only in this host. Tool business logic is not duplicated here.

### 4.4 `packages/shared`

```text
packages/shared/
├── src/
│   ├── coordination/
│   ├── core/
│   ├── contracts/
│   ├── documents/
│   ├── forms/
│   ├── kernel/
│   ├── platform/
│   ├── reports/
│   ├── schedule/
│   ├── viewers/
│   ├── workflow/
│   ├── works/
│   └── index.ts
├── test/
├── README.md
└── package.json
```

Domain ownership:
- `kernel`: permissions, naming, attributes and general pure foundational rules; `core`: base types, module definitions and module state.
- `documents`: document intelligence, comparison, Docs+ and OpenCDE contracts; `coordination`: coordination, BCF, model query, CAD bounds and param change.
- `forms`: form, PDF and PDF source contracts; `workflow`: workflow, roles, assignee and review chain contracts.
- `works`: work catalog, access, numbering, letters, intake and summaries; `schedule`: schedule and sim contracts.
- `contracts`: contract card, bill of quantities with unit prices, addenda, guarantee and progress payment (hakediş) DTOs; the pure `calculateProgressPaymentTotals` (cumulative totals, advance deduction, retention, withholding tax, stamp duty, VAT and partial VAT withholding).
- `reports`: report and report-frame contracts; `viewers`: viewer, markup and office contracts.
- `platform`: hub, OAuth, privacy, templates, locations, terms and AI presets.

### 4.5 `packages/cde-tools`

```text
packages/cde-tools/
├── src/
│   ├── core/
│   │   ├── define.ts
│   │   ├── register.ts
│   │   ├── result.ts
│   │   └── types.ts
│   ├── format/
│   │   ├── common.ts
│   │   ├── lists.ts
│   │   ├── schedule.ts
│   │   ├── workflow.ts
│   │   └── works.ts
│   ├── tools/
│   │   ├── modules/
│   │   ├── ai.ts
│   │   ├── bcf.ts
│   │   ├── core-rest.ts
│   │   ├── dev.ts
│   │   ├── model.ts
│   │   ├── param-change.ts
│   │   └── report.ts
│   └── index.ts
├── test/
└── package.json
```

### 4.6 Test directories
Backend categories:

```text
apps/server/test/
├── ai/
├── auth/
├── coordination/
├── documents/
├── fixtures/
├── forms/
├── integrations/
├── platform/
├── projects/
├── reports/
├── schedule/
├── simulation/
├── viewers/
├── workflow/
└── works/
```

Frontend categories:

```text
apps/web/test/
├── ai/
├── app/
├── documents/
├── integrations/
├── viewers/
└── works/
```

Package tests:

```text
packages/shared/test/
packages/cde-tools/test/
```

Root end-to-end tests:

```text
e2e/
├── fixtures/
├── specs/
├── support/
├── playwright.config.ts
└── README.md
```

`e2e/` owns the critical user journeys that run against the production server/web build.
The harness isolates data and the database on every run; for usage and extension
rules see the [E2E test guide](../../e2e/README.md). The requirement for unit, desktop
e2e and mobile smoke tests on every new screen is in the [Tests](tests.md) document.

### 4.7 `docs`

```text
docs/
├── architecture/
├── archive/
├── features/
├── onboarding/
├── product/
├── server/
└── README.md
```

`architecture` contains the binding technical rules. `features` holds behaviour documents for working features (including `GOOGLE_SIGN_IN.md`). `onboarding` holds setup and development guides (local Google: `onboarding/GOOGLE_SIGN_IN.md`). `product` covers product language and scope. `server` holds production installation, access and post-launch operations notes (`server.md`, `backups.md`, `monitoring.md`, `forma-esitleme.md`); it contains no secrets. `archive` holds research, planning and dated roadmaps; it is not an implementation contract.

### 4.8 Backups and System Status

In the licensed product, monitoring is not Grafana/SSH; it is the CDE's **Administration → System Status**.
Backups are the job of the same package (`jobs` type `backup`, not implemented yet). Contract and "today /
moving to the real thing": [Backups](../onprem/backups.md), [Monitoring](../onprem/monitoring.md).

- Server: `src/admin/status.ts`, `GET /api/v1/admin/status` (`requireAdmin`).
  In development `STATUS_DEMO=1` prints sample figures; in production `0` shows that machine's
  disk / RAM / `jobs` counts.
- Web: `features/admin/pages/AdminStatus.tsx`; menu `app/navigation.ts`
  (`sistem-durumu`, `systemAdmin`). The cards and modal are a shell; the backup job, copy
  deletion, derivative cleanup and the 24-hour line are not yet wired to real data.
- Confirmation dialog: `shared/ui/Ask.tsx` + `ConfirmDialog` (no Chrome `confirm`).
- Once the `backup` job type is added to the §10 queue, Back Up Now / the nightly 02:00 run will be wired up.
  There is no separate Dkron panel.

### 4.9 Forma file sync

Record sync (issues, reviews) lives in `src/integrations/autodesk/` and Project
Settings → Autodesk. The **file** engine (Data Management, signed streaming) does not exist
yet. The shell shown to the team: **Administration → Forma Sync**. Contract and
"today / moving to the real thing": [Forma sync](../features/FORMA_SYNC.md).
Design input (not a contract):
Backups and Forma Sync §2.

- Server: `src/admin/forma-sync.ts`, `GET /api/v1/admin/forma-sync`
  (`requireAdmin`). Sample mapping and last run; `configured` reflects APS env only.
- Web: `features/admin/pages/AdminFormaSync.tsx` (Administration → sample mapping screen; Sync
  Now / Add Mapping are a shell, no files go to ACC). `forma-esitleme` in the project menu
  (`adminOnly`) is the live screen: `ProjectFormaSync.tsx` (connection, Fetch, Import).
- Once the engine's `jobs` type (e.g. `forma-sync`) is added to §10, the same screen will be wired up.
  forma-mcp is not embedded in the product.

## 5. Backend composition and layers

### 5.1 Composition root
`apps/server/src/index.ts` owns process bootstrap. Here:
- config is read from the environment; the DB is opened and migrations are applied;
- storage is created; the `JobQueue` is created;
- converter and provider adapters are created; `buildApp` is called;
- the queue and schedulers are started; shutdown signals are handled.
`apps/server/src/app/build-app.ts` is the HTTP composition root. Here:
- Fastify is created; cookie and multipart are registered;
- the auth hook is installed; the privacy/outbound context is set up;
- security headers are added; `/api/v1` routes are registered;
- the WOPI, OAuth, OpenCDE Documents and MCP special surfaces are registered; the web build is served if needed.
`apps/server/src/app/deps.ts` is the dependency contract. `AppDeps` defines the dependencies supplied by tests and bootstrap. `ResolvedDeps` is the type after `buildApp` applies the defaults. Domain code must receive dependencies instead of looking up global singletons.

### 5.2 Domain route placement
A new route lives next to its domain:

```text
src/projects/routes.ts
src/reports/routes.ts
src/locations/routes.ts
src/modules/documents/routes.ts
```

A large route surface is split into an orchestrator + parts:

```text
src/modules/forms/routes.ts
src/modules/forms/routes/
  shared.ts
  templates.ts
  instances.ts
  attachments.ts
  issues.ts
  pdf-templates.ts
  pdf-export.ts
src/works/routes/works.ts
src/works/routes/
  route-helpers.ts
  work-items.ts
  work-actions.ts
  work-links.ts
  work-today.ts
  work-types.ts
```

Orchestrator:
- sets the registration order of sub-routes; passes the shared prefix and shared dependencies;
- contains no domain work or large queries.
Sub-route:
- validates params/query/body; calls the access helper;
- calls the service/use case; produces the HTTP response.

### 5.3 File type ownership
`routes.ts` or `routes/*.ts`:
- HTTP method, URL, headers, status; Zod boundary validation;
- multipart and streams; service calls.
`schema.ts`, `*-schemas.ts`, `template-schemas.ts`:
- runtime request or config validation; types derived from schemas.
`service.ts`:
- use-case orchestration; domain state transitions;
- transaction decisions; job enqueueing and adapter coordination.
`access.ts`, `*-access.ts`, `policy.ts`:
- visibility and permission decisions; project/folder/role scope;
- deny-by-default guards.
`dto.ts`:
- stable external response shape; safe mapping from DB or provider models.
`public.ts`:
- the narrow registration surface a large module exposes; a facade that hides internal route parts.
`helpers.ts` or `*-helpers.ts`:
- named repetition that is meaningful only within the same domain; business rules are not hidden in a vague "utils" folder.
`repository.ts` is **optional**. It is only worthwhile when:
- a complex query is reused across several use cases; a test double for the query brings a real benefit;
- the query composition carries domain meaning.
A repository is not created for every table. A readable, single-use Drizzle query may stay in the service or in an explicit domain helper.

### 5.4 Dependency rules
Allowed:

```text
route → schema/access/service
service → access/domain/db/storage/job/provider
worker → pure worker input/output and infrastructure
domain helper → shared pure types
```

Forbidden:

```text
service → route
access → route
DB schema → Fastify request
worker → Fastify request/reply
domain → web component
route A → route B's handler
```

Collaboration with another domain happens not through routes but through:
- service/public functions; shared pure contracts;
- jobs/events; REST adapters.

## 6. Database and migration rules

### 6.1 DB surface
`apps/server/src/db/index.ts`:
- opens PostgreSQL or PGlite; applies migrations;
- provides the typed `Db`; owns the close lifecycle.
`memory://` is for test/development only. PostgreSQL is recommended in production.

### 6.2 Schema
The main export is in `apps/server/src/db/schema.ts`. Feature tables are split into `schema-*.ts` files. A new table:
- has a primary key; has a `projectId` if it is a project resource;
- chooses foreign key behaviour explicitly; has indexes that match filtering/sorting needs;
- names timestamp meanings explicitly; does not bury a core queryable field in arbitrary JSON.
A DB row is not an API DTO. Secrets, hashes, storage keys and internal columns must not leak into responses.

### 6.3 Project scope
Every project-owned query is project-scoped. Good:

```ts
where(and(eq(records.projectId, projectId), eq(records.id, recordId)))
```

Bad:

```ts
where(eq(records.id, recordId))
```

A `projectId`, `userId`, `companyId` or role ID coming from the client is not trusted. Identity is taken from the server auth context. Project membership in the URL is verified by a central guard such as `projectAccess`.

### 6.4 Transactions
A transaction is mandatory when:
- several writes must succeed together; there is a race when allocating numbers/sequences;
- state and the audit record must be atomic; a workflow step and the resource state change together.
The following are not done inside a transaction:
- LLM calls; SMTP;
- external HTTP; large file conversion;
- waiting for a worker result.
First the consistent DB state is written. Then the job or a safe post-transaction effect is started.

### 6.5 Migrations
Migrations live under `apps/server/drizzle/`. Config:

```text
apps/server/drizzle.config.ts
schema: ./src/db/schema*.ts
out: ./drizzle
```

Command:

```bash
npm run db:generate -w @sitekeep/server
```

Rules:
- a schema change is not complete without a migration; sequence numbers do not collide;
- assume existing production data; consider expand–migrate–contract for rename/drop;
- backfills are bounded and re-runnable; the generated snapshot is not edited by hand arbitrarily;
- a migration must be compatible with both PostgreSQL and supported PGlite behaviour.

## 7. Auth, isolation and token scope
The default policy is deny-by-default. The `/api/v1` hook in `buildApp` requires auth for any route that is not explicitly `public`. `apps/server/src/core/security/access.ts` is the central surface for:
- project membership; token project boundaries;
- the folder tree; effective permissions;
- action guards.
`apps/server/src/core/security/token-scope.ts` enforces read/write according to the HTTP method and route semantics. Rules:
- even if a browser session is treated as write-capable, domain access is still checked separately; an API token respects its `read`/`write` scope;
- an API token cannot exceed its `projectIds` boundary; an OAuth token cannot exceed its granted scope;
- the system admin bypass is central and visible; when needed, 404 is returned so that a resource's existence does not leak to non-members;
- hiding a button in the frontend is not authorization.
Every endpoint answers these questions:
1. Who is the caller?
2. What is the token type and scope?
3. Which project is being accessed?
4. Does the resource really belong to that project?
5. Is the folder/role/workflow permission sufficient?
6. Does the operation require an audit record?
7. Is data leaving the system?

### 7.1 Sign in with Google

This is the CDE session. It is not the OpenCDE OAuth2 server (§11.2). Contract and errors:
[Sign in with Google](../features/GOOGLE_SIGN_IN.md). The three local lines:
[Local Google sign-in](../onboarding/GOOGLE_SIGN_IN.md).

- All three env variables together: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_CALLBACK_URL`. If any is empty there is no `googleAuth`; no button.
- `GET /auth/methods` returns `{ password: true, google: boolean }`. The web app draws
  **Continue with Google** only when `google: true`.
- Google provides a verified email. The CDE looks it up in `users.email` (lower case).
  If there is no record and the `auth.google` allowed domain (`domainAllowlistEnabled`
  + `domains`) matches, a non-admin user is created. If the user is `disabled`
  or the domain does not match: `account_not_allowed`. Setting: Administration → Users.
- The external call is `outboundFetch(..., { connection: "google" })`, purpose
  `giris:google`. `state` is an httpOnly cookie; if it does not match, the callback does not sign in.
- The callback is the browser origin (`localhost:5173` / `sitekeep.ornek.com`),
  not the API port. Secrets never go into source control (§12).

## 8. Errors, audit, privacy and outbound

### 8.1 Error model
`apps/server/src/core/platform/http.ts` is the authoritative HTTP error surface. Expected errors are expressed with `HttpError` and a stable code. A Zod error returns 400 as `validation`. A unique violation is converted into a controlled 409. An unexpected error:
- is recorded in the error ring; is written to the server log;
- returns only `internal` and a safe message to the client.
Stack traces, SQL, filesystem paths, tokens or provider bodies are never returned to the client. Errors are not swallowed:

```ts
// Bad
catch { return null; }
```

### 8.2 Audit
`apps/server/src/core/platform/audit.ts` is the shared surface for business audit. An audit record contains:
- the user; the project;
- a stable action; target type/id;
- minimal safe metadata.
Document content, secrets and tokens are never written to the audit.

### 8.3 Privacy and outbound
`apps/server/src/privacy/` owns:
- privacy settings; redaction;
- outbound records; security headers.
An external HTTP or AI call:
- goes through the outbound policy; carries the user/project/feature context;
- uses a timeout; does not log sensitive content;
- does not treat the response as trusted.
`buildApp` redacts WOPI/OAuth tokens, codes, verifiers and conversion tickets in URL logs.

## 9. Storage, upload and streaming
`apps/server/src/core/platform/storage.ts` owns the storage contract and the local adapter. Rules:
- a user file name never becomes a storage path; the storage key is generated by the server;
- path traversal is blocked; size and file count are bounded by multipart limits;
- MIME type and extension alone are not trusted; checksum and version metadata are preserved;
- large files are streamed without loading them fully into memory; download responses use a safe content type/disposition;
- temporary files are cleaned up in `finally`; archive extraction limits zip-slip and decompression bomb risks.

## 10. Jobs and workers
`apps/server/src/jobs/queue.ts` owns the persistent job queue. Current worker areas:

```text
jobs/ifc-worker.ts
jobs/ifc-spatial-worker.ts
jobs/clash-worker.ts
jobs/ids-worker.ts
jobs/param-change-worker.ts
jobs/version-index.ts
```

A job payload is:
- small; JSON-serialisable;
- based on ID and version references; free of secrets;
- versionable where possible.
A worker:
- is idempotent or duplicate-safe; writes the queued/running/done/failed states correctly;
- enforces timeouts and resource limits; checks for stale resource state;
- produces a persistent error visible to the user; does not receive request/reply objects.
CPU-heavy parsers/converters may be kept behind a worker thread/process boundary. A route does not run long work directly; it enqueues a job and returns 202 where appropriate.
The `backup` type is not registered yet; its contract is in [Backups](../onprem/backups.md).
The scheduler stays in the same class as the Autodesk / reminder schedulers (no separate Dkron).

## 11. Integration surfaces

### 11.1 Autodesk
`apps/server/src/integrations/autodesk/` owns:
- OAuth/PKCE; the provider client;
- routes; projection;
- the sync scheduler; provider adapters.
A provider DTO is never used directly as an internal domain DTO. Tokens follow the encrypted-at-rest approach.
Today only **records** are synced (issues, reviews, forms). Folder/file sync (§4.9) is
a sample screen; Data Management does not exist yet.

### 11.2 OpenCDE and OAuth
`apps/server/src/opencde/` is the OpenCDE Documents/pages surface. `apps/server/src/oauth/` owns the OAuth2 server, foundation discovery, consent and the token lifecycle. Part of these surfaces is published outside `/api/v1`, as the standard requires. Standard paths and payloads cannot be changed arbitrarily for in-app convenience. This is not the user signing in to the CDE with Google (§7.1).

### 11.3 WOPI and office
`apps/server/src/office/` owns:
- the WOPI host; discovery/proof;
- editor/converter settings; the office service.
WOPI tokens are redacted at query/log/redirection boundaries. Proof verification runs with a safe default in production.

### 11.4 Hosted MCP
`apps/server/src/integrations/mcp/routes.ts` owns the hosted MCP transport. Tool definitions come from `@sitekeep/cde-tools`. Hosted MCP does not open local filesystem access.

### 11.5 AI
`apps/server/src/ai/` owns:
- provider selection; prompt construction;
- tool schemas/routing; the Ask bridge;
- task orchestration.
Rules:
- provider transport and domain prompts are kept separate; no secrets are put into prompts;
- tool calls do not bypass backend authorization; Ask does not open its own DB path; it uses the existing secure tool/REST surface;
- model output is treated as `unknown` and validated; timeouts and output limits are mandatory;
- external AI requires privacy/outbound permission; provider keys are never logged or returned in responses;
- a model decision alone never starts a destructive operation.

## 12. Config and secrets
The process environment should be read only at bootstrap and at the relevant adapter config boundary. A new domain service should not read `process.env` directly. Config is:
- parsed at startup; booleans/strings/numbers are converted explicitly;
- fail-fast when something critical is missing; supplied through explicit fixtures in tests.
Secrets:
- never go into source control; `.env.example` contains only names and safe examples;
- are redacted in URLs, errors, audit and logs; no default production secret is provided;
- the encryption key is backed up together with the DB/storage but protected separately; a plain token is shown only at creation time.
Google sign-in names (no values): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_CALLBACK_URL`. All three are read at bootstrap by `googleAuthFromEnv`.

## 13. Frontend boundaries

### 13.1 `app`
`apps/web/src/main.tsx` owns the composition of:
- the React root; QueryProvider;
- BrowserRouter; AuthProvider;
- global CSS.
`apps/web/src/app/App.tsx` connects the result of auth bootstrap to the route surface. `apps/web/src/app/routes/AppRoutes.tsx` is the authoritative route tree. `app/layout` owns the shell and the project shell. `app/context` owns the auth, project and embedded contexts. Feature business logic is not put into `app`.

### 13.2 Feature
A feature may own:

```text
features/<domain>/
├── pages/
├── components/
├── api.ts
├── hooks/
└── pure domain frontend helpers
```

Creating every subfolder is not mandatory. A page:
- reads route parameters; wires query/mutation hooks;
- arranges loading/error/empty/success states; composes feature components.
A component:
- does not import pages; does not know the route tree;
- behaves through props/callbacks where possible; contains no raw endpoint strings.
A hook:
- encapsulates reused state/effect or query behaviour; does not render;
- does not make authorization decisions.
A feature API:
- names the domain endpoints; uses request/response DTOs;
- handles transport details through `shared/api/client.ts`.

### 13.3 Shared
`shared/ui` is for domain-independent UI such as:
- Dialog; LoadingIndicator;
- Icon; FilterBar;
- general input/list/card primitives.
A domain label or workflow component is not made shared just because it is used in two places. `shared/lib` is for pure, small, domain-independent helpers. No `utils.ts` dumping ground is created.

### 13.4 Viewer and PDF
The IFC / 3D engine lives in the `@7dimensions-project/bim-viewer` package (§2.2.1). `apps/web`
owns the wrapper, the project context, the model list and the CDE tools. `viewers` owns CAD/office
and the general viewer lifecycle. `pdf` owns PDF.js and the PDF comparison
workers. Rules:
- viewer routes are lazy-loaded; Three.js, IFC, CAD, office and PDF dependencies are not forced into the main bundle;
- the worker URL/copy layout stays compatible with `apps/web/scripts/copy-worker.mjs`; on unmount, the renderer, scene, controls, workers, object URLs and event listeners are cleaned up;
- large models and pages load progressively; a viewer error does not crash the whole application;
- engine behaviour (sections, federation, Fragments) changes in the package; the CDE only upgrades the pinned version.

## 14. Frontend data and state
State classes:
1. server state;
2. URL state;
3. form draft state;
4. transient UI state.
TanStack Query is the default for server state. Global defaults are in `app/providers/QueryProvider.tsx`. Rules:
- the same server data is not copied into several local states; the query key includes the project and resource ID;
- old project data is not shown after a route change; targeted invalidation is done after a mutation;
- optimistic updates are done only if a rollback is defined; double submits are prevented;
- stale response races are prevented with AbortSignal or the query lifecycle; filters/tabs/IDs that must be shareable in the URL are not stored in local state;
- form drafts are not put into an unnecessary global context.
Every data view distinguishes these states:
- initial loading; background refresh;
- empty; error;
- unauthorized/not found; success.

## 15. Frontend transport and domain API
`apps/web/src/shared/api/client.ts` owns only:
- the `/api/v1` prefix; credentials;
- JSON serialise/parse; `ApiError`;
- the 401 event; AbortSignal.
Raw `fetch` is not used inside components. Feature domain API example:

```ts
// Good: features/forms/api.ts
export const getForm = (projectId: string, formId: string, signal?: AbortSignal) =>
  get<FormDto>(`/projects/${projectId}/forms/${formId}`, { signal });
```

Bad:

```ts
// Inside a component
fetch(`/api/v1/projects/${pid}/forms/${id}`);
```

Upload, download and stream are handled explicitly as different response types. The backend error code is preserved; UI messages are not reduced to matching status strings.

## 16. Routing, layout and context
Route definitions are central, under `app/routes/AppRoutes.tsx`. Navigation metadata is kept under `app/navigation/`. Layout is responsible for:
- the top-level shell; the project shell;
- the outlet; navigation;
- global notifications.
Context is reserved for stable values that a wide subtree genuinely shares. The following are not put into context:
- all server state; every dialog state;
- feature-specific form drafts.
A route guard provides UX; it does not replace backend access control. Legacy URL redirects are kept only in an explicit adapter such as `app/routes/LegacyProjectRedirect.tsx`.

## 17. React, UX and effects
`useEffect` is only for synchronising with systems outside React:
- event listeners; timers;
- viewers; DOM APIs;
- subscriptions.
A value that can be derived during render is not copied into state with an effect. An effect:
- cleans up; declares its dependencies correctly;
- cancels async races; explains the reason for any lint suppression.
Optimistic UX:
- may show the user's intent immediately; defines a temporary ID and rollback;
- makes conflicts visible; treats the server result as authoritative.
Error UI:
- tells the user what happened; offers retry when safe;
- does not leak internal technical errors.
Empty UI:
- distinguishes a genuinely empty state from an empty filter result; offers an appropriate next action to authorised users.

## 18. CSS, design, accessibility and responsive layout
Global foundation:

```text
src/theme.css
src/styles.css
src/viewers/viewers.css
```

Rules:
- colour, spacing and typography tokens are reused; domain state is not conveyed by colour alone;
- inline styles are used only for genuinely dynamic geometry; a new page does not invent a new visual language;
- desktop and narrow screens are designed together; an overflow/sticky/phone strategy is defined for wide tables;
- layout shift is minimised.
Accessibility:
- every input has a label or accessible name; button behaviour is not built on a `div`;
- keyboard access is provided; dialogs implement a focus trap and focus return;
- loading carries `role="status"` or equivalent semantics; form errors are associated with their field;
- contrast is sufficient; a textual alternative or description is considered for canvas/viewers;
- the reduced motion preference is respected for unnecessary animation.
Performance:
- route/viewer lazy loading; pagination/virtualisation in lists;
- debounce in search; object URL/worker cleanup;
- measured memoisation; monitoring bundle growth
are applied.

## 19. Frontend import contract
The web app uses `moduleResolution: Bundler`. Following the existing convention, local frontend imports have no extension:

```ts
import { Dialog } from "../../../shared/ui/Dialog";
```

The shared package is imported only from the root public API:

```ts
import type { UserDto } from "@sitekeep/shared";
```

Rules:
- component → page imports are forbidden; shared → feature imports are forbidden;
- feature → another feature's deep component path should be avoided; `import type` is used for types;
- no cycles are created; app composition may import features;
- a feature does not import the app layout.

## 20. `packages/shared` rules
Single public package entry:

```text
packages/shared/src/index.ts
```

The package `exports` publishes only `"."`. Applications do not deep-import leaves. Inside the package, however, modules import leaves directly and do not go back through the root barrel:

```ts
// Good inside the package
import type { PermissionLevel } from "../kernel/permissions.js";
// Bad inside the package
import type { PermissionLevel } from "../index.js";
```

This rule reduces the risk of cycles. What may be added to shared:
- DTOs used by two or more workspaces; stable enums/unions;
- shared constants; pure permission/naming/workflow rules;
- runtime-independent parsers/formatters.
What is not added:
- DB rows; Drizzle;
- Fastify; React;
- filesystem; environment;
- fetch clients; provider SDKs;
- secrets.
Recipe for a new contract:
1. Choose the right domain leaf file.
2. Add the pure type/rule there.
3. Make imports inside the leaf use leaf paths.
4. If it is to be public, add it to the root `index.ts` exports.
5. Add a package test.
6. Build `shared`.
7. Switch consumers to the root import.
If a cycle appears:
- move the shared primitive of the two modules into a lower-level domain file; use type-only imports;
- do not use the root barrel inside the package; do not hide a cycle by moving an app-specific type into shared.

## 21. `packages/cde-tools` rules

### 21.1 Core
`core/types.ts` owns the contracts:
- `CdeCall`; `CdeToolDef`;
- `CdeToolsOptions`.
`CdeCall` is only a REST call:

```ts
type CdeCall = <T = unknown>(
  method: string,
  url: string,
  body?: unknown,
) => Promise<T>;
```

No DB, Drizzle, server service or storage access is added. `core/define.ts` defines the tool-adder type. `core/register.ts` registers definitions with the MCP SDK and applies the output limit and audit callback. `core/result.ts` converts the HTTP result into a tool result.

### 21.2 Format
`format/` owns short, stable text formats suited to the model context. Domain rules are not hidden in format files.

### 21.3 Tools and modules
General tool groups live under `tools/*.ts`. Dense domain groups:

```text
tools/modules/documents.ts
tools/modules/forms.ts
tools/modules/schedule.ts
tools/modules/coordination.ts
tools/modules/reviews.ts
tools/modules/works.ts
tools/modules/works-write.ts
```

A new tool:
- validates input with a Zod shape; calls the existing REST endpoint through `CdeCall`;
- returns small, stable output; carries the correct flags;
- is registered in the package root registry; is tested.

### 21.4 Gating
Flag meanings:
- `write`: changes state; not registered on a read-only connection; `local`: requires the local filesystem; not registered in hosted MCP.
- `dev`: registered only when dev tools are enabled; `destructive`: carries a deletion/irreversible effect into the MCP annotation.
Rules:
- a write tool states the expectation of user confirmation in its description; a destructive tool is marked both `write` and `destructive`;
- dev tools are off by default in production; dev tools are not enabled on a read-only connection;
- local tools are not enabled in hosted MCP; read-only is not just a description, it is enforced through registration gating.
Tool names and vocabulary follow the existing `cde_*` language. No synonyms that conflict with REST resource names or `@sitekeep/shared` terms are invented.

## 22. TypeScript and code quality
Root config:
- `strict`; `noUncheckedIndexedAccess`;
- `forceConsistentCasingInFileNames`; NodeNext.
The web app additionally uses bundler resolution and isolated modules. Rules:
- untrusted data is `unknown`; `any` is allowed only at an unavoidable third-party boundary, in a narrow area and with a justification;
- an assertion does not replace runtime validation; non-null assertions are used only for a proven invariant;
- public function inputs/outputs are explicit; a number with a unit carries the unit in its name: `timeoutMs`, `sizeBytes`;
- impossible states are modelled with discriminated unions; DB types and DTO types are considered separately.
A function:
- is named with a verb; has a single main intent;
- takes a command/options object instead of long positional parameters; does not secretly mutate its input;
- stays readable with guard clauses; avoids vague names such as `process`, `handleData`, `doThing`.
Comments:
- do not repeat what the code does; explain the reason for a security, standard or surprising decision;
- do not tell history; history is in Git; a TODO carries an issue/condition.
Duplication:
- if it is the same business rule, it is shared; if it only looks similar but changes for different reasons, it is not merged prematurely;
- no vague abstraction is built to save three lines.
Dead code:
- no commented-out old implementations are kept; unused exports/imports are deleted;
- temporary debug logs are not merged; a compatibility shim states its removal condition.

### 22.1 Barrel rules
Barrels are only for a stable public API. No barrel that exports everything inside a feature is created. A barrel:
- does not hide cycles; has no side effects;
- does not accidentally make an internal symbol public.

### 22.2 File size
There is no arbitrary hard line limit. File size is a signal about responsibility.
- **Over 800 lines:** the separation of responsibilities is explicitly examined in code review; **over 1000 lines:** a written justification is required or the file is split at a meaningful boundary.
Meaningless micro-files are not created just to meet a limit. The context of route orchestrators, page composition and generated files is taken into account.

### 22.3 Generated files
Generated:
- lockfiles; Drizzle metadata/snapshots;
- build output; worker copies
are not "cleaned up" by hand. The source generator or schema is changed instead. `dist/`, coverage and local data are not added to source control.

### 22.4 NodeNext imports
Local ESM imports in server, MCP, shared and cde-tools use the `.js` extension:

```ts
import { projectAccess } from "../core/security/access.js";
```

Even though the source file is `.ts`, `.js` is required for the emitted ESM. Local web imports use no extension, following the bundler convention.

## 23. API rules
The application REST API lives under `/api/v1` by default. Exceptions exist only where a protocol requires them:
- WOPI; OAuth2/Foundation;
- OpenCDE Documents; hosted MCP;
- the static web app.
Rules:
- URL resource names are plural and consistent; a project-owned resource URL carries the project context;
- GET has no side effects; POST is create/command;
- PATCH is a partial update; DELETE deletes;
- create returns 201 where appropriate; async work returns 202 + job information where appropriate.

### 23.1 Boundary validation
Params, query and body are validated with Zod at the boundary. UUID, enum, length, date, limit and sort fields are allowlisted. A TypeScript type is not runtime validation. File metadata is also untrusted input.

### 23.2 DTO compatibility
- Removing a response field is a breaking change; a field is not renamed without a transition.
- Adding a value to an enum affects exhaustive frontend code; dates are ISO strings in JSON.
- Internal DB columns are not automatically spread into a DTO; if a shared contract changes, server, web and tools are assessed together.

### 23.3 Pagination
A list endpoint has:
- a bounded limit; a stable sort;
- a cursor or explicit page metadata; a filter allowlist.
Unbounded tables are never dumped.

### 23.4 Idempotency
A create/command that may be retried is protected by one of:
- an idempotency key; a unique business key;
- a duplicate-safe state transition.
GET must be retry-safe. Destructive operations are not retried blindly.

### 23.5 File streaming
- large files are not accumulated in a buffer for the response; content length is written if known;
- range support is preserved according to viewer behaviour; the filename is safely encoded in the header;
- an aborted client stream closes its resources.

### 23.6 Error response
Stable shape:

```json
{
  "error": "stable_code",
  "message": "A message that is safe to show the user.",
  "details": {}
}
```

`details` contains only safe validation/domain details. Raw provider, SQL or stack errors are never returned.

## 24. Security and privacy checklist
For every change:
- [ ] Default deny is applied.
- [ ] Routes without auth are explicitly public.
- [ ] Every project query is scoped by `projectId`.
- [ ] Client-supplied user/company/project IDs are not trusted.
- [ ] Token read/write and project scope are respected.
- [ ] OAuth scope is respected.
- [ ] A resource cannot be fetched by ID from another project.
- [ ] Secrets do not enter responses/logs/audit.
- [ ] Secrets in URL queries are redacted.
- [ ] AI/outbound calls pass the privacy check.
- [ ] SSRF/redirect/timeout have been assessed for external URLs.
- [ ] Upload size, count, path and archive limits exist.
- [ ] HTML/Markdown is rendered safely.
- [ ] GET does not change state.
- [ ] Sensitive writes are audited.

## 25. Test architecture

### 25.1 Shared unit tests
`packages/shared/test/` is the place for tests of:
- naming; permissions;
- workflow; contracts;
- pure mappers/formatters; privacy;
- model query.

### 25.2 CDE tools tests
`packages/cde-tools/test/cde-tools.test.ts` covers tests of:
- the tool inventory; registration;
- readOnly/local/dev/destructive gating; the REST call shape;
- output formatting/error mapping.

### 25.3 Server tests
`apps/server/test/<category>/` owns integration tests, mostly Fastify + PGlite. For a feature change, the following are considered:
- the success path; Zod validation;
- unauthenticated; wrong project / unauthorised;
- read-only token; important conflict/not-found cases;
- DB state; audit;
- job enqueue; secret redaction.
Test helpers are not moved arbitrarily into another feature category. Shared binary/XML fixtures are kept under `apps/server/test/fixtures/`. A fixture is:
- minimal; synthetic or suitably licensed;
- free of secrets; deterministic.

### 25.4 Web tests
`apps/web/test/<category>/` owns tests of:
- routes/navigation; pure feature behaviour;
- phone/responsive decisions; viewer geometry/helpers;
- API option mapping.
If a critical UI flow changes, loading/error/empty states and user behaviour are tested.

### 25.5 Root E2E smoke tests
`e2e/specs/` verifies critical user journeys in Chromium against the production server/web
build. A new screen, new route or user-visible change is not closed
without unit, desktop e2e and mobile smoke tests. The scope is in the [Tests](tests.md)
document. E2E is not used for every permutation of a pure rule; those variations
are the responsibility of shared/server/web tests.

Rules:
- prerequisites may be set up through an isolated API; the behaviour under test and the visible result are verified through the UI;
- live, shared, production or customer data is never used;
- tests are order-independent and set up minimal, deterministic data;
- external integrations are verified with contracts/mocks or run in an explicitly separate dedicated integration environment;
- selector and fixture details are kept in the [E2E test guide](../../e2e/README.md).

### 25.6 Test data safety
A test:
- does not connect to the live production DB; does not use production URLs/tokens;
- contains no real customer data; makes no real SMTP/AI/Autodesk/OpenCDE calls;
- sets up its own data; does not depend on test order;
- controls time/randomness when needed.
A count of 907 tests may be cited as a verified baseline for a given period. This number is not an invariant or a quality target. New tests may change it; what matters is behaviour coverage and the whole suite passing.

### 25.7 Required tests per change
| Change | Minimum test |
|---|---|
| Pure shared rule | shared unit test |
| API endpoint | server integration test |
| Access change | allowed + denied + cross-project |
| Migration | read/write with the new schema and the upgrade assumption |
| Job | enqueue + success + failure/idempotency |
| MCP tool | registration/gating + REST call |
| Pure frontend logic | web unit test |
| New route or user-visible flow | unit + desktop e2e + `mobile-` spec + smoke route ([Tests](tests.md)) |

## 26. Commands and Definition of Done
Setup:

```bash
node --version
export NODE_AUTH_TOKEN="<GitHub token with read:packages>"
npm ci
```

The Node output must be 22 or later. `.npmrc` downloads the private
`@7dimensions-project/bim-viewer` package from GitHub Packages
(§2.2.1); `NODE_AUTH_TOKEN` must therefore have `read:packages` permission, and its real
value must never be written to a file or a commit.

Targeted checks:

```bash
npm run typecheck
npm test -w @sitekeep/shared
npm test -w @sitekeep/cde-tools
npm test -w @sitekeep/server
npm test -w @sitekeep/web
npm run e2e -- e2e/specs/<area>.spec.ts
```

Full gate:

```bash
npm run build
npm run typecheck
npm test
npm run e2e:install
npm run e2e
```

`npm run e2e:install` installs Chromium once; CI also installs the operating system dependencies
with `npx playwright install --with-deps chromium`.

When a scenario is needed:

```bash
npm run scenarios -- <scenario>
```

Definition of Done:
- [ ] The code is in the current domain/feature directory.
- [ ] No forbidden dependency direction.
- [ ] Runtime boundary validation exists.
- [ ] Project and token scope have been checked.
- [ ] The transaction boundary has been assessed.
- [ ] An error code and a safe message are defined.
- [ ] The audit/privacy/outbound impact has been assessed.
- [ ] Upload/storage security has been assessed.
- [ ] The required migration exists.
- [ ] The required unit/integration tests exist.
- [ ] Unit, desktop e2e and mobile smoke tests exist for a new screen or visible flow ([Tests](tests.md)).
- [ ] The UI has loading/error/empty states.
- [ ] Accessibility and responsive behaviour have been checked.
- [ ] Typecheck/test/build and, if needed, E2E have passed at the appropriate scope.
- [ ] Documentation is up to date.
- [ ] No dead code, debug logs or secrets.

## 27. Step-by-step recipes

### 27.1 New backend endpoint or domain
1. Determine the domain owner.
2. Add the route under `apps/server/src/<domain>/routes.ts`.
3. If it is large, use `routes/` sub-parts and a thin orchestrator.
4. Put the Zod schema in the domain schema file.
5. Wire the access guard to the existing central helper.
6. Put the use case in `service.ts` or a named domain file.
7. Do not create a repository unless there is repetition.
8. If a DB is needed, add `src/db/schema-<domain>.ts` and a migration.
9. Register the route in `apps/server/src/app/build-app.ts`.
10. Add tests under `apps/server/test/<category>/`.
Good:

```text
coordination/routes/issues.ts
coordination/clash-access.ts
coordination/service.ts
```

Bad:

```text
src/routes/new-thing.ts
src/services/new-thing.ts
```

### 27.2 New frontend page or feature
1. Choose the domain under `apps/web/src/features/<feature>/`.
2. Put the route entry page under `pages/`.
3. Put UI parts under the feature's `components/`.
4. Put the domain API in the feature's `api.ts`.
5. Use `shared/api/client.ts` for transport.
6. Add `projectId` and the resource ID to the query key.
7. Add the route to `app/routes/AppRoutes.tsx`.
8. Update `app/navigation/` if navigation is needed.
9. Add loading/error/empty and responsive states.
10. Add an `apps/web/test/<category>/` test.
11. Write and run unit, desktop e2e, `mobile-<feature>.spec.ts` and the `mobile-smoke` route according to the [Tests](tests.md) rule.
Good:

```text
features/reports/pages/Reports.tsx
features/reports/components/ReportFrame.tsx
```

Bad:

```text
src/pages/Reports.tsx
src/components/ReportFrame.tsx
```

### 27.3 New shared contract
1. Verify that it is really used by two workspaces.
2. Add or update `packages/shared/src/<domain>/<name>.ts`.
3. Verify that it has no runtime dependency.
4. Make in-package imports use leaf paths.
5. If it is public, add it to the `packages/shared/src/index.ts` exports.
6. Add a test under `packages/shared/test/`.
7. Build shared.
8. Use only the `@sitekeep/shared` root import in consumers.
Good:

```ts
export type ReviewStatus = "draft" | "active" | "closed";
```

Bad:

```ts
export type ReviewRow = typeof reviewTable.$inferSelect;
```

### 27.4 DB schema migration
1. Determine the table owner.
2. Update `apps/server/src/db/schema-<domain>.ts`.
3. Add the `schema.ts` export if needed.
4. Design the project FK/index/unique behaviour.
5. Run `npm run db:generate -w @sitekeep/server`.
6. Review the new `apps/server/drizzle/<nnnn>_*.sql` file.
7. Design the data migration/backfill to be bounded.
8. Add a PGlite integration test.
9. Review PostgreSQL compatibility.
10. Make breaking drops/renames in stages.
Good: add nullable → backfill → constraint → remove the old field later. Bad: a single-step rename/drop on a populated production table.

### 27.5 New job
1. Define the job kind and a small payload contract.
2. Wire the queue dispatch through `apps/server/src/jobs/queue.ts`.
3. Add the handler/worker under `apps/server/src/jobs/<name>-worker.ts`.
4. Validate the payload at runtime.
5. Define the idempotency key.
6. Define the timeout, retry and persistent error behaviour.
7. Have the route/service only enqueue.
8. Add success/failure/duplicate tests.
9. Verify temp and worker resource cleanup.
Good: `{ projectId, fileVersionId }`. Bad: putting the whole binary file into the job JSON payload.

### 27.6 New MCP tool
1. Choose the existing `/api/v1` endpoint; if there is none, add a secure endpoint first.
2. Add the tool under `packages/cde-tools/src/tools/` or `tools/modules/`.
3. Define the Zod input shape.
4. Use only `CdeCall`.
5. Choose the `write`, `local`, `dev`, `destructive` flags correctly.
6. Bound the output with a `format/` helper.
7. Add it to the `packages/cde-tools/src/index.ts` registration.
8. Add gating and REST call tests.
9. Verify the difference between stdio and hosted MCP.
Good: tool → REST → server access/audit. Bad: tool → Drizzle → table.

### 27.7 New integration
1. Open the provider boundary under `apps/server/src/integrations/<provider>/`.
2. Separate client, auth, mapper/adapters and route responsibilities.
3. Pass config through bootstrap/deps.
4. Design secret redaction and encrypted storage.
5. Define timeout, retry and rate limit.
6. Validate the provider response with Zod.
7. Wire up the privacy/outbound record.
8. Map the provider model to an internal DTO.
9. Add an integration test that does not go out to the real network.
10. If there is a scheduler, add shutdown cleanup.
Good: `integrations/autodesk/client.ts` + `adapters.ts`. Bad: token refresh + fetch + DB + mapping inside a route.

### 27.8 Report extension
1. Update `packages/shared/src/reports/` if a contract is needed.
2. Add the server dataset to `apps/server/src/reports/datasets*.ts`.
3. Wire the template/render flow to `reports/templates*.ts` or the engine.
4. Publish the route through `reports/routes.ts`.
5. Add project scope and privacy checks.
6. Add the UI under `apps/web/src/features/reports/`.
7. Add a server `test/reports/` test and, if needed, a web test.
Bad: a report component knowing SQL field names.

### 27.9 Form extension
1. Assess the shared contract under `packages/shared/src/forms/`.
2. Add the DB field to `schema-forms.ts` and a migration.
3. Update the service under `apps/server/src/modules/forms/`.
4. Change the relevant route part under `modules/forms/routes/`.
5. Check the PDF impact in the `pdf-*` flows.
6. Add the UI under `apps/web/src/features/forms/`.
7. Add `apps/server/test/forms/` and web pure logic tests.
Bad: adding a new form field only to frontend state.

### 27.10 Workflow extension
1. Assess the pure contract/state rule under `packages/shared/src/workflow/`.
2. Add the server lifecycle decision under `apps/server/src/workflow/`.
3. Keep access in an explicit helper such as `review-access.ts`.
4. Set up the transaction in the review lifecycle/finalisation service.
5. Add the route to a `workflow/routes/` part.
6. Assess the reminder/notification impact.
7. Add the UI under the relevant `features/reviews` or domain feature.
8. Add allowed/denied/transition tests under `apps/server/test/workflow/`.
Bad: changing the status string with separate rules in the route and the frontend.

## 28. Architecture decisions and document maintenance
A short ADR should be written for a long-lived decision that is expensive to reverse. Examples that require an ADR:
- a new workspace; splitting out a microservice;
- a change to the auth model; DB/storage/queue technology;
- API versioning; the shared public export strategy;
- changing the viewer engine.
If an ADR location is created:

```text
docs/architecture/adr/
  0001-<decision>.md
```

An ADR contains:
- context; decision;
- alternatives; positive/negative consequences;
- status.
When this document is updated:
1. Paths are verified against the disk.
2. Package scripts are compared with `package.json`.
3. Old target/refactor language is removed.
4. Relative Markdown links are checked.
5. A conflicting feature document is updated or explicitly declared secondary.
6. Line count alone is not used as a measure of quality.
Related existing documents:
- [Documentation index](../README.md)
- [Backups](../onprem/backups.md)
- [Monitoring](../onprem/monitoring.md)
- [Forma sync](../features/FORMA_SYNC.md)
- [Privacy](../features/PRIVACY.md)
- [Sign in with Google](../features/GOOGLE_SIGN_IN.md)
- [Local Google sign-in](../onboarding/GOOGLE_SIGN_IN.md)
- [OpenCDE](../features/OPENCDE.md)
- [Developer MCP](../onboarding/DEVELOPER_MCP.md)
- [Viewers](../features/VIEWERS.md)

## 29. development-workflow.md — Git process
The binding source for the branch, commit, rebase, Pull Request, mandatory review and merge process:

Git commands are not repeated in this document. From an architecture perspective:
- an architectural change should be of reviewable scope; mechanical moves should be separated from behaviour changes where possible;
- the migration, security and compatibility impact must be described in the PR description.

## 30. Anti-pattern checklist
- [ ] New code under flat `src/routes`, `src/pages` or `src/components`.
- [ ] A component importing a page.
- [ ] A service importing a route.
- [ ] Shared importing app code.
- [ ] A CDE tool accessing the DB.
- [ ] A deep import into another package's `src/` path.
- [ ] An import cycle.
- [ ] A god route: validation + SQL + domain + provider.
- [ ] A god component: routing + fetch + viewer + every dialog.
- [ ] Raw `fetch` inside a component.
- [ ] A mandatory repository for every table.
- [ ] A missing `projectId` in a project query.
- [ ] Trusting a user/company ID from the client.
- [ ] Doing authorization only by hiding buttons.
- [ ] External HTTP/AI/SMTP inside a transaction.
- [ ] Long CPU work inside a request.
- [ ] An unbounded list endpoint.
- [ ] `as` instead of runtime validation.
- [ ] Uncontrolled `any`.
- [ ] Swallowing errors.
- [ ] Returning raw internal errors.
- [ ] Logging tokens/secrets/bodies.
- [ ] Using a user filename as a filesystem path.
- [ ] Registering a write tool in read-only MCP.
- [ ] Enabling a local tool in hosted MCP.
- [ ] Copying server state into several local states.
- [ ] Viewer/worker/object URL without cleanup.
- [ ] Skipping loading/error/empty states.
- [ ] Conveying state through colour alone.
- [ ] Importing the root barrel inside the package.
- [ ] Editing a generated file by hand as if it were source.
- [ ] Growing a 1000+ line file without justification.
- [ ] Using a production DB, tokens or customer data in tests.
- [ ] Keeping a historical migration plan as if it were a living architecture rule.

## 31. Final decision principle
Before writing new code, these questions must be answered:
1. Which domain owns this code?
2. Which layer should it run in?
3. In which direction may it import?
4. Where are project and token isolation enforced?
5. Where is external input validated?
6. Is a DB transaction needed?
7. Should the work be split out into a job/worker?
8. Is data leaving the system?
9. Which test proves the behaviour?
10. Should this document or a feature document be updated?
If the answer is not clear, the boundary is clarified before adding a new folder or abstraction. The best architecture is not the one with the most layers, but the one where:
- ownership is visible; wrong dependencies are hard;
- security is the default; the impact of a change is limited;
- testing is easy.
