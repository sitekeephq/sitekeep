# Developer MCP: SiteKeep with Claude Code and Claude Desktop

Date: 11.10.2026 · Branch: `feat/dev-mcp`

Until the GPU server arrives, the local model is slow. So Claude Code or Claude Desktop connects to the local SiteKeep over MCP
with the user's own subscription. Claude becomes both the developer/tester and the "AI" that drafts reports, workflows and
templates. With Claude Desktop no API key is needed; the subscription is enough.

There are three parts:

1. **Developer tools** (`cde_dev_*`): health check, sample data, test project, sample files, scenarios, AI
   evaluation, date shifting. Only enabled on a development server.
2. **Claude as the AI** (`cde_report_save`, `cde_form_template_save`, `cde_form_flow_save`, `cde_work_draft`,
   `cde_workflow_template_save`, `cde_ai_schemas`): saves the things the application's own AI would draft. Also works in
   production (for customers connecting Claude, DeepSeek… over MCP).
3. **The "Run with My Own AI" queue** (`cde_ai_tasks_list`, `cde_ai_task_claim`, `cde_ai_task_complete`, `cde_ai_task_fail`):
   the AI buttons in the application hand the work to a connected client.

## 1. Start the server with the developer tools

Add this line to `apps/server/.env.development` (the file is not in git):

```
CDE_DEV_TOOLS=1
```

- When `NODE_ENV=production`, this setting is ignored. In production installations the developer tools are never registered.
- Restart the server: `npm run dev -w @sitekeep/server` (port 8787).
- Optional: `CDE_WEB_URL=http://localhost:5173`. Links in tool responses start with this address (this is also the default).

## 2. An access token with write permission

1. Under Administration → AI and MCP → **Connect Your Own AI**, tick "Allow Read + Write Access Tokens".
2. My Account → **API Access Tokens** → New Access Token. Scope: **Read + Write**. Name: e.g. "Claude Code (development)".
3. The token is shown once. Copy it; do not paste it into the repo or a chat.

The developer tools only work with a **system administrator's** write token. The other tools work with the token owner's own
permissions.

## 3. Claude Code

`.mcp.json` is ready in the repo root:

```json
{
  "mcpServers": {
    "sitekeep": {
      "type": "http",
      "url": "${CDE_MCP_URL:-http://localhost:8787/mcp}",
      "headers": { "Authorization": "Bearer ${CDE_MCP_TOKEN}" }
    }
  }
}
```

Make the token a persistent environment variable on Windows (PowerShell):

```powershell
setx CDE_MCP_TOKEN "7dcde_api_..."
# if the token is in a file:
setx CDE_MCP_TOKEN (Get-Content "$env:USERPROFILE\.sitekeep\mcp-token.txt" -Raw).Trim()
```

- `setx` applies to newly opened windows. Open a new terminal.
- Open a new Claude Code session in the `C:\path\to\sitekeep` folder. Claude Code asks you to approve the project server the first time.
- The `/mcp` command shows the connection. If the variable is not defined, a warning appears and requests get 401.
- For another address: `setx CDE_MCP_URL "https://cde.company.local/mcp"`.

## 4. Claude Desktop

Claude Desktop's remote connectors (custom connectors) connect from the Anthropic cloud; they cannot reach `localhost`. So
the CDE's own stdio server `apps/mcp` is used. It offers the same tool set (`packages/cde-tools`) and also includes local file
upload/download tools.

1. Build once: `npm run build` (in the repo root).
2. Settings → Developer → Edit Config. File: `%APPDATA%\Claude\claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "sitekeep": {
      "command": "node",
      "args": ["C:\\path\\to\\sitekeep\\apps\\mcp\\dist\\index.js"],
      "env": {
        "CDE_URL": "http://127.0.0.1:8787",
        "CDE_TOKEN": "7dcde_api_...",
        "CDE_DEV_TOOLS": "1"
      }
    }
  }
}
```

- `CDE_DEV_TOOLS=1` adds the developer tools to the stdio server. The server side still does its own check.
- Quit Claude Desktop completely and reopen it. Log: `%APPDATA%\Claude\logs\mcp-server-sitekeep.log`.
- `CDE_READ_ONLY=1` for read-only.

