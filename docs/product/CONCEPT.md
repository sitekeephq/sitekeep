# SiteKeep — Product concept: a simple CDE with local AI

Date: 10.10.2026

## Positioning (11.10.2026)

**Tagline: "OpenCDE-compliant, privacy-first CDE platform."** Every decision follows these two principles:

- **OpenCDE-compliant:** data is not locked in. Issues are exchanged via BCF, files via the Documents API, and identity via the Foundation API + OAuth2, all in standard formats. Customers can move their data to another CDE at any time.
- **Privacy-first:**
  - Data stays on the customer's server (on-prem). The application sends nothing out on its own; there is no telemetry.
  - AI is local by default (`local_only`). An external provider is used only if an administrator enables it and the project allows it; outgoing data is minimised and logged.
  - Every external connection (AI, email, office editor, MCP, OAuth application) is visible under Administration and can be switched off in one place.
  - Permissions, approvals and access are checked on every operation and logged (KVKK, the Turkish data protection law).

## Problem

CDEs such as Forma / BIM 360 / Aconex are powerful but **cumbersome**:

- **Too many modules:** Docs, Reviews, Transmittals, RFIs, Submittals, Issues, Forms. Each has its own screen, settings, numbering and notifications.
- **Deep folder trees and permission matrices:** 50–100 folders, each with its own permission definition.
- **Naming that makes users memorise codes:** `ZAVM-PAS-ZZ-S-B1-0204-RP-MC-0001`. If the user does not know the code, the file cannot be uploaded.
- **Information is reachable only by those who know where to look:** the answer to "Which is the latest approved electrical drawing sheet (pafta)?" is three screens away.

Even in well-set-up projects such as PKF and MBE, the project BIM manager carries this burden.

## Principle

> **The user does not learn the structure; the structure understands the user.**
> The rules (permissions, naming, approval workflow) run strictly in the background. Local AI translates the user's language into these rules.

Data and models stay on the customer's server. AI suggests, strict rules decide, a human approves.

## Six simplifications

### 1. One box: "Work"
Review, RFI, submittal item, transmittal, issue and correspondence (yazışma) are not separate modules. They are all types of the same **Work** record (İş):

- one list, one detail screen, one numbering engine
- one workflow engine (steps, person/company, duration, outcome)
- one notification stream

Types are templates. "RFI" = numbering format `PAS_CNS_{D}_RFI_{001}` + CNS → HLL → ZRT workflow + RFI fields. Adding a new type is a configuration task and needs no code.

The user's home screen is **"Today"**: items assigned to me, items due in 2 days, new versions and their summaries.

### 2. Drop it and let it do the rest (smart upload)
You drop a file anywhere in the project. The local model reads:

- the PDF title block (text layer, OCR if needed)
- the IFC project information
- the file's own name

From these it **suggests a name that follows the naming standard, plus the folder, discipline, attributes and revision**. The user confirms with one click. No more memorising codes. The strict validator (`validateName`) still has the final say; the model cannot suggest a wrong code, because suggestions are chosen only from the values in the standard.

### 3. Shallow folders + smart views
The folder tree exists only as a **permission boundary** and is kept shallow:

- level 1: company or discipline area
- level 2: status (WIP / Shared / Published / Archived)

Discipline, floor, type and status are stored as **attributes**. Users see them as **views**: "Electrical · Approved · Latest version", "Returned from Hill this week". Views are saved and shared. One view replaces a tree of 30 folders.

### 4. Permissions through role packages
When a project is set up, each company is assigned a **role**. The role package applies the folder permissions itself; nobody fills in a matrix by hand.

| Role | Package contents |
|---|---|
| Client | Sees everything, approves Published |
| Consultant | Sees Shared, approves in review steps |
| Designer | Edits in its own WIP area, sends to Shared through review |
| Contractor | Edits in its own area, opens RFIs and submittals |

The question "Who can see this file?" is answered with one click, in plain Turkish. The strict permission engine produces the answer.

### 5. The "Ask" box
Every screen has a Turkish question box at the top. Example questions:

- "Elektrik paftalarının son onaylı versiyonları" (latest approved versions of the electrical drawing sheets)
- "Termini geçen RFI'lar hangi firmada bekliyor?" (which company are the overdue RFIs waiting with?)
- "Bu IFC'de EI60 yangın kapısı kaç tane, hangi katlarda?" (how many EI60 fire doors are in this IFC, and on which floors?)
- "Geçen haftadan beri statik projede ne değişti?" (what has changed in the structural design since last week?)

The local model does not make up answers. It calls the CDE's own tools: search, attribute filters, work lists, IFC property queries, version diffs. These are the same functions as the MCP tools and run **with the user's own permissions**. The answer includes links to the source files, work items and elements.

### 6. Every change is read
- A **change summary** is produced for every new version: GlobalId diff in IFC, changed regions in PDF, clause diff in text.
- In a review, the reviewer first sees the "what changed" summary.
- The transmittal and the revision note are filled in automatically.
- Every user receives a daily digest.

## Architecture additions

