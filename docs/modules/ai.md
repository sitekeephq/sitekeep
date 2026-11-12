# AI module

SiteKeep AI: language model clients (local and cloud providers, personal Claude / Cursor keys),
"Ask the project", the AI task queue ("Send to AI"), the AI feature catalogue, the MCP
endpoint (`/mcp`) and the developer's AI evaluation. Product description:
SiteKeep editions and modules §2, §3.2.

| | |
|---|---|
| Repository | [7Dimensions-Project/sitekeep-ai](https://github.com/7Dimensions-Project/sitekeep-ai) (private); local clone `~/Desktop/7dimensions/sitekeep-ai` |
| Package | `@7dimensions-project/sitekeep-ee-ai` (GitHub Packages) |
| Version in this repository | `0.4.0` (`apps/server/package.json`, `apps/web/package.json`) |
| SDK used | `@7dimensions-project/sitekeep-sdk` `>=0.12.0 <1.0.0` |
| ID | `ai` (`SITEKEEP_MODULES`) |

The history before the move is in this repository (`apps/server/src/ai`, `apps/server/src/integrations/mcp`,
`apps/server/src/dev/ai-eval.ts`, `apps/web/src/features/ai`, `AdminAi.tsx`, `ProjectAi.tsx`).

## Boundary: the core's model gate

The core has features that use the model: Ask the Model, document comparison summary, name suggestion
from a drawing sheet (pafta), Today's Summary, report draft, RFI / meeting / translation drafts, Suggest Items, form and
parameter plan drafts. They request the model **through the core's gate**
(`apps/server/src/ai/provider.ts`: `resolveProvider`, `resolveProviderSetup`, `resolveSelectedProvider`).
The gate gets the actual client from the `ai.provider` capability; if AI is not installed, every call returns
`403 ai_off` ("Yapay zekâ sistem yöneticisi tarafından kapatıldı.", "AI has been turned off by the system administrator."). In this
case the features already fall back to the rule-based result or hide the button; Community has no code that calls an external model.

What stays in the core and why:

| Core | Why |
|---|---|
| `ai/provider.ts` | The gate: types (`AiProvider`, `ChatMessage` …), a single `AiError` class (`instanceof`), `stripThinking` |
| `ai/settings.ts` | General settings store (`system_settings`), AI mode and provider list, project AI policy; read by the Privacy Centre |
| `ai/hosts.ts` | Internal network / external address rule; used by the outbound connection log (`privacy/outbound`) |
| `ai/override.ts` | A provider that replaces the model for one request (task queue answer, evaluation) |
| `core/platform/ask-bridge.ts` | In-request identity bridge; also used by developer tools |
| `admin/settings.ts` | `GET /admin/settings`, `PUT /admin/settings/mcp`: **API access key policy** (who creates keys, write keys, expiry). API keys are also needed for REST and OpenCDE |
| `@sitekeep/cde-tools` | Tool definitions; the MCP server is in the module, the catalogue is provided by the SDK. The catalogue only offers tools of installed modules (`TOOL_MODULES`, `core/platform/cde-tools.ts`); the local stdio server (`apps/mcp`) learns the installed modules from `GET /api/v1/modules` |
| Ask the Model (`model/`), document comparison and drawing sheet reading | The rule-based parts belong to Community (FP-1, FP-2); the AI part goes through the gate |

When AI is not installed, the "AI and MCP" tab in Administration, the "AI" tab in project settings,
the "Ask" button, the "Send to AI" buttons and the MCP connection examples on the account page are hidden.
In this case the API key policy sits on a separate card in the Administration → OAuth Applications tab.

## What is in the package

| Location (in the repository) | Contents |
|---|---|
| `server/index.ts` | Module: migrations, routes, `rootRoutes` (MCP), `devTools` (`cde_dev_ai_eval`, `cde_dev_ai_check`), `tables`; provides the `ai.provider` and `ai.tasks` capabilities when loaded |
| `server/provider.ts` | OpenAI-compatible and Anthropic clients, privacy masking, provider selection |
| `server/personal.ts` | Personal Claude / Cursor keys |
| `server/ask-*.ts`, `run-ask.ts`, `assistant.ts` | "Ask the project" |
| `server/tasks.ts`, `features.ts` | Task queue and AI feature catalogue (schemas from the core, via the SDK) |
| `server/routes/` | `/admin/settings/ai`, `/admin/ai/providers`, `/me/ai-credentials`, `/projects/:pid/ai`, `/ask`, `/ai-tasks`, `/ai/schemas` |
| `server/mcp/routes.ts` | `/mcp` (Streamable HTTP) |
| `server/schema-tables.ts` | `ai_tasks`, `user_ai_credentials` |
| `web/` | Ask panel, task button and list, Administration "AI and MCP", project "AI" settings |
| `migrations/0000_ai` | Own journal `drizzle.__drizzle_migrations_ai`; idempotent, from the core's 0023, 0036, 0039 |

## Where it connects to the core

| Core | How |
|---|---|
| Every feature that needs a model | `ai.provider` (the gate); otherwise `ai_off` |
| Today: open "Today's Summary" task | `ai.tasks` |
| Endpoint outside `/api/v1` (`/mcp`) | `ServerModule.rootRoutes` (new) |
| Developer tools | `ServerModule.devTools` (new); dev helpers in the SDK's "Developer tools" section |
| Ask panel, task button, admin and project AI settings | web `ai.ui`; the core's `shared/ai/AiTaskButton` wrapper (no button if missing) |

## Tests

| Location | What |
|---|---|
| `sitekeep-ai`: `npm test` | Boundary check, AI option selection (`ai-options`) |
| `apps/server/test/modules/ai/` | Providers, MCP, task queue, Ask |
| Cross-cutting tests | Steps that set up a model run with `hasAi`; in an install without AI, `ai_off` and developer tools over REST are tested |
| `apps/web/test/ai/ai-tasks.test.ts` | The task queue client in the core |

## What stays in the core

No open work (10.11.2026). The following stay in the core on purpose or are shared with other modules:

- DTOs (`AiProviderDto`, `AskJob` …) are in the core; the core's settings screen also uses the provider presets. The package contains only `isIntakeKind` (`shared/record-intake.ts`). Strings are in the module (`locales/`); the `ai` keys used by the core's model gate (e.g. `ai_off`) are in the core.
- Model output schemas (`actionsSchema`, `rfiSchema`, `intakeAiSchema`, `flowOutputSchema`, `paramPlanSchema` …) are in the core's `apps/server/src/contracts/` folder; they are shared because AI as well as Manage / Field / Coordinate use them, and they are taken from the SDK (modules do not import each other).
- If a feature's route lives in another module (`FeatureDef.product`: form → Field; meeting actions, RFI draft, Drop and save → Manage; parameter change → Coordinate), then while that module is not installed the feature is not listed in `cde_ai_schemas` and its task is rejected with `404 feature_not_installed` (SDK 0.12.0 `moduleInstalled`).
