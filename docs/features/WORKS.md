# Works (İşler, `works`): correspondence, transmittals and "Today"

Date: 10.10.2026. Scope: [docs/product/CONCEPT.md](../product/CONCEPT.md) §1 "One box: Works" and docs/archive/YOL_HARITASI.md PKF/MBE priorities #6 and #7.

## Model

Letters, transmittals, RFIs (bilgi talebi) and similar records are kept in a single **Work** table. A type is a template. Types are added through settings, not code.

| Table | Content |
|---|---|
| `work_types` | Project-specific type. Fields: key, name, kind (`correspondence` / `transmittal` / `generic`), number pattern, shared counter group, field list (JSON), status list, default workflow template, icon and colour |
| `works` | Number (unique within project + type), title, status, field values, sender company, for-action (`to`) and for-information (`cc`) companies, responsible person, due date, reply required, delivery record (`delivery`), owner company |
| `work_links` | Work → `file_version` / `review` / `issue` / `work` link. Roles: `ilgi` (reference), `ek` (attachment), `kaynak` (source), `kapak` (cover). `meta.signed` marks a signed PDF attachment, `meta.reply` a reply link |
| `work_events` | Timeline: created, updated, status, link, sent, received, reply, cover PDF, note |
| `work_counters` | Atomic counters. Scope = counter group (or type) + the part of the pattern other than the sequence number |
| `work_receipts` | Acknowledgement of receipt per recipient company |
| `workflow_template_work_options` | A review template's Works settings (automatic transmittal). Kept in a separate table so the workflow tables do not change |

### Preset types

Created in each project on first use:
- **Incoming Letter** ("Gelen Yazı", `{Proje}-GLN-{YYYY}-{0000}`): a record of a letter received from outside. Starts with the "Received" status and is not sent. Fields: sender's reference number, letter date, subject, summary, project code, letter series, department, branch.
- **Outgoing Letter** ("Giden Yazı", `{Proje}-{Gönderen}-{Alıcı}-{YYYY}-{0000}`). Statuses: draft → sent → received → answered / closed; also archived and cancelled.
- For the official letter details of correspondence (yazışma) (language, addressee, text, translations), its PDF and email, see [docs/features/CORRESPONDENCE.md](CORRESPONDENCE.md).
- New fields and statuses are added once, on first use, to the preset types in older projects; user edits are kept.
- **Transmittal** ("Gönderim Formu", `{Proje}-GF-{Gönderen}-{YYYY}-{0000}`; projects opened before 10.10.2026 keep their stored `{Proje}-TRM-…` pattern). A fixed set of versioned files, a purpose (information / approval / construction), acknowledgement of receipt.

### Number

Pattern fields:
- `{Proje}`: project code
- `{Tip}`: type key
- `{Gönderen}`, `{Alıcı}` (sender, recipient): the company's short code (Administration → Companies, 2–8 letters/digits). If there is no code, one is derived from the company name (ASCII upper case, at most 12 characters: "Hilal Müşavirlik" → `HILLINTERNAT`). For a user without a sender company, `{Gönderen}` becomes the project code; with no recipient, `X`.
- Codes are upper-cased with Turkish rules and reduced to ASCII: `{Tip}` "giden-yazi" → `GIDEN-YAZI` (I/S/G/U/O/C instead of İ/Ş/Ğ/Ü/Ö/Ç).
- `{YYYY}`, `{YY}`, `{MM}`: year and month
- `{0000}`: sequence number; the number of zeros gives the number of digits

The counter is incremented with a single `INSERT … ON CONFLICT DO UPDATE … RETURNING`. This is atomic in PostgreSQL even under concurrent requests. There is also a unique index on `(project_id, type_id, number)`. If the pattern changes and lands on an old number, that number is skipped.

### RFIs, submittals and meetings

These records are not separate modules; they are preset types of the same Work model:

