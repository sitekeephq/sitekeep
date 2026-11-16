# Time–Distance and Programme Authoring

Enterprise feature of the **Planning** module ([planning.md](../modules/planning.md)).

For route projects (railway, metro, road, pipeline) the schedule is shown along the chainage: the
horizontal axis is the chainage (km), the vertical axis is time (flowing down). It is part of the
Schedule page; there is no separate programme.

Classic schedule files (Primavera P6, MS Project, Asta Powerproject) do not say *where* an activity
takes place. The core of the feature is therefore **location assignment**: every activity gets a
chainage range, and SiteKeep keeps where that value came from.

The same work also brings programme authoring in SiteKeep (activities, links, CPM, resources), bilingual
activity names, duration basis and schedule checks, activity codes and a schedule of payments, contract
KPIs with monthly reports, and exports to P6, MS Project, PDF, DXF, IFC and TILOS.

## Where to Open It

- **Schedule** page, the **Gantt / Time–Distance / KPI** buttons on the toolbar.
- Address: `/projects/<project>/schedule?s=<version>&v=td` (`v=kpi` for the KPI view).
- Clicking an activity opens the activity drawer, as in the Gantt.
- The other dialogs are in the toolbar's **⋯** menu (**More** on phones): Translations, Schedule Checks,
  Duration Basis, Activity Codes, Schedule of Payments, Shift to Commencement Date, New Version.

## Diagram

- **Sloped line:** work that moves along the route and is longer than 1 km: track, catenary, earthworks,
  signalling, drainage, electromechanical.
- **Block (km × time):** point or short work such as bridges, tunnels and stations. Design and management
  work that covers the whole route is a full-width block.
- **Milestones:** diamonds on the left edge. Milestones without a chainage are laid out in lanes side by side.
- **Data date:** dashed red line.
- **Structure band** at the top: nodes of the **Locations** tree that have a chainage range (station,
  tunnel section, shaft, bridge …). Nodes longer than 90% of the route (e.g. "Line") are left out.
- **Colour:** work type. If none was chosen in the assignment, it is found from the activity name
  (Turkish and English keywords; case and accents are ignored).
- **Pattern:** the operation (excavation, foundations and piles, structure, installation, fill and
  formation, ground improvement, testing), also read from the name. Sloped lines use a line style instead
  of a pattern. Critical work has a red outline, near-critical a dashed orange one.
- **Legend** (top right) lists the work types and operations in use.
- Hovering (tapping on touch screens) shows code, name, chainage, dates, float, work type and duration basis.
- Mouse wheel zooms (Shift: distance only, Ctrl: time only); dragging pans.

## Location Assignment

### Wizard (Assign Locations)

The **Location Assignment Wizard** lists proposals for activities without a location. Every proposal shows
its rule, its evidence and a confidence; the planner selects, corrects or types the chainage. Nothing
changes until **Apply Selected**.

| Rule | Evidence | Confidence |
|---|---|---|
| Chainage in name | "Track laying Km 26+470 – 40+000" | 90% |
| Location code | A location code in the activity name, or the same structure code ("Bridge-4" ↔ "BR-04") | 85% |
| Structure code | Other located activities of the same structure | 80% |
| Location name | A location name in the activity name ("Central Station") | 75% |
| Similar activity | A located activity with a similar name for the same object; different object codes are never matched | up to 85% |
| Same WBS | The range covered by located activities in the same WBS | 70% (45% if wider than half the route) |
| Whole route | Route-wide work such as design, management, testing | 60% (others 20%) |

### Chainage Table

- **Chainage Template (With Activities)** comes filled with the version's activities; **Blank Chainage
  Template** has sample rows. The second sheet explains how to fill it in.
- **Upload Chainage Table:** Excel or CSV. Headers in English or Turkish (Activity ID / Faaliyet Kodu / WBS,
  Start km / Başlangıç Km, End km / Bitiş Km), any column order.
- Matching order: activity code → code without its letter prefix (A8.11.2 ↔ 8.11.2) → WBS path and its tails.
  The number of unmatched rows is reported.
- Chainage formats: `26+470`, `26+470.5`, `26.470` (km).

Assignments belong to the **programme series and activity code**, so they survive a new version and a
re-import of the programme. The source (table, rule, AI, manual), rule, evidence and confidence are stored.

## Programme Authoring

A schedule does not have to come from a file: the planner can build it in SiteKeep, edit it, calculate
it with CPM and load resources.

