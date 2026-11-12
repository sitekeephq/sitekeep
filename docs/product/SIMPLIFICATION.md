# Simplification plan

Date: 11.10.2026. User decision: phase 1 first, then phases 2 and 3.

## Problem

- The infrastructure is solid: one Work model, one approval engine, permissions, AI tools.
- The complexity is on screen. We copied Forma's module list one-to-one into the menu: the left menu has 17 items.
- Users first have to think "which module is this in?".
- Issues, Reviews and Forms are also records waiting for someone to do something. So they are all "Work", yet they look like separate modules.
- The Work page has four rows of filters.

## Principle

- No feature is removed. Everything appears only where it is needed.
- Users do not look for modules. They type what they want to do, and the system takes them to the right place.
- The default is the simplest setup. Advanced settings are hidden.

## New menu (5 items)

| Menu | Contents |
|---|---|
| Today | Assigned to me, changes, risks |
| Work | Correspondence (yazışma), RFI (bilgi talebi), Submittal (teknik onay), Meeting and Action, Transmittal, Issue, Review, Form; saved views |
| Documents | Files; approval status, comparison, editing and specification analysis inside the file and folder |
| Model | Viewer; Coordination (clashes, model sets) and Schedule (Gantt, 4D) as tabs |
| Reports | Dashboards; pinning an "Ask" answer to a dashboard |

The "Ask…" box sits at the top of the menu and Project Settings at the bottom. Locations, numbering patterns and workflow design move to Project Settings.

## Phases

### Phase 1 — reduce visible complexity

- A 5-item menu. Old addresses redirect to their new locations.
- A project-specific Today page (project home page).
- Work as the single hub:
  - Correspondence, RFIs, Submittals, Meetings, Transmittals, Issues, Reviews and Forms sit inside the page as views.
  - Users can save their own filters as a "view".
- Per-project module switches:
  - A disabled module does not appear in the menu, in views or in "+ New".
  - A disabled module's data is not deleted.
- A single "+ New" button:
  - A "What would you like to do?" box and the record types of the enabled modules.
  - A type and title are suggested from the sentence typed. This step works without AI, using keywords.
- Advanced settings (numbering patterns, attributes, workflow design) sit behind an "Advanced" button.

### Phase 2 — let AI do the work

- An AI summary on the Today page: assigned to me, recent changes, risks.
- Record from a dropped PDF or email: AI reads the reference number, date, subject, sender and referenced letter; the user confirms.
- An AI draft in the "+ New" box. Example: "Prota'ya B3 kazısı için bilgi talebi aç, son revizyonu ekle." (open an RFI to Prota for the B3 excavation and attach the latest revision).
- Natural-language search in every list. Example: "termini geçen Prota yazıları" (overdue letters from Prota).
- Extracting actions from meeting notes or audio recordings.

### Phase 3 — simple role-based screens

- Site (phone): Today, Form, Issue, Photo; offline.
- Document control: Documents and Work.
- Project manager: Today and Reports.
- Role packages decide which screen opens.

## Success measure

The click count of the 5 most frequent tasks for three user types is measured before and after:

- Site engineer: fill in a form, open an issue, add a photo, check what is assigned to me, close an action.
- Document control: upload a file, send for review, register an incoming letter, write a reply, create a transmittal.
- Project manager: see today's status, see overdue work, open a report, give an approval, look at meeting minutes (tutanak).

## Note

Phase 2 depends on AI. On this computer, local model answers take minutes. A decision on a machine with a graphics card must be made before phase 2. Phase 1 simplifies without waiting for AI.

## Phase 1 results

Date: 11.10.2026 · Branch: `feat/sade-1` · Migration: `0022_saved_views` (saved views table, `projects.settings`, `users.prefs`).

**Status (22.10.2026):** the 5-item menu is defined in `apps/web/src/app/navigation/nav.ts` (`NAV_ITEMS`) and in the route tests.
`ProjectShell` still draws the grouped `PROJECT_NAV` (`apps/web/src/app/navigation.ts`). Route redirects and the Work
hub work; the left menu has not fully switched over.

### What changed