## 5. Tools

### Developer tools (only with `CDE_DEV_TOOLS=1`, system administrator's write token)

| Tool | What it does |
|---|---|
| `cde_dev_health` | Version, git commit, migration status, database type, converters (office/DWG), AI provider and mode, MCP settings, job queue, recent server errors (keys are masked), row count per table. |
| `cde_dev_seed` | Realistic sample data in a test project: incoming/outgoing letters (reference chain, replies), RFIs (ball in court), submittal items and packages (revisions, outcomes), meetings (agenda, attendees, actions), transmittals, issues, reviews (including overdue ones), forms with failed items, a schedule with a baseline, clashes if there is a model. Dates are spread into the past. The same label is generated once; `action: "remove"` deletes it. |
| `cde_dev_project` | Test project from a template (demo companies with short codes and members), adding members, resetting and archiving the project (with confirmation). |
| `cde_dev_upload` | A generated sample file (PDF drawing sheet with title block, PDF form, DOCX, XLSX, PPTX, DXF, small IFC), a test file or an explicitly given path; new version with `newVersionOf`. |
| `cde_dev_scenario` | End-to-end scenarios, step-by-step pass/fail, duration and link. |
| `cde_dev_ai_eval` | The application's own AI features with fixed Turkish prompts: valid JSON, schema errors, duration, tokens. `mode: "dry"` only returns the prompts. |
| `cde_dev_ai_check` | Runs a candidate answer through the application's same validation. |
| `cde_dev_time` | Shifts the dates of sample records: "make 30% of them overdue" (`overdueRatio`) or `shiftDays`. With confirmation. |

Scenarios: `yazisma-dongusu`, `bilgi-talebi`, `teknik-onay`, `toplanti`, `inceleme`, `form-pdf`, `rapor`,
`karsilastirma`, `gorunum` (the 15 persona tasks in docs/product/SIMPLIFICATION.md).

### Claude as the AI (write token; permission checks are the application's own)

| Tool | What it does |
|---|---|
| `cde_ai_schemas` | JSON schemas and short instructions of the application's own AI prompts (report, form fields, workflow, model query, translation…). |
| `cde_report_save` | A report dashboard from `{name, description, queries, html}`. Queries are checked against the datasets; private dashboard by default. |
| `cde_form_template_save` | Form template from field JSON; optional PDF source and field boxes. Project manager. |
| `cde_form_flow_save` | Workflow: a draft in the local model's answer format (names are matched to the project; unknown roles come back with suggestions) or a full workflow. |
| `cde_work_draft` | A draft work from the open types: with letter data and links. Sends nothing. |
| `cde_workflow_template_save` | Workflow template. |

## 6. Example prompts

- "PKF-DEMO'ya 50 yazışma ve 20 bilgi talebi üret, %30'u gecikmiş olsun." (Generate 50 correspondence items and 20 RFIs in PKF-DEMO, with 30% overdue.)
  (`cde_dev_seed`: `incomingLetters: 25, outgoingLetters: 25, rfis: 20, overdueRatio: 0.3`)
- "Tüm senaryoları çalıştır ve kalanları göster." (Run all scenarios and show the failures.)
- "Sağlık kontrolü yap; son sunucu hatalarını özetle." (Run a health check; summarise the recent server errors.)
- "Yazışma raporu taslağı hazırla ve kaydet." (Draft and save a correspondence report.) (`cde_report_datasets` → `cde_report_save`)
- "Şu akış tarifinden form akışı kaydet: Formu şantiye şefi doldurur, kalite kontrol mühendisi kontrol eder; ret olursa geri döner." (Save a form workflow from this description: the site manager fills in the form, the quality control engineer checks it; if rejected, it goes back.)
- "Yerel modelle yapay zekâ değerlendirmesini çalıştır, qwen3-8b-16k ile karşılaştır." (Run the AI evaluation with the local model and compare with qwen3-8b-16k.)
- "Değerlendirme istemlerini dry modda ver, sen cevapla ve cde_dev_ai_check ile denetle." (Give the evaluation prompts in dry mode, answer them yourself and check with cde_dev_ai_check.)
- "Bekleyen SiteKeep görevlerini yap." (Do the pending SiteKeep tasks.)