- **New Schedule** (beside Import): name, project start, data date (start if empty). Opens an empty series
  with version 1, source "manual".
- **The baseline is read-only.** Activities, links, resource assignments and scheduling are refused on the
  baseline version. Use **New Version**: the selected version is copied with its activities, links and
  assignments. The first version of an imported programme is the baseline too.
- **Add Activity** (Gantt toolbar): under the selected WBS node, after the selected activity or at the end.
  Kinds: activity, milestone, WBS node. The suggested code is the last number + 10; codes are unique in
  a version.
- **Edit** in the activity drawer: code, name, WBS (moving takes children along), milestone, start, duration
  (working days) or finish, % complete, actual start / finish. Duration and finish follow the series
  **calendar** (working days and holidays). A WBS node takes its dates from its children; it can only be
  deleted when empty.
- **Predecessors / Successors:** link type FS, SS, FF, SF and lag (working days). Self links, duplicates,
  links to WBS nodes and links that create a loop are refused.
- **Schedule Programme** (F9 in P6): edits do not move dates by themselves; **Needs Scheduling** appears
  after a change. CPM runs with the series calendar and data date: finished activities keep their actual
  dates, activities in progress finish their remaining duration after the data date, the others get their
  early dates. Critical = total float ≤ 0. Activities in a loop are reported and skipped.
- **Date constraints** from P6 XER and MS Project XML ("start / finish on or after", "on or before",
  mandatory dates) are imported, applied by CPM and written back to XER and MS Project XML.
- **Level of effort** (P6 `TT_LOE`) is imported and written back to XER; its start comes from FS / SS
  predecessors and its finish from FF / SF ones, as in P6. MS Project has no LOE type; it is written as a
  normal task.

### Resources

- **Resources** dialog (beside CPM and Export):
  - **Resource Library** per project: code (unique), name, type (labour, equipment, material), unit,
    unit price, daily capacity (unlimited if empty). Deleting a resource deletes its assignments.
  - **Histogram**: planned quantity of a resource per day, week or month with its capacity line; periods
    with a day over capacity are red. Without a resource, the cost of all resources. Totals below.
- **Resources** in the activity drawer: quantity per day, total quantity, cost; **Edit Resources** replaces the list.
- Every assignment puts its daily quantity on each working day between the activity's CPM early dates.
  If a P6 or MS Project assignment covers only part of the activity, its own dates are kept and move with
  the activity.
- XER (`RSRC`, `TASKRSRC`) and MS Project XML (`Resources`, `Assignments`) resources and assignments are
  imported and exported.

## Bilingual Programme (Activity Name Translations)

International tenders often want the programme, its exports and PDF sheets in English while the team
works in Turkish. Translation changes **names only**: codes, WBS, links, dates and chainages stay the same.

- **⋯ → Translations**. Members read, planners edit. Pick a language (default `en`). Table: code, original
  name, translation (editable in the row), source (manual, table, AI). WBS nodes are listed too.
  **Missing Only** filters; **Save** sends only changed rows; an emptied translation is deleted.
- **Download Template**: every activity and WBS node with an empty translation column, for a translator.
- **Upload Table**: Excel or CSV for the selected language. Code column: Activity ID / Activity Code /
  Task ID / Code / WBS (or Turkish equivalents). Name column, in order: "Translation"; a column naming the
  language ("Name (en)", "English"); a non-original name column ("Activity Name"). "Original" columns are
  ignored; unmatched codes are reported.
- **Translate with AI** translates missing names in batches of 80, with progress and **Stop**. It needs the
  **AI module** (a project AI provider); without one the request is refused with `ai_no_provider` and the
  translation table is suggested instead.
- **Activity Names: Original / English …** on the Gantt and time–distance toolbar switches displayed names.
- **Export → Activity Names** writes translated names into every export format; missing translations keep
  the original name and are counted in the `X-Name-Translations-Missing` header. The file name gets the
  language (`…-v3-en.xer`).

## Time–Distance PDF Sheet

- **Colour and pattern, no text (default).** Colour = work type, pattern = operation; only contractual
  milestones are named. Codes, chainages and dates are in the legend, the hover notes and the activity list.
  With **Texts on the diagram → Activity codes (no overlaps)** the codes are printed, placed so that no two
  labels overlap; a label that finds no place is marked `•` in the activity list.
- **Legend** (first sheet): work types, symbols, milestone types (contractual, employer, interface, E&S and
  ITP hold points) and structure types.
