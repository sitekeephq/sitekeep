# Correspondence (official letters)

Date: 10.10.2026. Source: the Odoo 19 module `sevend_yazismalar`. This document describes how the module's design was carried over to SiteKeep.

No separate module was written. Correspondence (yazışma) is already a type of **Works** (`correspondence`, see [docs/features/WORKS.md](WORKS.md)). The parts missing compared with Odoo were added to Works. The goal is simplicity: no new table; the letter data is kept in the `works.data.letter` field (jsonb) and validated on the server with zod.

## Odoo field → SiteKeep

| Odoo (`sevend.correspondence`) | SiteKeep | Note |
|---|---|---|
| `name` (GEL-/GID- sequence) | `works.number` | Incoming and outgoing letters had separate counters. The pattern is set on the type, e.g. `GEL-{YYYY}-{00000}`, `GID-{YYYY}-{00000}` |
| `type` (incoming / outgoing) | work type: "Incoming Letter" (`settings.incoming`) / "Outgoing Letter" | |
| `company_id` | project + owner company | Visibility via the `canSeeWork` rule |
| `partner_id` | sender company (incoming) / first action company (outgoing) | |
| `recipient_name`, `recipient_address`, `recipient_email` | `letter.recipient` {name, address, email} | Filled from the counterparty company, editable by hand |
| `cc_list` | `letter.ccEmails` | Array; addresses are validated |
| `language`, `secondary_language` | `letter.language`, `letter.secondaryLanguage` | tr, en, fr, it, es, de. The second language must differ |
| `bilingual_layout` | `letter.layout` | `columns` (side by side) / `stacked` (one below the other) |
| `subject` | `works.title` | Turkish subject |
| `content`, `content_2` | `letter.body`, `letter.body2` | Plain text + light markup instead of HTML (below) |
| `translation_ids` | `letter.translations[lang]` | subject, body, body2, signerTitle, referenceText |
| `full_name`, `job_title` | `letter.signer` {name, title} | The job title can be translated |
| `reference_ids` / `referenced_by_ids` | `work_links` (`role = ilgi`) / backlinks | Referencing itself is not allowed |
| `reference_text` | `letter.referenceText` | |
| `thread_count`, `action_view_thread` | `letter.threadCount`, `GET …/thread` | |
| `project_code`, `series`, `department`, `branch` | fields: `proje_kodu`, `seri`, `departman`, `sube` | `{Seri}` can also be used in the number pattern |
| `document_number` | the `sayi` field on incoming letters | On outgoing letters, the `belge_no` field (present by default); printed as Document No. in the PDF |
| `date` | the `tarih` field; otherwise the sending / creation date | |
| `state` | status: draft, sent, received, replied, closed, **archived**, **cancelled** | |
| `is_mail_sent` | `letter.mailSentAt` | Timestamp |
| Official Letter (PDF) report | `works/letter-pdf.ts` (pdf-lib) | |
| `mail_template_correspondence` | `.eml` draft and optional SMTP | |

## What is new

### Letter data
- The detail of a correspondence work has a **Letter** section: language, second language, layout, recipient, CC, signature, content, content 2, reference text.
- "Fill from Company" takes the recipient from the counterparty company. Address and email were added to companies (Administration → Companies, migration `0016_yazismalar`).
- On a new letter, if the recipient is empty, the server fills it from the counterparty company.
- Text markup: a blank line starts a new paragraph, a line starting with `- ` is a bullet, `**bold**` is bold text.
- The Turkish text is the main text. Where a translation field is left empty, the Turkish text is printed.
- The letter text can be changed while in draft. On an incoming letter record it can be changed until archive/cancellation.

### Sending rule
- If the letter will be printed in a language other than Turkish, the subject in that language is required before sending. If Turkish content is filled in, its translation is also required. The error message is the same as in Odoo.
- When an outgoing letter is sent, the official letter PDF is generated. It is written to the "Yazılar" (Letters) folder (or to `coverFolderId` if set on the type) as a new file or a new version. It is linked to the work with the `kapak` (cover) role. In the interface it appears as "Official Letter (PDF)".
- When a reply letter is sent, the referenced incoming letter becomes "replied". Opening a reply draft does not change the status.

### Write Reply
- The title becomes `RE: <title>` (not added twice).
- Language, second language and layout are copied. Translated subjects are copied as `RE: …`.
- The `proje_kodu`, `departman` and `konu` fields are copied.
- The recipient is the sender company of the original letter.