- **5-item menu:** Today, Work, Documents, Model, Reports. "Ask…" at the top, Project Settings at the bottom. Group headings are gone; the menu still collapses to an icon strip and opens as a drawer on phones. Documents goes to the last opened folder, Work to the last view.
- **Today (project home page):** Assigned to Me (steps awaiting my approval, work assigned to me, my actions, letters awaiting reply, items awaiting acknowledgement, forms to fill in, issues assigned to me), Overdue, Upcoming Due Dates (7 days, including meeting days) and Recent Changes (7 days, grouped by day and person, only records the user can see). Each row links to its record. No AI; space is reserved at the top of the page for the phase 2 summary (`aiSummary`). The global Today page showing all projects (`/today`) remains.
- **Work as the single hub:** a list of views (vertical on desktop, a select box on phones): Assigned to Me, All Work, Correspondence, RFIs, Submittals, Meetings, Transmittals, Issues, Reviews, Forms and the user's saved views. Issues, Reviews and Forms open with their own pages inside the hub; the database tables were not merged. The four filter rows became one: search, a "Filters" dialog (type, status, due date, quick filter, grouping, open work only) and removable filter chips. Filters are kept in the address bar.
- **Saved views:** "Save View" stores the view, filters, grouping and search under a name (per user and project, on the server). A project manager can share a view with the project. "Edit Views" covers renaming, ordering, sharing and deleting.
- **Single "+ New":** above Work and Today. A "What Would You Like to Do?" box and the record types of the enabled modules. The type, title, company (sender or recipient) and form template are chosen from the typed sentence by keyword; rules in `packages/shared/src/intent.ts`, tests in `packages/shared/test/intent.test.ts`. Hook for the phase 2 AI draft: `apps/web/src/features/works/new-record.ts` → `draftFromSentence`.
- **Modules:** Project Settings → Modules (project manager). A disabled module does not appear in the menu, Work views, "+ New", Model tabs, the Ask assistant's tools, report templates or datasets. Its data is not deleted; existing records open, new records are rejected with a Turkish message (`403 module_disabled`). Template defaults: in ISO 19650 Basic, Document, Review, Issue, Correspondence and Reports are on and the rest off; in Metro İBB and Data Centre, all are on. In existing projects, all are on.
- **Model:** Viewer, Coordination (model sets, clashes, IDS) and Schedule (Gantt, 4D) tabs; the pages are unchanged.
- **Documents:** "Submittal Register from Specification" in the toolbar; the same button is also in the Submittals view. Reviews open from the file panel and from Work.
- **Project Settings:** tabs Members, Roles, Modules, Locations, Template, AI. Naming standards, workflows (review chain design), work types (numbering patterns), attributes, recycle bin, activity log and role package per company (detailed permissions) appear with "Show Advanced Settings"; the choice is stored per user on the server. Members who are not project managers see only Locations.

### Old addresses

All old addresses still work. Notification, email and MCP links (`/works/:id`, `/reviews/:id`, `/forms/:id`, `/issues/:id`, `/files/…?file=…`, `/viewer?v=…`, `/reports/:id`) are unchanged. Table and tests: `apps/web/src/app/navigation/routes-table.ts`, `apps/web/test/app/routes.test.ts`.

| Old address | Now |
|---|---|
| `/p/:pid` | Today (previously redirected to Documents) |
| `/works`, `/works?bolum=…`, `/works/:id` | Work → the matching view (Assigned to Me: `?bolum=bana`) |
| `/issues`, `/issues/:id` | Work → Issues (page inside the hub) |
| `/reviews`, `/reviews/:id` | Work → Reviews |
| `/forms`, `/forms/:id` | Work → Forms; the PDF form template editor remains full-screen |
| `/viewer`, `/coordination/*`, `/schedule` | Model → Viewer / Coordination / Schedule tabs |
| `/coordination` | Redirects to `/coordination/sets` |
| `/spec`, `/spec/:id` | Inside Documents (Documents selected in the menu) |
| `/locations` | Redirects to `/settings?sekme=konumlar` |
| `/works?bolum=bilinmeyen` | Redirects to `/works` |

### Click counts

Measured on 11.10.2026 on a local server with the ZAVM demo project (`seed-demo.mjs` and generated records), user Elif Aydın (contractor, project manager), desktop at 1280 pixels. "Before" is `mvp-v1` (225200e), "after" is `feat/sade-1`; both were counted by navigating in the browser.