```
                ┌──────────── SiteKeep server ───────────────┐
Browser ───────►│ REST API · permissions · naming · workflow │
"Ask" box ─────►│ Assistant: tool-calling loop (with the    │──► Local LLM (Ollama / vLLM,
AECPilot ──────►│   user's permissions) + CDE tools         │    OpenAI-compatible API)
Claude (MCP) ──►│ Content extractor: PDF text, OCR, IFC     │
                │ Vector index: pgvector (also in PGlite)   │──► Embedding model (bge-m3)
                │ Job queue: summaries, index, suggestions  │
                └────────────────────────────────────────────┘
```

- **`AiProvider`:** local by default (OpenAI-compatible endpoint); Claude API optional; can be switched off.
- **Tools:** one tool set. The same functions are used in REST, in the MCP server and in the local assistant; every call runs with the user's permissions.
- **Audit:** every assistant call is logged (who asked what, which tools, which records were read).
- **Hardware:**
  - for development, this computer (Snapdragon X Elite, 32 GB) is enough for 3–8B models;
  - on the customer's server, a GPU with 16–24 GB VRAM is enough for 14B models.

## Must not be missed (added topics)

Topics that did not come up in the first discussions but will be needed on site and in public-sector projects.

| Topic | Why it matters | How | Priority |
|---|---|---|---|
| **Official correspondence: KEP + e-signature** | In public and client projects such as İBB and Zirve, official letters go out with a wet signature, an e-signature or KEP (registered electronic mail) | Correspondence as a Work type: reference number, subject, attachments, reply chain. Signed PDF with e-signature (PAdES). Send and receive via a KEP provider | High (together with the correspondence module) |
| **Approval stamp / watermark** | "Approved", "Approved for construction", "For information" stamps; watermark on external sharing | Stamp layer on the approved PDF from the review outcome (date, person, company, review no.) | High |
| **Location hierarchy** | In metro and rail projects, location by station / floor / room or by km; issues and work items are linked to a location | Location tree + km (chainage) range; IFC 4.3 alignment is read | High (PKF and MBE are metro/rail) |
| **Site / mobile** | Issues, photos and forms from tablets and phones on site (şantiye); weak connectivity | PWA, offline queue, camera, QR code (room or drawing sheet → CDE link) | High |
| **Meetings** | Coordination meeting minutes (tutanak) and action items | Meeting = Work type; items become child work items with an owner and due date; the local model drafts the minutes | Medium |
| **External share link** | Sending files to non-members, time-limited and password-protected | Time-limited link, download limit, watermark, audit log | Medium |
| **Email notifications and inbox** | Users are informed without logging in to the CDE; files can be received by email | SMTP notifications and daily digest; attachments sent to the project email address land in a quarantine folder | Medium |
| **Dashboard and reports** | Overdue items, approval cycle times and pending work by company for managers | Ready-made dashboards; Excel/PDF report export; reports from the "Ask" box | Medium |
| **Office and DWG preview** | Viewing DOCX/XLSX/DWG files without downloading | Conversion to PDF with LibreOffice on the server; for DWG, licensed ODA or PDF/DXF publishing from AECPilot | Medium |
| **Handover archive** | Orderly delivery of the information model to the client at project end | Indexed archive of Published content (ZIP + Excel list + IFC + COBie); read-only archive mode | Medium |
| **Odoo integration** | 7Dimensions already runs Odoo: projects, purchasing, progress payments (hakediş) | CDE project ↔ Odoo project; submittal material approval ↔ purchase order; work item due dates ↔ Odoo activities | Medium |
| **Quantity take-off (metraj, QTO)** | Quantities from IFC for progress payments and cost estimates (keşif) | Table by class, floor and material from IFC quantity sets; Excel output | Low–Medium |
| **Point cloud / infrastructure layers** | Scans and alignments in rail projects (available in OpenBIM-App) | LAS/E57 preview layer; port the IoT and heatmap layers to the viewer as plugins | Low–Medium |
| **KVKK and retention policy** | Personal data, retention periods, deletion requests | Retention rules, legal hold, personal data export and anonymisation, audit report | Medium |
| **SSO / Active Directory** | Single sign-on for enterprise customers | LDAP/AD and OIDC (Entra ID, Keycloak) | Medium |
| **Backup, upgrade, monitoring** | Keep the IT burden of on-prem installations off us | Backup and restore from the administration screen, version upgrade, disk and job queue health, storage quota | High (before installation) |
| **Multiple languages** | Projects with foreign partners | TR/EN interface; content language is free | Low |
| **@mentions and following** | Calling a person into a work item, file or markup | @person, @company in comments; follow / unfollow | Medium |

## Order

1. **AI foundation:**
   - `AiProvider` (local / Claude / off)
   - content extractor (PDF text layer, IFC properties)
   - pgvector index
   - fake provider for tests
2. **Smart upload:** name, folder and attribute suggestions (chosen from the naming standard values).
3. **"Ask" box:** with read-only tools (search, views, work list, IFC query).
4. **Single "Work" model:** review, RFI, issue and correspondence types on top of the workflow engine; the "Today" screen.
5. **Change summaries and daily digest.**
6. **Role packages and project setup wizard:** PKF/MBE templates or setup with 5 questions.

This concept defines the **user-facing side** of the module list in docs/archive/YOL_HARITASI.md (archived). The infrastructure (workflow engine, attributes, markup, IFC diff) is used as is; instead of separate module screens, it is presented through "Work", "Views" and "Ask".