## 7. The "Run with My Own AI" queue

The AI buttons in the application can hand the work to a connected client (Claude Desktop, Claude Code, ChatGPT, Gemini CLI, Cursor…).
The queue is independent of the client; the name of the access token that picks up the work (e.g. "Claude Code") is shown on the task.
Client recipes and providers (DeepSeek, OpenAI, Gemini…): [docs/features/AI_PROVIDERS.md](../features/AI_PROVIDERS.md).

Flow:

1. Instead of (or next to) "Create with AI", the user clicks **Run with My Own AI**. The screen shows "pending".
2. Tell the client "do the pending SiteKeep tasks". The client calls `cde_ai_tasks_list` → `cde_ai_task_claim`.
   The claim returns the **full prompt** that would go to the application's own model, the JSON schema of the answer and helper read tools.
3. The client sends the answer with `cde_ai_task_complete`. The answer goes through the application's own AI path **as the requesting
   user**: the same schema, the same repair check, the same processing. Errors go back to the client; the client fixes them and sends again.
4. A valid result is applied with the requester's permissions. A report is saved as the requester's **private dashboard**. Workflow, translation, template,
   naming and action suggestions open on screen as drafts; the user confirms.
5. The screen checks every 5 seconds and opens the result. The user can cancel at any time. The "Ask" panel inside the project has
   a **Pending AI Tasks** list.

Rules:

- The person who claims the task must be a **member** of the project and use an API token with write permission.
- Tasks contain no secrets (only the request and record IDs). They expire after 24 hours (configurable).
- Claim, completion and rejection are written to the audit log (`ai_task.*`).
- A connected client is an **external AI**. For the queue, AI mode must not be off and one of these is required: the mode "Allow
  External Providers" plus project permission, or the administrator's **Allow External AI Clients** switch.
- Settings: Administration → AI and MCP → **Connect Your Own AI** → "Task Queue On" and "Allow External AI Clients".

To run continuously with Claude Code, use `/loop` (the prompt below is Turkish for "do the pending SiteKeep tasks"):

```
/loop 5m bekleyen SiteKeep görevlerini yap
```

## 8. Scenarios without MCP

```
npm run scenarios                     # new in-memory database, all scenarios
npm run scenarios -- rapor inceleme   # only these
```

Against a running development server: the same command with `CDE_URL=http://127.0.0.1:8787` and `CDE_MCP_TOKEN` set.
If a scenario fails, the exit code is 1 (for CI).

## 9. Security

- The developer tools do not work when `NODE_ENV=production` or when `CDE_DEV_TOOLS` is missing; they do not appear in the tool list either.
- Only a system administrator's write token can use them. Read tokens and browser sessions are rejected.
- Destructive tools (reset, archive, deleting sample data, date shifting) only work in **test/demo projects** and with `confirm: true`.
  Test project: a project whose code ends with `-DEMO` or `-TEST`, or one created by the developer tools.
- Sample data is only written to test/demo projects. Records are kept in the `dev.registry` entry in `system_settings`; works
  also carry the `data.devSeed` tag.
- Every developer tool call is written to the audit log as `dev.tool`, every MCP call as `mcp.tool`.
- No tool sends email or KEP (Turkish registered email), or connects to an external address. Sample letters are recorded with the "by hand" or "within the CDE" channel.
- Access tokens are masked in the server logs.

## 10. Limitations

- `cde_dev_project action: "set_modules"` turns the project's module switches on and off. Because the write tools work over REST,
  writing to a disabled module follows the server policy.
- Backdating only shifts timestamps; the year in numbers (`{YYYY}`) is the year at creation time.
- Delays in review and form steps are produced by moving the step due date (`step_due_at`) back.
- The path given to `cde_dev_upload` is read on the server machine (for local development).
- For "Ask" tasks in the queue, the answer is written from the information the client found with its MCP tools; there are no application source labels.