| Type | Default number | Statuses |
|---|---|---|
| RFI ("Bilgi Talebi") | `{Gönderen}_{Alıcı}_{Disiplin}_BT_{000}` | draft, open, answered, closed, cancelled |
| Submittal Item ("Teknik Onay Kalemi") | `{Gönderen}_{Tür}_{Disiplin}_{0000}` | draft, in review, approved, approved with comments, noted, revise and resubmit, rejected, closed, cancelled |
| Submittal Package ("Teknik Onay Paketi") | `{Bölüm}-{00} {Disiplin}` | calculated from the items: draft, in review, awaiting revision, partially approved, approved or rejected |
| Meeting ("Toplantı") | `{Proje}-TPL-{YYYY}-{000}` | planned, minutes in preparation, minutes published, cancelled |
| Action ("Eylem") | `{Proje}-EYL-{0000}` | open, closed |

The stored `RFI` and `AKS` patterns of older projects are kept. Patterns can use `{Disiplin}` (discipline), `{Tür}` (kind), `{Bölüm}` (section) and
`{Konu}` (subject), which is not part of the counter scope; the code of the list value is used ("M - Mekanik" → `M`). In the project settings, the standard
patterns or the ZAVM patterns (`{Proje}_{Gönderen}_{Disiplin}_RFI_{000}_{Konu}` and
`{Proje}_{Tür}_{Disiplin}_{0000}_{Konu}`) can be chosen. The submittal (teknik onay) kinds are MOS, NUM, UCZ, YB, IP, ISG, TR, PMR, KS,
IKOF, BAS and MKF; BAS is for information and its outcome is "Noted".

**Approval workflow:** `POST …/works/:wid/submit` creates a `work_revisions` record starting at 0 and a
workflow instance with `subject_type = "work_revision"`. The type's default template is used; `by_attribute`
assignments are resolved from a work field to a company. Without a template, the for-action companies or the responsible person reply in a single step.
`POST …/respond` records the outcome code, the comment and the RFI's official reply text; tiers, approval on behalf of a team and deadline rules are the same as
for normal reviews. If a revise/reject outcome does not continue to the next tier, the record returns to the sender. The final status comes from the template's
`settings.outcomeStatus` setting, and `resmi_cevap` in an RFI comes from the official reply text. For a submittal,
`POST …/revise` turns the same record into a Rev n+1 draft and keeps the history; `POST …/cancel` cancels it. People in the workflow have
permission to see the work item; tasks appear in `/my-tasks` and on the Today screen, and due-date reminders work the same way as for reviews.
The template's automatic transmittal setting can send the revision attachments to the sender or to configured companies.

**Packages:** `parent_work_id` groups items into a package. `POST …/items` adds, `DELETE …/items/:iid` removes. Submitting
a package for approval submits its draft items; the package status is calculated from the item outcomes.

**Meetings:** participants (members or external people), the agenda and the minutes (tutanak) are kept in `works.data`. A minutes item with a responsible person or
a due date becomes an Action sub-item. "Create Next Meeting" carries over the open actions.
`GET …/minutes.pdf` produces A4 minutes.

**Register and import:** `GET /projects/:pid/submittals/register[?format=xlsx]` and
`GET /projects/:pid/rfis/log[?format=xlsx]` return exportable lists.
`POST /projects/:pid/submittals/import` previews a specification list as JSON/CSV/XLSX first with `dryRun`, then
creates it and can package it by section or kind. The row format is `SubmittalRegisterItem`.

**AI suggestions:** `POST /projects/:pid/ai/minutes-actions` suggests actions from minutes,
`POST /projects/:pid/ai/rfi-draft` suggests an RFI draft. It returns 503 if there is no provider and 403 if AI is turned off. The RFI draft uses only the
name and attributes of the selected file, not its content.

Limits of these types: the submittal outcome is not written to the file version's review badge; the meeting minutes PDF is not
saved to a folder automatically; submittal and RFI lists are filtered in memory.

### Who can see it

