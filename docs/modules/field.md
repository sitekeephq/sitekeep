# Field module

SiteKeep Field: form templates (including templates from PDF), forms, approval workflow and form PDFs.
Product description: SiteKeep editions and modules §2.
Feature document: [Form PDF](../features/FORM_PDF.md).

| | |
|---|---|
| Repository | [7Dimensions-Project/sitekeep-field](https://github.com/7Dimensions-Project/sitekeep-field) (private); local clone `~/Desktop/7dimensions/sitekeep-field` |
| Package | `@7dimensions-project/sitekeep-ee-field` (GitHub Packages) |
| Version in this repository | `0.3.2` (`apps/server/package.json`, `apps/web/package.json`) |
| SDK used | `@7dimensions-project/sitekeep-sdk` `>=0.11.0 <1.0.0` |
| ID | `field` (`SITEKEEP_MODULES`) |

Unlike Cost, the three steps were done in one go (the infrastructure was ready). The history before the move is in this
repository (`apps/server/src/modules/forms`, `apps/web/src/features/forms`).

## Boundary

Locations (location tree, location links) stay in the core: issues and files are also linked to locations.
A form's location is a `location_links` record in the core (`kind = "form"`).

The AI features (form template draft, workflow draft, PDF field naming) call Field's
routes over HTTP; the API contracts they share stay in the core:
`apps/server/src/contracts/forms.ts` (template, workflow and naming schemas; Field takes them from the SDK).

## What is in the package

| Location (in the repository) | Contents |
|---|---|
| `server/index.ts` | Module: migrations, routes, My Tasks source, `tables` for developer tools; registers the capabilities and the "forms" report dataset when loaded |
| `server/routes/`, `service.ts`, `flow.ts`, `library.ts` | Templates, forms, attachments, issues, workflow, template library |
| `server/pdf*.ts` | PDF field detection, writing to PDF, page layout (worker), PDF export |
| `server/capabilities.ts` | `field.forms`, `field.externalForms` |
| `server/schema-tables.ts` | `form_templates`, `form_pdf_sources`, `form_template_versions`, `forms`, `form_attachments`, `form_issue_links` |
| `web/` | Forms page, form filling, PDF template page, "+ New" form dialog, offline drafts |
| `migrations/0000_forms` | Own journal `drizzle.__drizzle_migrations_field`; idempotent, from the core's 0012, 0020, 0021 |

Still in the core: the web API client's form calls (`api.formTemplates`, `api.forms` …),
shared types (`packages/shared`), the contracts above. Strings are in the module (`locales/`).

## Where it connects to the core

| Core | How |
|---|---|
| Routes, My Tasks (form steps) | `ServerModule.routes`, `taskSources` |
| "Today": my draft forms; hub labels | `field.forms` (`drafts`, `list`, `link`) |
| Locations: linking a location to a form, labels | `field.forms` (`list`) |
| Reports: `forms` dataset | registered while the module loads |
| Reports: form label in workflow steps, form counts by location | `field.forms` (`list`) |
| Autodesk forms (Forma Sync) | `field.externalForms` (`upsert`); without Field, forms are skipped |
| Developer tools (demo data, reset, date shifting, scripts) | `ServerModule.tables` → `moduleTable("field", …)` |
| Menu, pages, the "Forms" view in Works, legacy addresses | `WebModule.projectNav`, `projectRoutes`; `HubView.webModule`, `LEGACY_URLS.module` |
| "+ New" → Form | `field.newFormDialog` |
| PDF fonts | SDK `pdfFontBytes()` |

## Tests

| Location | What |
|---|---|
| `sitekeep-field`: `npm test` | Boundary check, PDF field ID unit test (test copies instead of the SDK) |
| `apps/server/test/modules/field/` | Forms API, PDF templates, field detection, writing to PDF, workflow |
| Cross-cutting tests (AI, MCP, reports, hub, developer tools) | Form steps with `hasField` (`test/helpers/modules.ts`) |
| `e2e/specs/` | form scenarios |

## What stays in the core

No open work (10.11.2026). The following stay in the core on purpose or are shared with other modules:

- The form API client is in the package (`web/api.ts`, `formsApi`); the core's `api.ts` keeps only `formTemplates` for Works "+ New → Form". Form AI features are not listed and not queued while Field is not installed (AI module, `product`). Form helpers used only by Field (value validation, scoring, form number, template similarity, workflow rows) are in the package (`shared/forms.ts`, `shared/form-pdf.ts`); the form template and form DTOs are in the core because the core's form PDF, reports and AI parts also use them. Strings are in the module (`locales/`).
