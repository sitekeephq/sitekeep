# Demo projects: real structure + generated data

Date: 10.10.2026 · Scope: local development server (`http://127.0.0.1:8787`) · Script: `apps/server/scripts/import-demo.mjs`

Three demo projects were set up to try out the reporting dashboards with data at a realistic scale. The **structure** was
read from the user's Forma projects; **all records were generated**. No customer record (file, letter, review,
transmittal, issue, form) was copied.

| Code | Source (Forma) | Folders (Forma → demo) | Files (Forma → demo) | Scale |
|---|---|---|---|---|
| `PKF-DEMO` | PKF IBB-Raylı Sistem Daire Başkanlığı (M10) | 2,278 → 2,278 | 12,409 → 4,003 | 0.322 |
| `MBE-DEMO` | MBE METRO PROJESİ (M7) | 5,793 → 3,887 | 36,732 → 4,001 | 0.109 |
| `DNM-DEMO` | Dikimevi–Natoyolu Metro (A1 Ankaray extension) | 1,410 → 1,410 | 1,887 → 1,887 | 1.000 |
| `RLW-DEMO` | Railway_ISO19650 | not set up | — | — |

The Railway_ISO19650 project has 1,776 folders but **no files, naming standard, reviews or issues** (an empty template).
The "has content" condition was not met, so no demo was set up.

## 1. What was taken from Forma (structure and aggregate counts only)

Forma was accessed **read-only** via Forma MCP; no create/update/delete/move/permission tool was called.

| Taken | Details |
|---|---|
| Folder paths and the file **count** per folder | Folder names only; no file names |
| Naming standard definitions | Fields, separator, value lists (code + description), Number digit range, metadata fields |
| Attribute definitions | Name, type, list options, the folders they are attached to |
| Review template **structure** | Step names, durations (days), rule (all/any), assigned **company/role**, outcome labels, copy target; no person names |
| Companies and their roles | Client / contractor / designer / consultant / subcontractor |
| Aggregate counts | Number of reviews (by status and month), reviews per template, closed review outcome distribution (sample), transmittal total, issue status/type/overdue distribution, project dates |

**Not taken:** file names, file attribute values, individual review/transmittal/issue/form records,
letter numbers and subjects, person names and emails, file contents. The results of tool calls that returned records
were only turned into counts in memory and written nowhere.

Folders carrying record names were not taken either; a count was stored instead, and they were created in the demo with **generated names**:

- MBE `99-Tasarımcı Ortak Alan/999-Yazışmalar` (designer shared area / correspondence): 862 subfolders (each one a letter number) → `Yazı DEMO-yyyy-nnnn`
- MBE `03-Hakediş Çalışmaları/02-Hakediş Dökümanları` (progress payment (hakediş) work / documents): 36 subfolders (IPC no. + date) → `Hakediş Ekleri DEMO-nnnn`
- MBE `14-İMALATLAR_FOTO_2023` (6 folders named by date) and small working folders named by date/subject → converted to counts
- 63 folders **belonging to other projects** inside MBE `ZZ-Yüklenici Taslak Alan` (contractor draft area) → `Diğer Proje Taslakları (anonim)/Diğer Proje Taslağı nnnn`

In the MBE tree, some deep, repeating subfolders (shaft folders under each progress payment period, station
system subfolders, tender design sub-breakdowns) were also folded into their parent folder; **file counts were kept**
(5,793 → 3,887 folders).

### Snapshot files

The structure is kept in `data-import/<CODE>.json` files (outside git, `.gitignore`):

```
data-import/
  PKF-DEMO.json  MBE-DEMO.json  DNM-DEMO.json     structure + aggregate counts (no records)
  *.result.json                                    results of the last import
  builders/                                        scripts that produce the snapshots, and tree texts
```

Snapshot contents: project name/code/dates, companies and their roles, project roles (teams), indented folder
tree (`Ad [dosya sayısı]`, i.e. name [file count]), ISO 19650 status rules, party areas (WIP), uploading-company rules,
company-based permission matrix, naming standard (+ field → role mapping), attribute definitions, review templates
(real review count as weight), statistics (`stats`).

## 2. What was generated

| Item | How |
|---|---|
| Companies | Real company names (if a company with the same name exists, it is reused; e.g. İBB is shared by PKF and MBE) |
| Users | One demo user per company (`idare@pkf.demo.localhost`, `tasarim@mbe.demo.localhost` …) and one user for each project role used by the review templates (`y-yapisal@pkf.demo.localhost` …). Name: "PKF Yüklenici (demo)" (PKF Contractor). Password: the development environment's `ADMIN_PASSWORD` value. The contractor user is the project manager |
| Project roles | If the server supports roles (main branch: it does), they are created as roles/teams and the role user is made a member; review steps are assigned to the role |
| Folders | The whole snapshot tree; status folders `shared` / `published`, party areas (96–99, ZZ) `wip` |
| Permissions | Company-based: a party's WIP area only for that party (edit/manage); sharing and publishing areas view+download for everyone, client/consultant +markup, the delivering party edit |
| Naming | The standard is created and attached to the folders of the real project (see the note below) |
| Attributes | The definitions in the snapshot + a list attribute for each naming field + `Belge tarihi` (document date; date, attached to the root) |
| Review templates | With the real step structure, durations and company/role assignees |
| Files | Real count per folder × scale (random rounding). In naming folders, names are generated from the standard (ALAN from the folder path, SİSTEM from the discipline, DOKÜMAN TİPİ from "Modeller/Çizimler/Raporlar" (models/drawings/reports), sequence number incremented per prefix). In other folders, descriptive demo names ("Giden Yazı DEMO-2024-0457.pdf", outgoing letter). Content: `SiteKeep demo verisi — üretilmiş` |
| Versions | 55% v1, 25% v2, 11% v3, 5% v4, 2.5% v5, 1.5% v6 |
| Attribute values | Naming fields from the name; `Revizyon` (revision) P01, P02 … (C01 … in the publishing area; 00, 01 … in DNM); `Belge tarihi` spread over the project duration following the monthly distribution of real reviews, later versions 7–60 days later; correspondence header data (Sayı, İlgi, Gereği …, i.e. reference number, reference, action required) generated |
| Uploader | The demo user of the party that owns/delivers the folder |
| Reviews | Templates are chosen weighted by real usage counts; 1–8 files from the same folder; status distribution in real (open/closed/cancelled) proportions; closed ones are taken through all steps by the assigned demo users, outcome distribution from the real sample |
| Issues | 100 (DNM 50); status, type, overdue and assigned-company distribution from real totals; overdue ones have due dates in the past |