- **Assumptions**: automatic ones (calendar, working-day durations, critical / near-critical, data date,
  chainage range, drawing rule, activities left out for having no chainage, source version) and the
  planner's own (**CPM Analysis → Calendar and Settings → Programme assumptions**, one per line, up to 40).
- **Activity list**: every drawn activity and milestone in chainage order with code, name, chainages,
  dates, total float and work type.
- **Hover notes**: an invisible, non-printing form button over each activity; its tooltip shows the details
  (Acrobat, Firefox). Chrome and Edge do not show form tooltips, so clicking jumps to the activity list.
  Codes in the list link back to the diagram. Hover notes can be switched off in the export.
- **SVG** of the on-screen diagram carries a `<title>` per activity (browser tooltip).
- The **print template** (logos, header lines, footer, title block, signature boxes; fields such as
  `{project}`, `{dataDate}`, `{page}`) is shared with the Gantt PDF and the monthly report.

## Tender Programme Requirements

### Contract dates and day 0

- **CPM Analysis → Calendar and Settings → Contract Dates**: day 0 (commencement date), time for completion
  (calendar days) and contractual milestones (milestone activity code, label, contract month). These are
  series settings: kept in new versions and re-imports.
- Contractual date = day 0 + months. Completion date = day 0 + time for completion, compared with the last
  contractual milestone (or the last activity).
- **⋯ → Shift to Commencement Date** (planner): moves a tender programme's notional day 0 to the real
  commencement date. The selected version is copied and every date in the copy moves by the same number of
  calendar days; the series' day 0 is updated, the source version is untouched. Run **Schedule Programme**
  afterwards to put dates back on working days.

### Duration basis

- **Duration Basis** in the activity drawer: quantity, unit, rate per crew-day, crews, shifts per day,
  hours per shift, note. Suggested duration = quantity / (rate × crews), rounded up; more than 10% away
  from the planned duration is a **Mismatch**. Kept per series and activity code; editable on the baseline too.
- **⋯ → Duration Basis**: all activities with planned and suggested duration, Missing and Mismatch filters,
  **Download Template** and **Upload Table** (Excel / CSV; English or Turkish headers, decimal comma read;
  a row with only a code deletes the basis).
- Exports: **Duration Basis** column in Excel, `Duration Basis` in the TimeLiner CSV
  (e.g. `12000 m3 ÷ (300 m3/day × 2 crews) = 20 days · 2×10 h · note`).

### Schedule checks

**⋯ → Schedule Checks** (members): findings grouped by rule, filtered by severity; **Show** selects the
activity; **Export to Excel** writes all findings and a rule summary.

| Rule | Severity | When |
|---|---|---|
| Construction Before Design Consent | Error | No design activity or design-approval milestone in a construction activity's predecessor chain |
| No E&S Hold Point | Warning | An E&S hold point milestone exists but construction does not follow it (info note if none is defined) |
| Contractual Milestones | Error | Milestone finishes after day 0 + months, or its code is missing (info note without day 0) |
| Time for Completion | Error | Completion after day 0 + time for completion |
| Interface Without Buffer | Warning | An interface target date milestone has total float ≤ 0 |
| Negative Float | Error | Total float < 0 |
| Missing Duration Basis / Duration Basis Mismatch | Warning | No basis / suggested duration more than 10% off |
| No Payment Item | Warning / Info | When the series has payment items: activity without an item, item without activities; info for items mapped only to milestones |
| Open Start / Open End | Warning | No predecessor / successor (first and last milestones and contractual milestones excepted) |
| Dangling Logic | Warning | Start only on FF/SF predecessors, or finish only on SS/SF successors |
| Long Lag | Warning | Lag over 20 working days |
| Link to WBS Node / Empty WBS Node | Warning / Info | A link CPM ignores; a node with no activities |

Construction = everything except design, preliminaries / management, testing, site set-up and procurement.
Milestone types (contractual, employer, interface target date, E&S hold point, ITP hold point) are set in
**CPM Analysis → Calendar and Settings**.

## Activity Codes and Schedule of Payments

### Activity codes

- XER import reads `ACTVTYPE`, `ACTVCODE` and `TASKACTV`: project, global and EPS code types with their
  value hierarchy, description, order and colour. MS Project XML text and outline code fields with an
  alias become code types.
- Codes are kept per series, so new versions and re-imports keep them.
- **⋯ → Activity Codes**: code types, value tree and activity counts; planners add, rename and delete.
  **Edit Codes** in the activity drawer picks one value per type.