### Official letter PDF
- Header: sender company, project.
- Left block: Number / Date / Subject. Headings are combined across languages ("Sayı / Ref"). The date is in each language's format (Turkish `05.03.2026`, others `5 March 2026`).
- Right block: Project (`proje_kodu`), Document No. (if any).
- In the middle, the recipient and address in capitals.
- For each language: the İLGİ (reference) list (a), b), c)…), reference text, content, signature.
- İLGİ line: for an incoming letter, the other side's number and "yazınız" / "Your letter"; for our letter, its number and "yazımız" / "Our letter". Ordered by letter date.
- Bilingual: "Side by Side" gives two columns with a dividing line; "Stacked" puts a horizontal line between the languages.
- Content 2 starts on a new page. The text is wrapped into lines and spread over pages if needed. Each page has the number and page number at the bottom.
- `GET …/letter.pdf` is a preview and is not saved.

### Email
- **Prepare E-mail (.eml):** RFC 5322, UTF-8, multipart/mixed. To = recipient email, Cc = CC list, Subject = `<number> - <subject(s)>`. The body has a separate block for each letter language (the texts from the Odoo template), with a line between them; at the end the signature and company. The official letter PDF is attached. The file opens in the user's email program.
- **Send E-mail:** visible only if `CDE_SMTP_URL` and `CDE_SMTP_FROM` are set (nodemailer). No real sending happens in tests.
- **Mark as Sent:** marked manually if the .eml was sent from the user's program.
- SMTP sending or the mark fills `letter.mailSentAt` and is written to the timeline.

### Statuses
- **Archive:** from sent, received, replied or closed.
- **Cancel Letter:** any letter that is not archived and not cancelled (including replied ones).
- **Return to Draft:** only a cancelled letter.
- **Delete:** only draft or cancelled. The draft's creator or the project manager deletes a draft; the project manager deletes a cancelled one. Other letters are archived.
- Archived and cancelled cannot be chosen from the status list; the buttons enforce the rules. Every action is written to the timeline.
- The built-in types of existing projects are updated once on first use: missing fields and statuses are added. Labels changed by the user are not touched. A field deleted later does not come back (`settings.seededKeys`).

### List
- Quick filters: **Awaiting Reply**, **Not E-mailed**, **Archive**, **Cancelled** (`?view=awaiting|unmailed|archived|cancelled`).
- Grouping: type, status, counterparty company, month (in the browser).

### Correspondence thread
- `GET …/thread`: all works reachable in both directions through reference links, in date order. The work itself is also in the list (like the thread view in Odoo). Works the user cannot see are removed.
- In the detail, `letter.threadCount` is the count excluding the work itself. The interface shows "Correspondence Thread (n)" and "Letters referencing this one".

### AI translation
- `POST …/letter/translate` {language}: returns suggestions for subject, content, content 2 and job title. It does not save; the user checks them in the form and saves.
- The administrator AI policy applies (off / fully local / external provider allowed). If off, 403 `ai_off`; if there is no provider, 503.

### MCP and "Ask"
- `letter` in the `cde_work_get` output: languages, recipient, email status, thread count.
- New read tool `cde_work_thread` (projectId, workId).

## API (new)

All paths are under `/api/v1/projects/:pid/works/:wid`.

| Method and path | Purpose |
|---|---|
| `PUT …/letter` | Save the letter data (partial; translations merge per language, `null` deletes a language) |
| `GET …/letter.pdf[?inline=1]` | Official letter preview |
| `GET …/letter.eml` | Email draft |
| `POST …/letter/mail` | Send via SMTP (only if SMTP is configured) |
| `POST …/letter/mail-sent` | Mark the email as sent |
| `POST …/letter/translate` | Translation suggestion |
| `POST …/archive`, `POST …/cancel`, `POST …/reopen` | Archive, cancel, return to draft |
| `DELETE …` | Delete a draft / cancelled work |

`POST /projects/:pid/works` now also accepts the `letter` field. `GET /projects/:pid/works` accepts the `view` filter. Companies (`POST`/`PATCH /companies`) accept `address` and `email`.

## Not carried over, and why

- **Sharepoint link, `pdf_url`, `visual`:** the CDE's own file links (attachment, cover/official letter PDF) replace them.
- **Multi-company rule (`ir.rule`):** project and company visibility (`canSeeWork`) does the same job.
- **Manager group (delete permission):** project manager permission. The draft's creator can also delete.
- **HTML content:** plain text + light markup was chosen. It gives the same result in PDF and email and needs no editor.
- **Odoo chatter / email composer:** the timeline and the .eml draft. SMTP is optional.
- **Followers, activities:** the assignee, due date and notifications in Works are used.
- **PDF for incoming letters:** Odoo could print a report for every letter. In the CDE the original of an incoming letter is uploaded as an attachment; the official letter is generated only for outgoing letters.
- **`subject_en` … migration:** the CDE has no legacy data.