Review and issue names start with `DEMO-001 …`; their descriptions are "SiteKeep demo verisi — üretilmiş" (SiteKeep demo data — generated).

## 3. Results per project (10.10.2026 import)

| | PKF-DEMO | MBE-DEMO | DNM-DEMO |
|---|---|---|---|
| Companies / users | 6 / 11 | 5 / 18 | 4 / 4 |
| Project roles (teams) | 5 | 13 | 0 |
| Folders | 2,278 | 3,887 | 1,410 |
| Files / versions | 4,003 / 7,222 | 4,001 / 7,137 | 1,887 / 3,324 |
| Attribute definitions | 22 | 23 | 15 |
| Company permissions (grants) | 30 | 26 | 19 |
| Review templates | 8 | 18 | 2 (default) |
| Reviews: completed | 82 | 97 | 40 |
| Reviews: in progress | 67 | 43 | 36 |
| Reviews: cancelled | 1 | 10 | 4 |
| File outcomes (approved / approved with comments / rejected) | 264 / 49 / 9 | 164 / 14 / 70 | 73 / 45 / 63 |
| Issues: open / in progress / in review / closed | 64 / 0 / 27 / 9 | 70 / 0 / 7 / 23 | 24 / 15 / 2 / 9 |
| Issues: overdue | 69 | 3 | 10 |
| Duration | 8 min 14 s | 13 min 30 s (resumed run) | 2 min 45 s |

Real (Forma) figures: PKF 733 reviews (330 open, 399 closed, 4 cancelled), 17 issues (13 overdue);
MBE 2,049 reviews (594 open, 1,318 closed, 137 cancelled), 249 issues (10 overdue). Dikimevi has no reviews, issues
or workflow templates; the two templates in DNM-DEMO (Designer → Contractor 7 days; Contractor → Consultant 15 days →
Client 30 days) and the distributions are **assumptions**.

## 4. Known limitations

- **Naming:** the development server runs the main branch code; the naming improvements in this branch
  (codes containing separators, variable-length Number, fields that do not go into the name) are not there yet. The script detects this
  automatically and attaches a **compatible subset**: ALAN codes such as `SKP1-A` are dropped, Number is fixed at 3 digits,
  Revision and drawing sheet (pafta) name are not part of the name, only attributes. The generated names follow this subset.
  Once the branch is merged, the script attaches the full definition (on a fresh install).
- **Overdue reviews:** the API records the review start as "now"; steps with past dates cannot be created.
  So there are currently no overdue reviews. Step due dates of open reviews fall within 2–30 days
  (3 reviews in PKF, 23 in MBE and 22 in DNM become overdue within 7 days). For time-based reports, the
  `Belge tarihi` attribute on files can be used. For issues, the due date is free, so the overdue distribution is real.
- **Copy target, outcome labels, workflow-bound attributes:** kept in the snapshot (`copyTarget`,
  `outcomeLabels`), but not written to the template; approved files are not copied (so that file counts stay scaled).
- **Where naming is attached:** in PKF, the Forma standard is attached to lower levels of the status folders; in the demo, it was
  attached to the zone group folders (000-Genel, 001-Güzergah …) of each status root. Because attachment is inherited by
  subfolders in 7D, a few subfolders that have no standard in Forma (e.g. the DNM 02_HAT leaves) do have one in the demo.
- **Permissions:** person-based permissions in Forma were reduced to company level; combinations with no 7D equivalent,
  such as "view+download+markup+upload", were mapped to the nearest level (mostly edit or view+download+markup).
- **Priority:** Forma issues have no priority field; PKF/MBE demo issues are "normal".

## 5. Re-running

```bash
# while the development server is running on 8787, from the worktree root:
node --env-file=C:/path/to/sitekeep/apps/server/.env.development apps/server/scripts/import-demo.mjs

# options
--only PKF-DEMO        a single project (repeatable)
--cap 4000             maximum files per project (real counts are scaled down proportionally)
--reviews 150          maximum reviews per project
--issues 100           issues per project
--concurrency 4        concurrent requests
--suffix -2            suffix for codes (second copy: PKF-DEMO-2)
--resume               finish an interrupted import (everything is found by name, missing items are added)
--dry-run              print the plan without contacting the server
```

Projects whose code already exists are skipped. If the server restarts (tsx watch), requests wait until `/health` responds and
are retried; if the process still stops, continue with `--resume`. Generation is deterministic (seed tied to the
project code); the same snapshot produces the same names.

To regenerate the snapshots, use the scripts under `data-import/builders/`
(`node build-pkf.mjs ../`). If Forma needs to be read again, read only the folder tree (`forma_folder_tree`),
naming standard, attribute definitions, review templates and aggregate counts; record contents
must not be written to the snapshot.