- Gantt toolbar: **Group by** a code type and **Code Filter** (with child values, or "Without Value").
- Exports: XER (`ACTVTYPE` / `ACTVCODE` / `TASKACTV`), P6 XML (`ActivityCodeType` / `ActivityCode`),
  one column per code type in Excel and CSV.

### Schedule of payments

- An item has a code, description, amount, currency, optional unit and quantity, and a parent item.
  An item with children is a heading; its amount is not counted.
- **⋯ → Schedule of Payments**:
  - **Upload Table** (Excel / CSV): Item Code required; Description, Amount, Currency, Unit, Quantity,
    Parent Item, Activity Codes (`;` separated) optional. Both "1.234,56" and "1,234.56" are read. Items
    are updated by code; missing columns keep their stored values.
  - **Download Template**: filled with the series' items, or a sample.
  - **Create from Code Type** (e.g. a P6 "SOP" code type): one item per value, mapped to the activities
    that carry it. Existing amounts and descriptions are kept.
  - Add, edit, delete and map items by hand.
- Mapping is many-to-many by activity code; a mapped WBS code covers the activities under it.
- Item dates: planned = latest finish of its activities; baseline = latest baseline finish; actual = latest
  actual finish once all are 100%. Payment is per delivered item; there is no partial payment.
- **Cash Flow** tab: monthly and cumulative payment curve per currency (baseline, current programme,
  earned); **Cash Flow to Excel**. This is separate from 5D cost ([4D / 5D](4D_5D.md)), which spreads
  model quantity × unit price over activity durations.
- **Traceability** tab: items without activities, activities without an item, items mapped only to
  milestones, mapped codes missing from this version, and the supporting activities of each item;
  **Traceability to Excel**.

## KPI Dashboard and Monthly Report

**Schedule → KPI** (`?v=kpi`), computed at the version's data date:

| Tile | Calculation | Target |
|---|---|---|
| **P1 SPI** | EV / PV against the series baseline; cumulative at the data date and at each quarter end since day 0, plus the quarter's own SPI | ≥ 0.95 |
| **P2 Interface Dates** | Share of interface milestones due by the data date that were achieved on or before their baseline date | ≥ 90% |
| **P3 Recovery Programmes** | Share of delay notifications whose recovery programme came within 10 working days | each ≤ 10 working days |
| **Q1 ITP Hold Points** | ITP hold point milestones with both a predecessor and a successor | all linked |
| **Forecast Completion** | CPM finish against the baseline and day 0 + time for completion | — |
| **Critical Path** | Open critical and near-critical activities, working days to completion | — |

- **Earned Value Weighting**: Automatic (payment item amounts if any, otherwise resource cost, otherwise
  durations), or chosen. The view says which one was used.
- **Contractual Milestones**: contractual, forecast and actual dates with the variance.
- **Delay Notifications**: notified date, description, affected activity codes, critical path impact,
  cause (employer, contractor, third party, weather, other), recovery programme date and version, measures,
  status (open, recovery submitted, closed). The deadline and the on time / late / overdue badge use the
  series calendar.

### Monthly report

**KPI → Monthly Report → Create Report**: month (one per series and month), comparison version (default:
previous version, otherwise the baseline) and slip threshold (default 5 days). Sections:

1. Summary: data date, comparison, forecast completion, variance, SPI.
2. Performance indicators: P1, P2, P3, Q1 and the quarter-end SPI chart.
3. Contractual milestones.
4. Deviations: activities whose finish slipped more than the threshold, with float before and after,
   critical flag, cause from the latest delay notification naming the activity, and a note per row.
5. Recovery measures: open or changed delay notifications and the planner's recovery text.
6. Critical path: unfinished critical activities.
7. Look-ahead: unfinished activities starting in the next 3 months.
8. Narrative: a first draft is written from the data in the reader's language; the planner edits it.
   **Draft with AI** sends the same data (no names) to the project's AI provider and needs the **AI module**.

**Issue** freezes the report's data; an issued report cannot be edited until **Reopen as Draft**.
**PDF** (A4 portrait, print template) and **Excel** (one sheet per section).

## Import and Export Formats

Import (Schedule → **Import**): Primavera P6 XER, MS Project XML (MSPDI), Excel / CSV with column mapping.
Plus the side tables described above: chainage table, translation table, duration basis table, payment
items table (Excel or CSV, English or Turkish headers, any column order).

Export (**Export** dialog, `GET /projects/:pid/schedules/:sid/export?format=…`):

