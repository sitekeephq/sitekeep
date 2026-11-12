# AI Providers and "Connect Your Own AI"

Date: 11.10.2026 · Sources were read from the providers' official documentation on 11.10.2026 (see below).

SiteKeep is not tied to a single provider. The Administration → AI and MCP screen has three options; they can be used together.
The AI buttons in the application work in this order: **local model → cloud model → "Run with My Own AI"** (fallback).

## 1. Presets

Model IDs are only defaults; they can be edited. Prices are not stored; only relative cost is shown.

| Preset | Type | Address | Default / strong model | Tools | JSON mode | Data | Cost |
|---|---|---|---|---|---|---|---|
| Ollama | local | `http://127.0.0.1:11434/v1` | qwen3:8b / qwen3:14b, deepseek-r1:8b | yes | yes | This server or a GPU server on the network | low |
| vLLM | local | `http://127.0.0.1:8000/v1` | Qwen/Qwen3-8B | yes* | yes | Internal network | low |
| LM Studio | local | `http://127.0.0.1:1234/v1` | (loaded model) | yes | no | This computer | low |
| **DeepSeek** | cloud | `https://api.deepseek.com` | deepseek-flash / deepseek-v4-pro | yes | yes | **People's Republic of China** | low |
| OpenAI | cloud | `https://api.openai.com/v1` | gpt-5.4-mini / gpt-5.5 | yes | yes | USA (EU etc. for projects with data residency enabled) | medium |
| Google Gemini | cloud | `https://generativelanguage.googleapis.com/v1beta/openai` | gemini-3.5-flash-lite / gemini-3.8-flash | no** | yes | Google global | low |
| Anthropic Claude | cloud | `https://api.anthropic.com` | claude-haiku-5-5 / claude-sonnet-5-5 / claude-opus-5-5 | yes | no (via prompt) | Global / optional USA | high |
| Mistral | cloud | `https://api.eu.mistral.ai/v1` | mistral-small-latest / mistral-medium-latest | yes | yes | EU/EFTA | medium |
| Groq | cloud | `https://api.groq.com/openai/v1` | openai/gpt-oss-20b / openai/gpt-oss-120b | yes | yes | USA | low |
| OpenRouter | cloud | `https://openrouter.ai/api/v1` | provider/model | yes | yes | The provider of the chosen model | medium |
| Azure OpenAI | cloud | `https://RESOURCE.openai.azure.com/openai/v1` | deployment name | yes | yes | The chosen Azure region | medium |

\* In vLLM, for tool calling the server is started with `--enable-auto-tool-choice --tool-call-parser …`.
\*\* Gemini 3 tool calls require `thought_signature` to be sent back; with this preset the "Ask" assistant runs in tool-less
(routing) mode. Other features do not use tools.

### KVKK (Turkish personal data protection law)

- Cloud providers process project content on servers outside Türkiye (KVKK art. 9: transfer abroad). Explicit consent or
  a suitable legal basis for the transfer is required. Cloud models only run when the mode is "Allow External Providers" and the project allows it.
- **DeepSeek cloud API**: according to its privacy policy, data is collected, processed and stored in the People's Republic of China.
  Use it only for demos or non-sensitive projects. The KVKK-safe option is to run DeepSeek or Qwen open-weight
  models **locally with Ollama** (e.g. `deepseek-r1:8b`, `qwen3:14b`). Note: the `deepseek-v4…:cloud` tags in Ollama
  do not run locally but in the Ollama cloud.
- With Gemini's free quota, prompts may be used for product development; use the paid quota.

## 2. Compatibility layer (apps/server/src/ai/provider.ts)

- **Capability flags** (tools, JSON mode, vision, context) come from the preset; custom endpoints get conservative defaults (tools yes, JSON mode no).
- **JSON mode**: features that expect JSON (report, form template, workflow, field naming, Ask the Model, action suggestion, RFI
  draft, translation) request `response_format: json_object`. For providers that do not support it, only the prompt + extraction is used; if the endpoint
  rejects `response_format`, the request is retried once without it.
