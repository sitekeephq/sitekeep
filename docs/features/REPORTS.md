# Reports: a dashboard for every module, live refresh

Date: 10.10.2026 · Code: `apps/server/src/reports/`, `apps/web/src/features/reports/pages/Reports.tsx`,
`apps/web/src/features/reports/pages/ReportView.tsx`, `apps/web/src/features/reports/components/ReportFrame.tsx`, `packages/cde-tools/src/tools/report.ts`

The user's question: *"The AI should be able to produce reports for each module; saved report formats should refresh
as the data is updated."* This document describes how both needs are met, the limits and the measurements.

## 1. Summary

- **Every module has a dataset.** The AI and the ready-made templates do not access data with SQL but through named
  **datasets** with localised labels. A dataset is loaded on every query **with the permissions of the person querying** (the visibility rule
  of the module's own list is used unchanged). New: works, correspondence, RFIs, submittals, meetings,
  actions, transmittals, reviews, review files, workflow steps, forms, locations, schedule activities,
  clashes, document comparisons, specification submittal registers (16 new; 23 in total).
- **Ready-made templates per module.** The "New dashboard → From Template" screen groups the templates by module. Templates do not need
  AI.
- **Every module page has a "Report" button**: it opens the report builder limited to that module (without AI it shows the module's
  templates).
- **A small prompt for the AI.** Depending on the request, only the datasets needed (at most 4) and a single sample template of that module
  are sent.
- **Saved dashboards are always current.** Each time a dashboard opens, it runs its queries against the data of that moment (with the latest versions of files,
  schedules and models); if the data changes while the dashboard is **open**, it refreshes itself.
- **If a saved query breaks** (a field was renamed / removed), a clear localised message appears in the affected section; the dashboard
  owner can have that query fixed with **"Repair with AI"**.
- **MCP and Ask:** `cde_report_datasets`, `cde_reports_list`, `cde_report_run`; Ask answers the request "Yazışma raporunu göster"
  ("show the correspondence report") with `cde_report_run`.

## 2. Modules → datasets → templates

| Module (Report button) | Datasets | Ready-made templates |
|---|---|---|
| Documents | `files`, `versions` | Document Upload Activity (weekly) |
| Issues | `issues` | Issue Status (company and priority), Overdue Items |
| All Work | `works` | Open Work (ball in court) |
| Correspondence | `correspondence` | Correspondence Status (awaiting reply, overdue, by company, monthly incoming/outgoing) |
| RFIs | `rfis` | RFIs (ball in court, days open, discipline, average response time) |
| Submittals | `submittals` | Submittal Register (outcome breakdown, revision count, by type, overdue) |
| Meetings and Actions | `meetings`, `actions` | Meetings and Actions (open actions, responsible company, monthly meetings) |
| Transmittals | `transmittals` | (with AI) |
| Reviews | `reviews`, `review_files`, `workflow_steps` | Reviews (step durations, delays, waiting time by company) |
| Forms | `forms` | Forms (failed items, by location and template, weekly) |
| Locations | `locations` | (with AI; the forms template also shows by location) |
| Schedule | `schedule_activities` | Schedule (delays, critical path, S-curve) |
| Clashes (Coordination) | `clash_results` | Clashes (open clashes, class pairs, company, storey) |
| Document Comparisons | `doc_comparisons` | Document Comparisons (changed pages, title block, revision warning) |
| Specification Analysis | `spec_registers` | (with AI) |
| Models | `models`, `model_elements` | Model Element Breakdown |
| Project and Activity | `activity` (project manager only), `members` | (with AI) |

The templates are in `apps/server/src/reports/templates.ts` and `templates-modules.ts`. A user does not see a template that depends on a
dataset they cannot use (e.g. `activity` is for the manager only).

### Key fields

Every dataset's fields carry localised labels; the localised equivalents (`values`) of code-valued fields go both to the AI and to the
dashboard (localised display in charts and tables). Short list:

- **works / correspondence / rfis / submittals / actions / transmittals** (common): `number`, `title`, `status` (code) and
  `statusLabel`, `isOpen`, `fromCompany`, `toCompany`, `toCompanies`, `ballInCourt` (**ball in court**), `dueDate`,
  `overdue`, `daysOverdue`, `daysOpen` (from sending to reply / closure, or to today), `sentAt`, `answeredAt`.
- **works**: `category`, `replyRequired`, `awaitingReply`, `deliveryChannel`, `deliveryStatus`, `mailSent`, `letterLanguage`,
  `discipline`, `parent`.
- **correspondence**: `direction` (incoming/outgoing), `counterparty` (the other company), `letterDate`, reply/delivery/language fields.
- **rfis**: `discipline`, `rfiCategory`, `priority`, `costImpact`, `scheduleImpact`, `answered`, `revisionCount`.
- **submittals**: `rev`, `outcome` (latest decision code) / `outcomeLabel`, `decided`, `sectionCode` / `sectionTitle` (specification
  section), `kind`, `package`, `reviewDays`.
- **meetings**: `kind`, `date`, `attendeeCount`, `presentCount`, `minutesItemCount`, `actionCount`, `openActionCount`.
- **actions**: `responsibleCompany`, `assignee`, `meeting`, `meetingTitle`, `meetingDate`.
- **reviews**: `status`, `currentStep`, `stepNo`, `stepDueAt`, `overdue`, `daysInStep`, `totalDays`, file outcome counts,
  `targetFolder`, `gated` (whether the target folder is gated).
- **review_files**: review × file; `outcome` / `outcomeLabel`, `decided`, `decidedAt`, `stoppedAtStep`, `copied`.
- **workflow_steps** ("who held it up and for how long"): every step transition in the workflows of reviews, RFIs, submittals and forms;
  `responsible`, `responsibleCompany`, `startedAt`, `endedAt`, `days` (decimal), `dueAt`, `late`, `outcome`.
- **forms**: `template`, `status`, `location`, `locationTop`, `formDate`, `score`, `failedCount`, `hasFailures`, `outcome`.
- **locations**: tree path and level, km, counts of linked forms / open forms / failed items / issues.
- **schedule_activities**: the **latest version** of each schedule series; baseline (from the series baseline), actuals,
  `percentComplete`, `critical`, `late`, `status`, `finishVarianceDays`, work breakdown (`wbs`, `wbsTop`), `summary`.
- **clash_results**: `test`, `status`, `isOpen`, `classA`, `classB`, `classPair`, `storey`, `group`, `assignedCompany`,
  `daysOpen`.
- **doc_comparisons**: counts of changed pages/lines, `antetChanges` (title block changes), revision warnings (`warningCount`, `warnings`).
- **spec_registers**: section, type, discipline and page per item.

### Permissions (visibility)

| Dataset | Rule (same as the module's list) |
|---|---|
| Works and derivatives | `canSeeWork` (creator, assignee, owner/sender company, recipient companies on non-draft works, project manager) + workflow participants |
| reviews, review_files | Project manager, initiator, the assignee of any step |
| workflow_steps | Workflows whose subject the user can see (review / work / form) |
| forms, locations | All project members (same as the Forms and Locations lists) |
| schedule_activities | All project members |
| clash_results | Users who can see all model files of the test |
| doc_comparisons | Users who can see the files of both versions |
| spec_registers | Users who can see the specification file |
| files, versions, models | Folder permission (view, or their own files with upload-only) |
| activity | Project managers only |

A shared dashboard shows each viewer **only as much as their own permissions allow**.

## 3. AI: a small prompt

Because the local model (Ollama `qwen3-8b-16k`, 16K context, CPU) is slow, the prompt is kept small:

1. **Dataset router** (`reports/router.ts`): the Turkish request is folded to ASCII and keyword groups are matched
   ("yazı, cevap bekle" (letter, awaiting reply) → `correspondence`; "bilgi talebi" (RFI) → `rfis`; "kim ne kadar bekletti, adım süresi"
   (who held it up how long, step duration) → `workflow_steps`; "konum, blok, kat" (location, block, floor) → `locations`;
   "iş programı, faaliyet, kritik yol, S-eğrisi" (schedule, activity, critical path, S-curve) → `schedule_activities`
   …). Order: the datasets of the dashboard being edited, the ones explicitly requested, matches in the order they appear in the request, then
   the module's own datasets. If none, `works`, `issues`, `files`. At most 4 datasets.
2. **Module scope:** the "Report" button on a module page sends `module`; that module's datasets are added.
3. **Only the fields of the selected datasets** are included in the prompt; the others appear only by name on one line.
4. **A single example:** the template of the first dataset's module is given as the example (one example per module).
5. **Upper bound:** the system prompt is at most 4,500 estimated tokens (characters / 3). If it exceeds that, the field descriptions are dropped first, then the
   trailing datasets.

### Measurements (Ollama `prompt_eval_count`, qwen3-8b-16k, CPU)

| Prompt | Characters | Tokens | Prompt processing time |
|---|---|---|---|
| **Before:** old prompt, all 6 built-in datasets | 10,690 | 3,325 | 211 s |
| **Before:** as on the server (+ `model_elements`, 7 sets) | ~11,400 | ~3,550 (by ratio) | — |
| **Before, without routing:** old format, all 23 datasets | 30,693 | ~9,600 (by ratio; measurement exceeded 300 s) | ~10 min |
| **After:** "Firmalara göre açık sorun sayısı" (open issues by company) → `issues` | 7,957 | 2,348 | 136 s |
| **After:** "Cevap bekleyen yazılar firma bazında" (letters awaiting reply by company) → `correspondence` | 9,466 | 2,865 | 167 s |
| **After:** "İncelemelerde hangi firma ne kadar bekletti?" (which company held up reviews and for how long?) → `reviews`, `review_files`, `workflow_steps` | 10,975 | 3,367 | 202 s |
| **After:** "Geciken kritik faaliyetler…" (delayed critical activities…) → `schedule_activities` | 11,173 | 3,402 | 194 s |
| **After, widest:** a request naming four modules → 3 datasets | 12,137 | 3,793 | 198 s |

(The prompts are built by `planMessages`; the token count is Ollama's `prompt_eval_count` value, ~3.2 characters/token. Prompt
processing speed on this machine is ~17 tokens/s. Later the indentation in the sample HTML was also removed; prompts are 3–5% shorter.)

Interpretation: before the modules were added, the prompt was ~3,300–3,550 tokens. Without routing, 23 datasets would have produced ~9,600 tokens
(60% of the 16K context; in edit mode, adding the existing dashboard's HTML would overflow it, and processing the prompt alone on CPU would take
~10 minutes). With routing, each request is 2,350–3,800 tokens: as much as before or less, and with access to all
23 datasets. About 50% of the prompt is fixed rules and helper descriptions, ~30% the sample template, the rest datasets.

## 4. Live refresh of saved dashboards

### Change stamp (server)

**Database triggers** were chosen as the simplest and most robust approach (migration `0020_report_stamps.sql`):

- The `report_change_stamps (project_id, scope, counter, changed_at)` table.
- **Statement-level** (FOR EACH STATEMENT) `INSERT / UPDATE / DELETE` triggers on every table the report datasets
  depend on; transition tables are used to find the project of the affected rows, and the project × scope counter is
  incremented **once per statement**.
- Scopes: `files` (files, file_versions, folders, folder_grants), `issues`, `activity` (audit_log), `members`,
  `works` (works, work_types, work_revisions, work_receipts), `workflow` (workflow_instances, workflow_actions), `reviews`
  (reviews, review_files), `forms` (forms, form_templates), `locations` (locations, location_links), `schedule`
  (schedules, schedule_activities), `coordination` (model_sets, clash_tests, clashes, clash_groups, clash_runs),
  `doccompare`, `docintel` (spec_registers, doc_extractions).
- Why triggers: whichever path writes — REST, MCP, Ask, background jobs (IFC conversion, clash runs), imports, WOPI… —
  it is caught; there is no need to add hooks to services one by one, and no write path is forgotten. Reads do not touch
  the stamp. Statements that change no rows (e.g. `INSERT … ON CONFLICT DO NOTHING`) do not increment the counter.
- Each dataset declares the scopes it reads (`sources`). A dashboard's stamp is the scope counters of its datasets +
  **today's date** (values such as delay / days open change at midnight): e.g.
  `members:4,works:17|2026-10-10`. So it only changes when the modules the dashboard uses are written to.

### Client

- The result of `GET /reports/:id/data` comes with the stamp (the stamp is read **before** the queries; a write that arrives during the run is caught at the
  next check).
- An open dashboard calls `GET /reports/:id/stamp` every **25 seconds** (a single indexed read); if the stamp differs, it re-runs
  the queries. It stops while the tab is hidden; it checks immediately when the window regains focus or the tab becomes visible. Automatic refresh
  stops while editing.
- The header shows **"Last updated: hh:mm"**; on automatic refresh, **"Refreshed"** appears for a few seconds.
- New data goes to the sandboxed iframe via **postMessage**; the dashboard does not reload, and the charts are redrawn in place
  (no flicker, scroll position is kept).
- Saved dashboards are **not snapshots**: always current records and the latest versions (such as model_elements).
  For a frozen copy, use **"Take Snapshot (PDF)"** (the browser's print → save as PDF).
- For unsaved drafts there is also `GET /reports/stamp?datasets=a,b`.

## 5. Validity of saved queries and "Repair with AI"

- When a dashboard opens, each query is validated against the current dataset registry. If a field was removed / renamed, that query
  does not run while the others do; the result contains `errorKinds[id] = "invalid"` and a short localised message:
  *"The saved query no longer fits the current data structure (a field may have been removed or renamed): The 'correspondence'
  dataset has no 'karsiFirma' field."* If a similar field exists, it is suggested (`similar field: 'dueDate'`).
- The chart / table on the dashboard that uses that query does not stay blank; **"This section cannot be shown"** and the message appear in its place.
- The dashboard owner (or the project manager) clicks **"Repair with AI"**: **only the broken query, the error message, the names of the missing
  fields and the field list of that dataset** are sent to the model (not the dashboard HTML or other datasets). The model returns only
  a **field mapping** (`{"replace": {"karsiFirma": "counterparty"}}`, `null` if there is no equivalent); the mapping is applied to the saved
  query, so filters, grouping, output names, sorting and the row limit stay unchanged. (At first the full query was
  requested; in that case the local model also changed the row limit, so the mapping method was adopted. A full-query answer is still
  accepted and the saved row limit is kept.) The proposed query is shown; "Apply and Save" saves a new version of the
  dashboard (you can go back to the old version from Versions).
- Without AI: the query is fixed manually under Edit → Advanced.

## 6. MCP and Ask

- `cde_report_datasets` — datasets (module, description) or the fields of one dataset.
- `cde_reports_list` — saved dashboards and module templates.
- `cde_report_run` — runs a saved dashboard (id or name), a template (id or name) or free-form queries; returns rows per
  query (default 25). With the caller's permissions, on current data; nothing is saved. `POST /reports/query`
  is now open to read-only access tokens.
- Ask: requests such as "rapor göster / panel / pano" (show report / dashboard) and "<module> raporu" (<module> report) are routed to the `reports` group; the `cde_report_run`
  result is linked with the source label **P** (report) (saved dashboard → `/reports/:id`, template → `/reports?template=…`).

## 7. Limitations

- Datasets are filtered in memory at project scale; at most 5,000 rows per query, at most 20 queries per dashboard.
  In very large projects (tens of thousands of works / activities), opening a dashboard can take a few seconds.
- If the status codes of custom work types are not in the value list, the code is shown; rows always have `statusLabel`.
- `workflow_steps` computes step durations from workflow records (start, step completed, cancelled); in chains that were sent back /
  reopened, durations may be approximate.
- The location path starts with the code, as on the Forms screen ("A A Blok / A2 Kat 2").
- Clash, comparison and specification datasets only show records that were created (tests / comparisons that were never run
  do not exist).
- Generating a dashboard with the local model takes minutes (prompt processing ~17 tokens/s, generation a few tokens/s); see measurements.
- Live refresh works by polling (25 s); SSE was not used. It also refreshes once when the date changes at midnight.
- If a saved dashboard's query is broken, the query must be fixed first even to change its name/sharing (saving
  validates the queries).

## 8. Trials with a real local model (10.10.2026)

Environment: local test server (PGlite), Ollama `qwen3-8b-16k` (`reasoning_effort: none`), CPU. Sample data: 4 companies, 7 letters,
4 RFIs (with workflow), 3 submittals, 1 meeting / 3 actions, 1 review, locations, 4 forms, 1 schedule. Times are
end-to-end `POST /reports/generate` (prompt processing + generation + validation + queries).

| Module | Request | Selected datasets | Time | Attempts | Result |
|---|---|---|---|---|---|
| Correspondence (Report button) | "Cevap bekleyen yazılar, karşı firmaya göre dağılım ve en eski bekleyenler tablosu" (letters awaiting reply, breakdown by counterparty and a table of the oldest waiting) | correspondence | 211 s | 1 | Valid; 3 queries, KPI + bar + table, correct with real data (6 awaiting reply) |
| Reviews / RFIs | "İncelemelerde ve bilgi taleplerinde hangi firma ne kadar bekletti? Adım bazında ortalama süreleri de göster" (which company held up reviews and RFIs and for how long? also show average durations per step) | reviews, review_files, workflow_steps, rfis | 509 s | 2 (one repair round) | Valid; durations by company and step on workflow_steps |
| Schedule (Report button) | "İş programında geciken ve kritik faaliyetler, iş kırılımına göre gecikme sayıları" (delayed and critical activities in the schedule, delay counts by work breakdown) | schedule_activities (+ works: "iş kırılımı" (work breakdown) also matched the works group; fixed) | 355 s | 1 | Valid; 2 queries (no delays in the sample schedule, empty state correct) |
| Repair | Saved dashboard whose `karsiFirma` field was removed | correspondence | ~70 s | 1 | `karsiFirma → counterparty`; applied, dashboard v2 |

**Ask, "Yazışma raporunu göster" (show the correspondence report):** 257 s. Ask called `cde_report_run`, found the saved "Correspondence Status" dashboard,
and returned the 6 letters awaiting reply as a table, the breakdown by company and month, and the summary "5 yazının termini geçti" (5 letters are overdue); it added a [P1]
link to the dashboard. On the first attempt (when the file tools were also offered) Ask's 240 s model time limit ran out; for report
requests the file tools are no longer offered. Minor flaw: the query ID ("awaiting") appeared once in English in
the answer.

## 9. Tests

- `apps/server/test/report-modules.test.ts`: datasets (permissions and row format), router and prompt upper bound,
  template scripts, all templates running without errors on sample data, change stamp (writes increment, reads do not,
  unrelated scopes are not affected, statements that change no rows do not increment), refresh endpoint, broken-field message and repair,
  module-scoped generation, MCP tools and Ask routing.
- `apps/server/test/reports.test.ts`: earlier report tests (updated for the new templates and dataset names).