| Format | Notes |
|---|---|
| Primavera P6 XER | WBS, calendar, links, status, CPM float, chainage in two UDFs, activity codes, constraints, LOE, resources and assignments. Asta Powerproject imports it too |
| Primavera P6 XML | For P6 EPPM and Oracle Primavera Cloud; chainage as UDF; activity code types, codes and assignments |
| MS Project XML (MSPDI) | Opens in MS Project, save as `.mpp`. Activity code in Text1, chainage in Number1 / Number2; constraints, resources and assignments. No activity codes |
| Excel | Activities (chainage, predecessors, baseline, one column per code type, payment items, duration basis) and a links sheet |
| CSV (Navisworks TimeLiner, Synchro) | For 4D tools; activity code, payment item and duration basis columns |
| PDF | Gantt or time–distance sheet, A3–A0 landscape, vector, print template |
| SVG | The on-screen time–distance diagram |
| DXF (R12) | Time–distance drawing in metres × days, one layer per work type |
| IFC 4.3 work schedule | `IfcWorkSchedule` / `IfcTask` with links, WBS nesting and a `7D_Chainage` property set |
| TILOS XML | Field names from TILOS 11.3 |

Every export can use translated activity names (`nameLang`).

Known limits:

- DXF has not been checked in AutoCAD, IFC not with an IFC validator, TILOS and P6 XML not with a real import.
- MS Project `.mpp` and Asta `.pp` are closed binary formats and are not written.
- Payment items created from a code type have amount 0; amounts come from the table or by hand. The cash
  flow is drawn per currency; currencies are not converted.
- Past-quarter EV is estimated from actual dates; the percentages stored in older versions are not used.

## For Administrators

- Requires the **Planning** module and the project's **Schedule** switch. Members read; writing needs the
  planner right (project manager). AI translation and the AI narrative draft need the **AI module** and a
  project AI provider; everything else works without it.
- Writes go to the audit log (`schedule.locations_*`, `schedule.activity_*`, `schedule.dependency_*`,
  `schedule.calculated`, `schedule.resource_*`, `schedule.assignments_saved`, `schedule.translations_*`,
  `schedule.duration_basis_*`, `schedule.checks_exported`, `schedule.commencement_shifted`,
  `schedule.code_*`, `schedule.payment_*`, `schedule.delay_*`, `schedule.report_*`).
- Data that belongs to a series and activity code (chainages, translations, duration basis, activity codes,
  payment mappings, delay notifications) survives new versions and re-imports.

## Where the Code Lives

All in the Planning module repository (`sitekeep-planning`):

| Location | Contents |
|---|---|
| `shared/linear.ts`, `labels.ts`, `operations.ts` | Chainage rules, location proposals, work types, label placement, operations |
| `shared/cpm.ts`, `authoring.ts` | CPM, calendar, authoring rules, resource histogram |
| `shared/translations.ts`, `basis.ts`, `checks.ts` | Translation tables, duration basis, schedule checks |
| `shared/codes.ts`, `payments.ts`, `kpi.ts`, `monthly-report.ts` | Activity codes, schedule of payments, KPIs, monthly report |
| `server/schedule/*-routes.ts` | Routes: `linear`, `authoring`, `resource`, `translation`, `programme` (basis, checks, commencement), `payment`, `kpi`, `export` |
| `server/schedule/translation.ts`, `report-narrative.ts` | AI translation prompt, narrative first draft and AI prompt |
| `server/schedule/export/` | XER, P6 XML, MSPDI, Excel, CSV, PDF, DXF, IFC, TILOS, report PDF / Excel |
| `web/schedule/components/` | `TimeDistance`, `LocationWizard`, `ActivityEditor`, `ResourcesDialog`, `TranslationsDialog`, `ProgrammeDialogs`, `CodesDialog`, `PaymentsDialog`, `KpiView`, `MonthlyReportDialog`, `ExportDialog` |
| `migrations/0001_time_distance.sql` | `schedule_activity_locations`, `schedule_series_settings`, `schedule_print_templates`, `schedule_resources`, `schedule_assignments`, `schedule_name_translations`, `schedule_duration_basis`, `schedule_code_types`, `schedule_code_values`, `schedule_activity_codes`, `schedule_payment_items`, `schedule_payment_item_activities`, `schedule_delay_notifications`, `schedule_monthly_reports` |

The pure rules in `shared/` are used by both server and web. Core-side tests are in
`apps/server/test/modules/planning/` and `e2e/specs/`.