- **Reasoning**: the `reasoning_content` / `reasoning` fields are never read; `<think>…</think>` blocks are always removed.
  "Turn Off Thinking Mode" is sent per provider (DeepSeek and OpenAI `reasoning_effort: "none"`, Groq `include_reasoning: false`,
  Ollama `reasoning_effort: "none"` + ` /no_think`).
- **Token parameter**: OpenAI and Azure `max_completion_tokens`, the others `max_tokens`.
- **429**: two retries honouring `Retry-After` / `retry-after-ms`; otherwise after 1 s, 2 s. Then a clear localised error.
- **Token count in streaming**: `stream_options.include_usage` where supported.
- **Tool-less provider**: the "Ask" assistant switches to routing mode; the selected tools that take no arguments run first, and the model answers
  from that data in a single call.
- `cde_dev_ai_eval` with `providers: ["DeepSeek", "Ollama (yerel)"]` (or `["all"]`) runs the same prompt set on several providers;
  it compares validity, time, tokens and (only with the `prices` you provide) estimated cost.

## 3. The user's own Claude or Cursor API key

Every project member can save their own Anthropic Claude or Cursor
API key under **Project Settings → AI → My Own API Keys**. Then, in the provider list on the **Ask** and **Ask the Model** screens, they choose the project provider,
personal Claude or personal Cursor. The choice applies only to new chats/queries; other users'
keys and usage quotas are not shared.

- Keys are stored per user in the `user_ai_credentials` table and encrypted with **AES-256-GCM** using `CDE_SECRET_KEY`.
  The API and the interface only return `hasApiKey`; the key is never shown again.
- Before saving, a small validation call without content is made to the provider. A failing key is not saved, and an existing
  working key is not replaced.
- Keys are not hashed: a secret that must be sent to the provider again cannot be recovered from a hash.
- A user can only add, change, test or delete their own key; not even a system administrator can read another user's
  plaintext key.
- Personal providers only run if the system mode is `allow_external`, the project AI setting is on and the project allows external providers.
  The Privacy Centre's external connections kill switch also stops all personal calls.
- Claude calls go through the Anthropic Messages API. Cursor calls run with the official `@cursor/sdk`, without tools and in a temporary
  workspace; project searches are prepared in the CDE's permission-checked routing layer.
- Prompts, answers or API keys are not written to the audit log. Provider, model, duration and connection metrics without content
  are added to the external connections log.

## 4. Connect your own AI (MCP clients)

The CDE's MCP endpoint: `https://cde.company.local/mcp` (Streamable HTTP), header `Authorization: Bearer <access token>`.
Local stdio server: `node C:\path\7d-cde\apps\mcp\dist\index.js` (environment: `CDE_URL`, `CDE_TOKEN`).

