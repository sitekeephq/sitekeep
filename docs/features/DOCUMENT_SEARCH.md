# Document search

Search the project's files by name, attribute values and the text of the current version, with
filters, from the **Ara ve Süz** (Search and Filter) panel of Dokümanlar. Searches can be saved, and
a project administrator shares them. Community ([map](../MAP.md#2-community-or-enterprise)); issue
#191.

## The panel

**Dokümanlar → Ara ve Süz** opens a panel on the right (the whole screen on a phone; it closes when
the search runs). The search box in the toolbar still filters the open folder as you type; Enter
searches with the panel's settings.

- **Where:** this folder, all folders, or selected folders (a folder picker); **Alt Klasörler**
  (subfolders, on by default); **İçerikte de Ara** (content too, on by default); **Silinen Öğeler**
  (the recycle bin; project administrators).
- **Recent searches:** the last five searches of this browser, per project (kept in the browser only).
- **Filters:** file types, ISO 19650 state (WIP / Shared / Published / Archived, from the folder),
  suitability and revision code of the current version (`*` allowed: `P01*`), uploader and the
  uploader's company, last updated (current version uploaded or its codes set) and version added (any
  version of the file added in the range) date ranges, version number (`3` or `2-5`), review result
  (approved, approved with comments, reviewed, revise and resubmit, rejected, in review, not
  reviewed), locked for editing (Office Online lock), and attribute filters added with **+ Öznitelik
  ekle** (list, date and number attributes match exactly, text attributes by part).
- **Aramayı Kaydet** saves the search under a name.

## Query language

| Write | Finds |
|---|---|
| `kolon kiriş` | files with both words (AND; `AND` / `VE` may be written) |
| `kolon OR kiriş` | either word (`VEYA` too) |
| `istasyon NOT taslak` | the first without the second (`DEĞİL` too) |
| `(kolon OR kiriş) NOT taslak` | parentheses group |
| `"zemin etüdü"` | the exact phrase |
| `rapor*`, `P01*`, `*tasyon` | `*` stands for any characters |
| `DOC-01-A` | split at `- _ . /`: files with DOC, 01 and A |

Operators count only in capitals, so ordinary words stay words. Every term matches part of the file
name or of an attribute value (Turkish İ/I/ı/i alike). In the **text**, a term finds words that start
with it (`istasyon` finds "istasyonu", `etüt` does not find "zeminetüdü"); start it with `*` to find
it inside words. The panel shows how a query with operators was read ("Aranan: …").

## Results

- The title says where was searched; the number of files; 50 per page with paging.
- Matched terms are highlighted in the name, the excerpt and the attributes.
- A badge says where the file matched: **Ad** (name), **Öznitelik** (attribute), **İçerik** (content).
- The excerpt is clean text (XML/HTML tags and entities removed) around the first match; in a PDF it
  carries the page (**s. 4**).
- Sort by relevance (default with text: name match, name start, attribute, content, then text rank and
  recency), name, date or size, ascending or descending.
- Selected results: **ZIP**, **İnceleme Başlat**, **Gönderim Formu Oluştur** (the chosen files are
  linked to a new transmittal when the transmittals module is on) and delete, as in a folder.

## Saved searches

- Personal by default: in the panel's **Kayıtlı Aramalar** tab and under the folder tree
  (**Kayıtlı Aramalar** node); one click runs one.
- A project administrator shares a saved search with members, companies on the project or the whole
  project (**Paylaş**). The owner and project administrators see whom it is shared with; others see
  only who shared it. The owner and project administrators delete it.
- Only the parameters are stored. Whoever runs a shared search sees only what their own permissions
  allow: selected folders they cannot see are skipped.

## Permissions

The folder permission filter runs inside the database query: the files of folders the caller cannot
read never take part in the count, the ranking, the excerpts or the paging. Upload-only users find
only their own files in those folders, as in the folder listing. The task team WIP rule
([task teams](TASK_TEAMS.md)) applies. A single `folderId` the caller cannot see is 404, as before.
The recycle bin scope needs a project administrator (403 otherwise), like the recycle bin.

## API

`GET /api/v1/projects/:pid/search` (also used by the "Ask" assistant and the file pickers):

| Parameter | |
|---|---|
| `q` | query (at most 200 characters) |
| `content=0` | names and attributes only |
| `folderId`, `subfolders=0` | one folder (with subfolders by default) |
| `folderIds=a,b` | selected folders |
| `ext=pdf,dwg` | file types |
| `attr.<name>=<value>` | attribute filter |
| `state=wip,shared` | ISO 19650 state |
| `suitability=S2,A1`, `revision=P01*` | codes of the current version |
| `uploadedBy=<user ids>`, `company=<company ids>` | uploader, uploader's company |
| `updatedFrom`, `updatedTo`, `addedFrom`, `addedTo` | days (YYYY-MM-DD, `REPORT_TZ`, default Europe/Istanbul) |
| `version=3` or `2-5` | current version number |
| `review=approved,pending,none` | review result |
| `locked=1`, `trash=1` | locked files; recycle bin |
| `sort=relevance\|name\|date\|size`, `dir=asc\|desc`, `offset`, `limit` (≤ 1000, default 200) | order and paging |

The answer: `results` (file, `folderPath`, `snippet`, `page`, `matchedIn`, `deletedAt` in the bin),
`total`, `offset`, `limit`, `truncated` (another page exists) and `terms` (to highlight).

Saved searches: `GET/POST /projects/:pid/saved-searches`, `PATCH/DELETE …/:id`, `PUT …/:id/shares`
(`{ shares: [{ subjectType: "user" | "company" | "project", subjectId }] }`, project administrators;
audited as `saved_search.shared`).

MCP / AI tools: **`cde_documents_search`** takes the query and the main filters (folder, content,
types, attributes, states, suitability, revision, updated range, review result, sort, paging).

## How it works

- Matching: names and attribute values with `LIKE` on folded text; on PostgreSQL the `pg_trgm` GIN
  indexes of migration 0061 serve them. Text: `version_texts.tsv`, a generated `tsvector` (simple
  configuration, folded like `foldTr`, `/ - _ . , ; :` read as spaces, the first 100 000 characters)
  with a GIN index finds word prefixes; a phrase or a code with punctuation is then checked with
  `LIKE`, an inner `*` against the words of the text, and a leading `*` with `LIKE` alone (trigram
  index). Each term's text matches are computed once per query.
- There is no 5 000-row scan limit any more; the count is exact.
- PGlite (tests, small installs) runs the same queries; it has no `pg_trgm`, so the trigram part
  scans.
- PDF text keeps a form feed between pages, which gives the page of a match. PDFs indexed before
  this change show no page until their text is read again.

### Measured

`npm run perf:search -w @sitekeep/server` (DATABASE_URL = an empty PostgreSQL database) seeds 50 000
files with 100 000 versions and text for each current version, then times searches through the API:
see the pull request for the figures. Queries matching a word or code stay well under a second; a
leading or inner `*` matched against nearly every text of a 100 000-version project takes one to
three seconds.

## Not yet

Fields of the naming standard as filters, OCR of scanned PDFs, one box searching issues, RFIs and
correspondence, and IFC property search are follow-ups of issue #191.

Tests: `apps/server/test/documents/search.test.ts` (also against PostgreSQL with
`SEARCH_TEST_DATABASE_URL`), `apps/server/test/documents/docs-plus.test.ts`,
`packages/shared/test/search.test.ts`, `e2e/specs/document-search.spec.ts`,
`e2e/specs/mobile-document-search.spec.ts`.