Rules: the starting point is the first screen shown on entering the project (Documents before, Today after). Each click and Enter counts as 1; choosing from a drop-down counts as 2 (open, choose); choosing in the file dialog counts as 1. Typing and filling in form fields are not counted.

| User | Task | Before | After | How, after |
|---|---|---|---|---|
| Site engineer | Fill in a form | 6 | 4 | + New → type "beton döküm formu" (concrete pour form), Enter (template preselected) → Create → Send. Without typing: 6 |
| Site engineer | Open an issue | 5 (needs an open IFC model) | 3 | + New → type "B3 perdede çatlak sorunu" (crack in the B3 shear wall), Enter → Save. No model needed |
| Site engineer | Add a photo (to an open form) | 4 | 3 | Today → form under Forms to Fill In → Add Photo → file |
| Site engineer | Check what is assigned to me | 1 (global Today; no issues or forms) | 0 | Project home page |
| Site engineer | Close an action | 4 | 3 | Today → action → Status: Closed |
| Document control | Upload a file | 5 | 4 | Documents (last folder) → Upload → file → Upload. First time in the project: 6 |
| Document control | Send for review | 5 | 4 | Documents (last folder) → tick the file → Start Review → Start. First time: 6 |
| Document control | Register an incoming letter | 6 | 3 | + New → type "Hill'den gelen yazı: …" (letter from Hill: …), Enter (sender and title filled in) → Save. Without typing: 5 |
| Document control | Write a reply | 3 | 2 | Today → letter under Letters Awaiting Reply → Write Reply |
| Document control | Create a transmittal | 5 | 3 | + New → type "CNS'ye gönderim formu" (transmittal to CNS), Enter (recipient preselected) → Save. Without typing: 4 |
| Project manager | See today's status | 1 | 0 | Project home page |
| Project manager | See overdue work | 3 (project-wide; own work only: 1) | 0 | Today → Overdue |
| Project manager | Open a report | 2 | 2 | Reports → dashboard |
| Project manager | Give an approval | 5 | 4 | Today → step under Awaiting My Approval → Apply to All: Accepted → Submit Step |
| Project manager | Look at meeting minutes | 2 | 1 | Today → meeting under Recent Changes (if changed in the last 7 days). Otherwise 3: Work → Meetings → meeting (2 when Work remembers the last view) |
| **Total** | | **57** | **36** | Worst case (first visit to the project, no sentence typed) 47 |

## Phase 2a — Today's Summary

Date: 11.10.2026 · Branch: `feat/sade2-bugun` · Migration: `0024_today_summaries` (latest AI summary per user + project).

- **Location:** a "Today's Summary" card at the top of the project Today page, 3–6 bullet points. Record numbers in the bullets link to the records.
- **Automatic summary:** without AI, built from Today data with template sentences (assigned to me, due dates falling today, overdue items, letters awaiting reply and the sending company, the latest change, "Most urgent: …"). It appears as soon as the page opens. Code: `apps/server/src/today/text.ts`.
- **AI summary:** the model receives only counts and at most 15 short lines (number, title, type, due date, why it is here, who is waiting; the last 3 changes). No documents or descriptions are sent. Any bullet containing a record number or figure not in the input is dropped (the same guard as in model/ai.ts). When ready, it replaces the automatic summary: "AI Summary · hh:mm".
- **Cache:** user + project + stamp (a hash of the compact input). It is rewritten when the stamp changes, at most once every 15 minutes; "Refresh" does not wait for the 15 minutes but does not call the model if the data has not changed. Yesterday's summary is not shown. Code: `apps/server/src/today/service.ts`.
- **If there is no provider:** "Send to AI" (task type `today_summary`); the connected client's answer goes through the same validation and is stored as the requester's summary. An answer with invented numbers is returned with a list of errors.
- **If AI is switched off:** automatic summary only.
- **Card:** "Refresh", "Hide"/"Show" (per user, `users.prefs.todaySummaryCollapsed`). While the model is writing or a task is pending, the page polls for the summary every 5 seconds.
- **Endpoints:** `GET /projects/:pid/today` (`summary` field; `?ai=0` does not start a run), `GET /projects/:pid/today/summary`, `POST /projects/:pid/today/summary` (`{force?}`, `?wait=1`).
- **MCP / Ask:** `cde_project_today` (Today data + summary).