The rule is in `packages/shared/src/works.ts` → `canSeeWork`. A work item is visible to:
- project administrators (all of them),
- the creator and the responsible person,
- members of the owner company (the creator's company) and of the sender company,
- members of the for-action and for-information companies. These companies see the work item **only when it is not a draft**.

Editing (fields, attachments, status) is open to administrators, the creator, the responsible person and members of the owner/sender company. Recipients give "Received" and start a new letter with "Write Reply". The recipients and attachments of a sent work item do not change. Everyone who can see the work item downloads its attachments through it; no folder permission is needed (like a transmittal recipient).

## Reply chain

`POST /works/:id/reply` creates a new draft:
- type: the source type's `replyTypeKey` setting, otherwise "Outgoing Letter";
- sender: the replying company;
- for action: the sender of the original letter;
- for information: the original letter's for-information companies;
- `ilgi` link: `meta.reply = true`;
- title `RE: <başlık>`; for correspondence, the language, layout, translated subjects (`RE: …`), project code, department and addressee are also carried over.

When the reply is sent, the original letter becomes "answered". `GET /works/:id/thread` follows `ilgi` links in both directions and returns the chain in date order. Work items the user cannot see are left out of the chain.

## Transmittal cover sheet

When a transmittal is sent, an A4 cover sheet is generated with `pdf-lib`. Its content:
- number, subject, date, purpose;
- sender, for-action and for-information companies;
- file table: name, version, revision attribute;
- receipt box.

Liberation Sans is embedded for Turkish characters (`apps/server/assets/fonts`, can be changed with `CDE_PDF_FONT_DIR`). The file is written to the type's `settings.coverFolderId` folder. If this setting is empty, the "Gönderim formları" (Transmittals) folder under the root is used; it is created if it does not exist. In older projects, if there is a "Transmittaller" folder in the root, covers continue to be written there. Writing is done with system permission, and the naming standard and approval gate are not applied to this write. The cover is a normal file version and is linked to the work item with the `kapak` role. `POST /works/:id/cover` regenerates the cover and saves it as a new version.

## Review → automatic transmittal

`workflow/service.ts` has a small event registry: `onWorkflowEvent` / `emitWorkflowEvent`. When a review completes, `reviews.ts` emits a `completed` event; this is the only line added there. The Works module listens for this event.

If the template's `workflow_template_work_options.auto_transmittal` setting is on, a transmittal is created:
- files: the approved files (their approved copies, if any), or all files in the review, depending on the setting;
- source: the review, with a `kaynak` link;
- recipients: the companies in the setting; if the setting is empty, the company that started the review;
- sender: the company of the person who completed the review.

If the `send` setting is on, the work item is sent within the CDE immediately (with the cover PDF and notifications). If it is off, it stays as a draft. These settings are made on the Project Settings → Work Types tab.

If the listener fails, the error is logged. The review still completes.

## KEP and e-signature preparation

KEP is the Turkish registered electronic mail service. At present, no call is made to any external system.

The `DeliveryChannel` interface in `apps/server/src/works/delivery.ts`:

```ts
interface DeliveryChannel {
  id: string; label: string; description: string;
  manual: boolean;              // the user enters the reference and status manually
  requiresSignedPdf: boolean;   // at least one attachment must be marked "signed PDF"
  send(req: DeliveryRequest): Promise<DeliveryResult>;      // { status, reference }
  refresh?(reference: string): Promise<DeliveryResult | null>; // status query to the provider
}
```

Registered channels:
- `cde`: within the CDE. Recipients receive a notification.
- `elden` (by hand)
- `eposta` (email, manual)
- `kep` (manual): the KEP delivery number is entered manually. The delivery status (`pending` / `sent` / `delivered` / `failed`) is updated with `PATCH /works/:id/delivery`. Sending requires at least one PDF attachment marked "signed".

"Signed PDF" is only a flag for now (`work_links.meta.signed`). The signature is not verified.

### Next step: a real KEP provider

1. A class is written that implements the `DeliveryChannel` interface with the provider's API, e.g. `KepProviderChannel`.
2. `send` does the following: reads the attachments through `storage`, passes the signed PDF and the cover letter to the provider, and returns the delivery number issued by the provider.
3. `refresh` fetches delivery and read receipts from the provider. A job queue task (`jobs`) calls it at intervals and updates the `delivery.status` field.
4. Credentials are stored encrypted with `secrets.ts`, like AI provider keys.
5. The channel is added to the `DELIVERY_CHANNELS` list. Routes and the UI do not change.
6. E-signature (PAdES) verification is a separate step. The signature is verified when an attachment is uploaded or before sending, and the result is written to a verified field instead of `meta.signed`.

## API

All paths are under `/api/v1`.

| Method and path | Purpose |
|---|---|
| `GET /projects/:pid/work-types[?all=1]` | Types (preset types are created if needed) |
| `POST /projects/:pid/work-types`, `PUT …/:tid`, `DELETE …/:tid`, `POST …/:tid/restore` | Type editor (project administrator). Deleting archives |
| `GET /projects/:pid/work-automation`, `PUT …/:tid` | Automatic transmittal per review template |
| `GET /delivery-channels` | Delivery channels |
| `GET /projects/:pid/works?type=&status=&q=&open=1&due=overdue\|soon&mine=1&view=awaiting\|unmailed\|archived\|cancelled` | List (visible items only) |
| `POST /projects/:pid/works` | Create (`typeKey` or `typeId`, fields, recipients, links) |
| `GET` / `PATCH /projects/:pid/works/:wid` | Detail (links, backlinks, timeline, permission flags) / update |
| `POST …/:wid/comments` | Note |
| `POST …/:wid/links`, `PATCH …/links/:lid` (`signed`), `DELETE …/links/:lid` | Attachment and reference links |
| `GET …/:wid/links/:lid/download[?inline=1]` | Download the fixed version through the work item |
| `POST …/:wid/send` | Send (`channel`, `reference`, `note`) |
| `PATCH …/:wid/delivery` | Manual delivery status and delivery number |
| `POST …/:wid/receive` | Received on behalf of my company |
| `POST …/:wid/reply` | Reply draft |
| `POST …/:wid/cover` | Regenerate the cover PDF |
| `GET …/:wid/thread` | Correspondence chain |
| `PUT …/:wid/letter`, `GET …/:wid/letter.pdf`, `GET …/:wid/letter.eml`, `POST …/:wid/letter/mail`, `POST …/:wid/letter/mail-sent`, `POST …/:wid/letter/translate` | Official letter (see [docs/features/CORRESPONDENCE.md](CORRESPONDENCE.md)) |
| `POST …/:wid/archive`, `POST …/:wid/cancel`, `POST …/:wid/reopen`, `DELETE …/:wid` | Archive, cancel, return to draft, delete (draft / cancelled only) |
| `GET /me/today` | The "Today" box: assigned to me, awaiting reply, awaiting receipt, due soon and overdue, my review tasks (`/my-tasks`). Returns with a count for each group |

## UI

- **Works** project tab: type filters, search, status and due-date filter, "New Work Item" (choose a type first, then a form is built from the type's fields).
- Work item detail: fields, delivery box, receipts, attachments (version picker, signed PDF flag, download), reference links (work item / issue / review), correspondence chain, timeline and notes. Actions: Send, Received, Write Reply, Edit, Regenerate Cover PDF.
- In correspondence, the "Letter" section: letter details, PDF preview, email, archive / cancel / return to draft / delete. Correspondence filters and grouping in the list.
- **Today** in the top menu: replaced the old "My Tasks" page. The `/tasks` address redirects to `/today`.
- Project Settings → **Work Types**: type editor (fields, number pattern, counter group) and the automatic transmittal table.

## Limits

- The "Today" screen has no new versions from followed folders, because folder following does not exist yet (`newVersions: null`).
- For a review link, the review's visibility is not checked; it only has to be in the same project. The link shows only the review number and name.
- List and "Today" visibility are filtered in memory. This is enough for up to tens of thousands of records; PKF had 2,581 letters.
- MCP / "Ask": `cde_works_list`, `cde_work_get`, `cde_work_thread` and the other Works tools use the same visibility rules.
- Importing from letter attributes in Forma (Sayı, İlgi, Gereği/Bilgi — number, reference, for action/for information) is a separate task.
