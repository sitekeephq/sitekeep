# SiteKeep map: where things go

Start here before writing code or documentation. This page answers three questions and points to the
document that has the details:

1. Does this feature belong to **SiteKeep Community** (this repository, open source) or to an
   **Enterprise module** (a separate, closed repository)?
2. Where does the code go?
3. Which rules, tests and documents come with it?

If a change does not fit any row below, open an issue and ask before writing code.

## 1. Editions and repositories

| What | Where | Licence |
|---|---|---|
| **SiteKeep Community**: the core | This repository (`apps/`, `packages/`) | AGPL-3.0 |
| 3D viewer engine | `@7dimensions-project/bim-viewer` ([structure](architecture/structure.md#221-external-private-package-7dimensions-projectbim-viewer)) | AGPL-3.0 |
| Module SDK | `packages/sdk` | MIT |
| **SiteKeep Enterprise** modules: Cost, Field, Coordinate, Planning, AI, Manage, Connect | One closed repository per module (`sitekeep-<id>`), installed as `@7dimensions-project/sitekeep-ee-<id>` | Commercial |

Community must always build, run and pass its tests **without any module** installed. Enterprise is
Community plus one or more modules, unlocked by a licence.

## 2. Community or Enterprise?

Decide with these rules, in this order:

1. **Document control is Community.** Anything a team needs to run a project's information under
   ISO 19650 goes into the core: folders and permissions, versions, naming standards, metadata and
   suitability codes, review and approval workflows, CDE states (WIP / Shared / Published / Archived)
   and their gates, transmittals and correspondence, issues, version comparison, drawing sheets, markup,
   audit log. Community never lacks the core document-control features of comparable commercial CDEs.
2. **Open standards are Community.** IFC viewing, BCF, OpenCDE APIs, IDS checking.
3. **ISO 19650 requirements that are documents** (BEP, information requirements, delivery plans) are
   delivered as **project templates**, not as features. Templates are Community (`apps/server/templates`).
4. **Everything below is an Enterprise module.** A feature in one of these areas goes into that module:

| Area | Module |
|---|---|
| Contracts, progress payments (hakediş), quantity take-off (metraj), 2D take-off, 5D cost, Suggest Items | **Cost** |
| Form templates, forms, form approval, form PDFs | **Field** |
| Clash tests, parameter change | **Coordinate** |
| Schedules (P6, MS Project, Excel), schedule versions, 4D | **Planning** |
| AI providers, Ask the project, AI task queue, AI tools over MCP | **AI** |
| RFI, submittals, meetings, correspondence tools, Drop and save | **Manage** (the Works engine itself is core) |
| Autodesk Forma / ACC sync and import, Office editing in the browser (WOPI) | **Connect** (Office-to-PDF conversion is core) |

5. **A new area that is not in this table** is a product decision. Ask first.

Module details: [Modules](modules/README.md) and one page per module ([cost](modules/cost.md),
[field](modules/field.md), [coordinate](modules/coordinate.md), [planning](modules/planning.md),
[ai](modules/ai.md), [manage](modules/manage.md), [connect](modules/connect.md)).

## 3. Where the code goes

### Core (this repository)

| You are adding | Put it in | Read first |
|---|---|---|
| An API endpoint, service or job | `apps/server/src/<area>/` (`projects`, `files`, `workflow`, `works`, `coordination`, `bcf`, `opencde`, `reports`, `docintel`, `jobs` …) | [structure](architecture/structure.md) |
| A database table or column | `apps/server/src/db` schema + a migration in `apps/server/drizzle` | [structure](architecture/structure.md) |
| A screen or component | `apps/web/src/features/<area>/` (shared UI in `apps/web/src/shared`) | [structure](architecture/structure.md), [theme](product/THEME.md) |
| A rule, type or DTO used by both server and web | `packages/shared/src/<area>/` | [structure](architecture/structure.md) |
| An MCP tool | `packages/cde-tools/src/tools/` | [developer MCP](onboarding/DEVELOPER_MCP.md) |
| A project template (folders, naming, workflows) | `apps/server/templates/*.json` | [concept](product/CONCEPT.md) |
| A file viewer (PDF, DWG, Office) | `apps/web/src/viewers/`, server side in `apps/server/src/previews` | [viewers](features/VIEWERS.md) |
| Something a module must be able to use | the SDK: `apps/server/src/sdk`, `apps/web/src/sdk`, then `packages/sdk` | [module contract](modules/README.md#module-contract) |

### Enterprise module (its own repository)

| You are adding | Put it in | Read first |
|---|---|---|
| Server code, routes, tables | `server/` and `migrations/` of `sitekeep-<id>` | [module repository layout](modules/README.md) |
| Screens and menu entries | `web/` of `sitekeep-<id>` (`projectRoutes`, `projectNav`) | [module contract](modules/README.md#module-contract) |
| Something another module or the core may use | a **capability**; the user must hide the feature when no module provides it | [capabilities](modules/README.md#capabilities) |
| Something the module needs from the core that the SDK does not offer | a change to the SDK in this repository first, then the module | [adding to the SDK](modules/README.md#adding-to-the-sdk-and-releasing) |

## 4. Rules that come with every change

| Rule | Details | Enforced by |
|---|---|---|
| The core never imports module code; a module uses the core only through the SDK and never imports another module | [boundary rules](modules/README.md#boundary-rules) | `module-boundary.test.ts`, `sdk-shim.test.ts`, `check-boundary.mjs` in each module |
| Workspaces depend only in the allowed direction (`apps` → `packages`, never the other way; `packages/shared` stays free of server and browser code) | [dependency direction](architecture/structure.md#22-workspace-dependency-direction) | review, typecheck |
| User-facing text goes into the translation files, English and Turkish both | [i18n](architecture/i18n.md), [terminology](product/TERMINOLOGY.md) | i18n and UI-term tests |
| Logic gets unit tests, screens get end-to-end tests; a journey that needs a module is skipped without it (`needsModules`) | [tests](architecture/tests.md), [e2e](../e2e/README.md) | CI (full and Community) |
| Every outbound network call is declared and can be switched off | [privacy](features/PRIVACY.md) | privacy tests |
| Documentation is written in English and lives under `docs/` | [documentation index](README.md) | review |

## 5. Documentation map

| Topic | Document |
|---|---|
| Install and run | [Docker Compose](onprem/docker-compose.md), [installation package](onprem/installation-bundle.md), [backups](onprem/backups.md), [monitoring](onprem/monitoring.md), [capacity](onprem/capacity.md) |
| Architecture | [repository structure](architecture/structure.md), [modules](modules/README.md), [i18n](architecture/i18n.md), [tests](architecture/tests.md) |
| Product language | [concept](product/CONCEPT.md), [terminology](product/TERMINOLOGY.md), [simplification](product/SIMPLIFICATION.md), [theme](product/THEME.md), [brand](brand/README.md) |
| Features | [OpenCDE](features/OPENCDE.md), [BCF](features/BCF.md), [viewers](features/VIEWERS.md), [Works](features/WORKS.md), [correspondence](features/CORRESPONDENCE.md), [reports](features/REPORTS.md), [document comparison](features/DOCUMENT_COMPARISON.md), [privacy](features/PRIVACY.md), [office integration](features/OFFICE_INTEGRATION.md), [Google sign-in](features/GOOGLE_SIGN_IN.md), [AI providers](features/AI_PROVIDERS.md) |
| Enterprise features | [quantities](features/QUANTITIES.md), [quantity approval](features/QUANTITY_APPROVAL.md), [2D take-off](features/2D_TAKEOFF.md), [4D / 5D](features/4D_5D.md), [Suggest Items](features/POZ_SUGGEST.md), [form PDF](features/FORM_PDF.md), [parameter change](features/PARAMETER_CHANGE.md), [Forma sync](features/FORMA_SYNC.md) |
| Getting started | [demo data](onboarding/DEMO_DATA.md), [developer MCP](onboarding/DEVELOPER_MCP.md), [local Google sign-in](onboarding/GOOGLE_SIGN_IN.md), [contributing](../CONTRIBUTING.md) |
| Everything | [documentation index](README.md) |