| Client | How | localhost | Note |
|---|---|---|---|
| Claude Code | `.mcp.json`: `{"type":"http","url":…,"headers":{"Authorization":"Bearer ${CDE_MCP_TOKEN}"}}` | yes | Details: docs/onboarding/DEVELOPER_MCP.md |
| Claude Desktop | stdio (`command`/`args`/`env`) in `%APPDATA%\Claude\claude_desktop_config.json` | via stdio | Remote connectors connect from the Anthropic cloud; they cannot reach localhost |
| ChatGPT | Settings → Apps → Developer mode → custom MCP server | no | Needs a public HTTPS address (the customer's reverse proxy) or the OpenAI Secure MCP Tunnel. **It cannot send a fixed Bearer header**: OAuth or a network-restricted unauthenticated connection is required |
| Gemini CLI | `~/.gemini/settings.json`: `"mcpServers": {"cde": {"httpUrl": …, "headers": {"Authorization": "Bearer ${CDE_TOKEN}"}}}` | yes | `url` means SSE; use `httpUrl` |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json`: `{"url": …, "headers": {"Authorization": "Bearer ${env:CDE_TOKEN}"}}` | yes | |
| VS Code (Copilot agent) | `.vscode/mcp.json`: `"servers": {"cde": {"type": "http", "url": …, "headers": {"Authorization": "Bearer ${input:cde-token}"}}}` | yes | `${env:…}` in headers is not reliable; use `${input:…}` |
| Cline | MCP Servers → Configure: `{"type": "streamableHttp", "url": …, "headers": {…}}` | yes | A DeepSeek API key can be chosen as the model |
| Continue | `config.yaml` → `mcpServers` (`type: streamable-http`, `requestOptions.headers`) | yes | Agent mode only; `provider: deepseek` exists. Test header support |
| Open WebUI | Admin → Integrations → External Tool Servers → "MCP (Streamable HTTP)", auth: Bearer | if the backend can reach it | `mcpo` bridge for stdio; DeepSeek (`https://api.deepseek.com/v1`) or Ollama as the model |
| LibreChat | `librechat.yaml` → `mcpServers.cde: {type: streamable-http, url, headers}` | with `mcpSettings.allowedAddresses` | DeepSeek/Ollama via `endpoints.custom` |

### "Run with My Own AI" works with every client

The queue is independent of the client. The name of the access token that picks up the task (e.g. "Claude Code", "Cursor") is shown on screen. Tell the client
"do the pending SiteKeep tasks"; the client calls `cde_ai_tasks_list` → `cde_ai_task_claim` → `cde_ai_task_complete`.
Details and security rules: docs/onboarding/DEVELOPER_MCP.md, section 7.

## 5. Local subscription connector

`7d-cde-ai` processes the task queue on the user's own computer without using the company OpenRouter key:

- **Cursor:** the official `@cursor/sdk` connects to the user's Cursor account through browser sign-in. No key is copied manually;
  the SDK keeps the short-lived user key in its own secure local store.
- **Claude:** uses the official Claude Code session on the computer. Run `claude auth login` first; the CDE receives no Claude
  session data or API key.

Prerequisites:

1. Under Administration → AI and MCP → Connect Your Own AI, enable the task queue, external clients and write tokens.
2. Under My Account → API Access Tokens, the user creates a **write** token limited to the projects they are a member of.
3. The repo is built once: `npm run build -w @sitekeep/mcp`.

With Cursor:

```bash
npm run connector -w @sitekeep/mcp -- login cursor
CDE_URL=https://cde.example.com \
CDE_TOKEN='<CDE write token>' \
npm run connector -w @sitekeep/mcp -- run --runtime cursor
```

With a Claude subscription:

```bash
claude auth login
CDE_URL=https://cde.example.com \
CDE_TOKEN='<CDE write token>' \
npm run connector -w @sitekeep/mcp -- run --runtime claude
```

`--once` processes only the first task; a continuously running connector checks the queue every 5 seconds by default.
The model only sees read-only CDE MCP tools. Claiming/completing tasks, result validation, user permissions and the audit
log stay on the CDE server. Cursor/Claude subscription terms and quotas are enforced by the respective provider.

## 6. Ask the Model and change summary

**Ask the Model** in the model viewer turns the natural-language question into a validated query JSON; counts, lists, quantity take-off (metraj) and
storey/type groups are computed on the server from the model index. Result elements can be highlighted, isolated, saved as a report
dashboard or turned into an issue with at most 5000 elements. The **Change Summary** in version comparison
groups added, deleted and changed elements by storey, class and property; "Ask About the Changes"
searches only these elements. The comparison summary also opens as a printable report.

How it works and security:

1. The model index contains class, storey, type, material, property sets and basic Qto quantities.
2. Keyword rules give a quick result first; if a provider is on, the model turns the same question into a query JSON.
3. Only the model vocabulary (field and class names, a few sample values and counts) goes to the provider, not the element list.
4. The model does not run code and does not produce result numbers. The JSON is validated; if invalid, the rule-based result is kept.
   If the change narrative produces a number not present in the input, that item is dropped.
5. Every request runs with the user's folder permissions and the administrator/project external provider policy. If AI is off,
   keywords and the filter builder still work.
6. The result for the same model and question is cached in memory; the cache is cleared when the server restarts.

The query fields are `classes`, `storeys`, `filters`, `groupBy`, `aggregate` and, in comparison, `change`.
Filter operators are `=`, `!=`, `contains`, `>`, `<`, `>=`, `<=`, `exists`, `missing`; fields are `class`, `storey`, `type`,
`name`, `material` or property names such as `FireRating` / `Pset_DoorCommon.FireRating`. An `IfcWall` filter
also covers `IfcWallStandardCase` elements; `!=` also returns elements that do not have the property.

API:

- `GET /projects/:pid/versions/:vid/model-vocab`
- `POST /projects/:pid/versions/:vid/model-query` — `{query, compareFrom?}`, without AI
- `POST /projects/:pid/versions/:vid/model-ask` — `{question, compareFrom?, mode: "auto" | "rules"}`
- `POST /projects/:pid/versions/:vid/model-query/report-draft`
- `GET /projects/:pid/compare?from&to`
- `POST /projects/:pid/compare/summary` — `{from, to, ai}`
- `GET /projects/:pid/compare/report?from&to`

Read-only API tokens can use the query, question and summary endpoints. The MCP equivalents are `cde_model_query`,
`cde_model_compare_summary` and, for quantities, `cde_quantity_inventory` ([QUANTITIES.md](QUANTITIES.md)); the report dataset uses the name `model_elements` (`fileId` and `modelQuery` filters).

Limitations: old indexes may be rebuilt on the first query (409); there is no grid axis information and no unit conversion; property
values are truncated at 200 characters. Lists have at most 2000 elements, highlighting 20,000. Geometry differences are not measured separately;
placement changes are distinguished. "2. kat" (2nd floor) is matched first to the number in the storey name, otherwise by order from the ground. With a local CPU
model the first question may take 30–60 seconds; the quick result and filters can be used meanwhile.

## Sources

- DeepSeek: https://api-docs.deepseek.com/ · /guides/thinking_mode · /guides/json_mode · /updates · privacy: https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html
- OpenAI: https://developers.openai.com/api/docs/models · /guides/your-data
- Gemini: https://ai.google.dev/gemini-api/docs/openai · /docs/thinking · /docs/generate-content/thought-signatures · /terms
- Anthropic: https://platform.claude.com/docs/en/api/messages · /build-with-claude/thinking · /manage-claude/data-residency
- Mistral: https://docs.mistral.ai/models · /inference/regional-inference
- Groq: https://console.groq.com/docs/openai · /docs/reasoning · /docs/your-data
- OpenRouter: https://openrouter.ai/docs/quickstart · /docs/guides/best-practices/reasoning-tokens
- Azure OpenAI: https://learn.microsoft.com/azure/foundry/openai/reference · /api-version-lifecycle
- Ollama: https://docs.ollama.com/api/openai-compatibility · vLLM: https://docs.vllm.ai/en/latest/features/tool_calling/ · LM Studio: https://lmstudio.ai/docs/developer/openai-compat
- MCP clients: https://code.claude.com/docs/en/mcp · https://support.claude.com/en/articles/11175166 · https://developers.openai.com/plugins/build/auth ·
  https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md · https://cursor.com/docs/context/mcp ·
  https://code.visualstudio.com/docs/copilot/reference/mcp-configuration · https://docs.cline.bot/mcp/configuring-mcp-servers ·
  https://docs.continue.dev/customize/deep-dives/mcp · https://docs.openwebui.com/features/extensibility/mcp ·
  https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_servers

Not verified: the name of the reasoning field on Ollama's `/v1` endpoint, LM Studio `json_object` support, the `api-key`
header on the Azure v1 endpoint, the Mistral Large 4 ID. These should be tested in the field.
