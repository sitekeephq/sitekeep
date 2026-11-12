# Office integration (browser editing and PDF conversion)

LibreOffice is no longer part of the CDE image. Office files open in the browser viewers.
There are two **optional** add-ons. A system administrator enables both:

1. **Browser editing (WOPI).** Word, Excel, PowerPoint and ODF files are edited inside the CDE.
   Editor: **ONLYOFFICE Docs** or **Collabora Online**. Both use the same WOPI code.
2. **Office → PDF conversion.** For PDF view, markup, visual revision comparison and batch PDF on Office files.
   Converter: ONLYOFFICE, Collabora or **Gotenberg**. Last resort: LibreOffice (soffice), if installed on the server.

Settings: **Administration → Office Integration**.

## Options

| | ONLYOFFICE Docs | Collabora Online (CODE) | Gotenberg |
|---|---|---|---|
| Licence | AGPL-3.0 | MPL-2.0 | MIT |
| Browser editing | Yes | Yes | No |
| Office → PDF | Yes (ConvertService) | Yes (convert-to) | Yes |
| Fidelity to Microsoft formats | Best (docx/xlsx/pptx) | Good | Good (LibreOffice) |
| ODF and legacy formats (doc/xls/ppt) | Views them; editing needs conversion (not supported) | Edits them | Converts them |
| Limit | Free edition: 20 concurrent connections (documented) | No connection limit; shows a warning under load | — |
| Docker image (arm64, download / disk) | `onlyoffice/documentserver` 1.4 GB / 5.0 GB | `collabora/code` 0.5 GB / 1.7 GB | `gotenberg/gotenberg:8` 0.7 GB / 2.5 GB |
| Idle memory | ≈ 1.0 GB | ≈ 0.55 GB | ≈ 40 MB |
| Authentication | JWT (secret key) + WOPI proof | WOPI proof (you add the key), `aliasgroup` | Optional basic authentication |

Recommendation:
- **ONLYOFFICE** if the team mostly works with Word/Excel.
- **Collabora** if you have many ODF and legacy files, or 20 connections are not enough.
- **Gotenberg** if PDF view and markup are enough (no editing).

If the converter is "Automatic", the editor's server is used. Without an editor, soffice on the server is tried. If that is missing too, the preview becomes "no tool" (`unavailable`).

## Installation (docker compose profiles)

The main image stays the same. The editors are separate services and are enabled with a profile.

### ONLYOFFICE

`.env`:

```ini
CDE_OFFICE_EDITOR=onlyoffice
CDE_OFFICE_EDITOR_URL=http://onlyoffice
CDE_OFFICE_EDITOR_PUBLIC_URL=http://SERVER-NAME:8081
ONLYOFFICE_JWT_SECRET=a-long-random-secret
```

```sh
docker compose --profile onlyoffice up -d
```

- Compose starts ONLYOFFICE with `WOPI_ENABLED=true`, `JWT_ENABLED=true` and the same `JWT_SECRET`.
- `ALLOW_PRIVATE_IP_ADDRESS=true` is required: ONLYOFFICE downloads the file from the CDE on the Docker network (`http://app:8080`).
- `CDE_OFFICE_EDITOR_PUBLIC_URL` is the address the browser uses to reach ONLYOFFICE. The CDE replaces the internal address in the discovery with it.
- ONLYOFFICE's sample WOPI keys are the same in every installation. In production, generate your own keys for `wopi.privateKey`/`publicKey`.

### Collabora Online

`.env`:

```ini
CDE_OFFICE_EDITOR=collabora
CDE_OFFICE_EDITOR_URL=http://collabora:9980
COLLABORA_SERVER_NAME=SERVER-NAME:9980
COLLABORA_ADMIN_PASSWORD=change-me
```

```sh
docker compose --profile collabora up -d
```

- `aliasgroup1` = the CDE address as seen from Collabora (`CDE_WOPI_BASE_URL`, default `http://app:8080`). No other address is allowed.
- `server_name` = the name and port the browser uses to reach Collabora. Discovery addresses come with it.
- **`CDE_PUBLIC_HOST` is required:** the CDE's name in the browser (e.g. `cde.company.com` or `SERVER-NAME:*`). Compose passes it
  as `--o:net.frame_ancestors`. Without it, Collabora only allows framing by the `aliasgroup` names;
  the browser blocks the editor (empty white area, a `frame-ancestors` error in the console). Collabora 26.04 warns that this setting is
  "deprecated" but applies it; the new way is to write `frame-ancestors …;` into `net.content_security_policy`.
- **Proof key:** the `collabora/code` image has no key; requests arrive unsigned and the CDE cannot verify the signature
  ("Test Connection" shows this). Generate a key and mount it:
  `ssh-keygen -t rsa -N "" -m PEM -f ./collabora/proof_key`, then uncomment the `volumes` lines in compose.
- Behind an HTTPS reverse proxy: `COLLABORA_EXTRA_PARAMS=--o:ssl.enable=false --o:ssl.termination=true`.
- The reverse proxy must allow WebSocket under `/cool/`.
- PDF conversion (`/cool/convert-to`) only works from allowed IPs (`net.post_allow`). The default private networks (10.x, 172.16–31.x, 192.168.x) are enough for Docker.

### Gotenberg (PDF only)

`.env`:

```ini
CDE_OFFICE_CONVERTER=gotenberg
CDE_OFFICE_CONVERTER_URL=http://gotenberg:3000
```

```sh
docker compose --profile gotenberg up -d
```

Gotenberg exposes no port to the outside; only the CDE reaches it.

### Next

1. Open **Administration → Office Integration**. Values from the environment are shown; a value you save here takes precedence.
2. **The CDE Address as Seen by the Editor**: the address the editor container uses to reach the CDE (`http://app:8080` in Docker).
   If empty, the address in the browser is used.
3. **Test Connection**: discovery, proof key, converter status and a real trial conversion (TXT → PDF).
4. In a non-Docker installation, enter the addresses manually (e.g. `https://office.company.com`).

The Docker image has no LibreOffice. LibreDWG (DWG → DXF) remains.

## How it works

- The file drawer shows an **Edit** button. Conditions: an editor is configured, the format is editable in the editor's discovery, and the user can upload a new version.
- The button opens the `/p/:pid/edit/:fileId` page. The page requests a WOPI session from the server and loads the editor into an iframe with a form POST (`access_token`, `access_token_ttl`).
- The editor reads the file over WOPI. Each save (PutFile) becomes **a new CDE version**. Version note: "Edited in the browser (ONLYOFFICE)".
- The new version goes through **the same service** as an upload: folder permission, approval gate, naming standard, required attributes.
  Attributes are kept. Preview, text extraction (search, "Ask", MCP) and the audit log work as for an upload.
- A save with unchanged content does not create a new version.
- While editing is in progress the file is locked (WOPI LOCK, 30 minutes, renewed by the editor). The drawer shows "**X is editing**".
  During this time no new version can be added by upload. A project manager can remove a stuck lock.
- When the editor closes, the drawer loads the new versions automatically.
- Collabora: if the file changed in the CDE in the meantime, the save is rejected with 409; the editor asks the user.
- Collabora autosaves also become versions (with an "autosave" note). The frequency is set in Collabora with `per_document.autosave_duration_secs`.

### Approval and review rules

- In an approval-gated folder (files arrive only through an approved review), editing is disabled; uploading is disabled too.
  An open editor session also loses its write permission.
- Reviews are tied to a version. The version in a review does not change; editing creates a new version (working version). Uploading works the same way.
- A user with view permission but no upload permission cannot edit. Without download permission, printing, exporting and copying are disabled in the editor.

## Security

### Access tokens

- A 256-bit random token is generated for each editor session. Only its SHA-256 is stored in the database.
- The token is bound to one user, one file and its project. It is not valid for another file (401).
- Default lifetime is 10 hours (1–24 hours from the administration page). An expired token gets 401.
- On every WOPI call the user's **current** permission is recomputed. A user removed from the project gets 404. A user whose permission dropped cannot write.
- The WOPI endpoints are outside `/api/v1`. The session cookie and API tokens are not valid there. Only the WOPI token is.
- API tokens (MCP, scripts) cannot open an editor session; only a browser session can.

### Proof key (X-WOPI-Proof)

- The editor signs every request with its own private key. The CDE verifies the signature with the public key from the discovery (RSA-SHA256).
- Valid: current key, old signature header (`X-WOPI-ProofOld`) or old key. When the key rotates, the discovery is read again.
- If the timestamp is older than 20 minutes, the request is rejected (500, WOPI rule).
- The signature is computed over the URL. If a reverse proxy changes the address, enter "The CDE Address as Seen by the Editor" correctly.
- Verification is on by default. Turn it off only when troubleshooting (`CDE_WOPI_VERIFY_PROOF=0` or the administration page).

### Network

- Files are sent only to the address the administrator entered. Even if the ONLYOFFICE result URL points to another host, the download is made from the configured server.
- Redirects are not followed.
- For ONLYOFFICE conversion, the source file is served from `/wopi/convert/<ticket>`. The ticket is random, valid for one file and 10 minutes; it is deleted when the conversion finishes.
- The WOPI endpoints (`/wopi/...`) must be reachable from the editor server. They do not need to be exposed to the internet; allow only the editor server in the firewall.
- The ONLYOFFICE JWT secret and the Gotenberg password are stored encrypted with AES-256-GCM in the database (like the AI keys, `CDE_SECRET_KEY`).
- The editor iframe opens with `sandbox`. postMessage is accepted only from the editor's address.

## Endpoints

| Endpoint | What it does |
|---|---|
| `GET /api/v1/admin/office` | Settings (no secret values) and active status. |
| `PUT /api/v1/admin/office` | Saves the settings. |
| `POST /api/v1/admin/office/test` | Connection test. |
| `GET /api/v1/projects/:pid/files/:id/office` | Is it editable, who is editing. |
| `POST /api/v1/projects/:pid/files/:id/office/session` | WOPI token and editor address (`mode`: `edit` / `view`). |
| `DELETE /api/v1/projects/:pid/files/:id/office/lock` | Removes a stuck lock (project manager). |
| `GET /wopi/files/:id` | CheckFileInfo. |
| `GET /wopi/files/:id/contents` | GetFile (current version). |
| `POST /wopi/files/:id/contents` | PutFile → new version. |
| `POST /wopi/files/:id` | `X-WOPI-Override`: LOCK, UNLOCK, REFRESH_LOCK, GET_LOCK. PUT_RELATIVE, RENAME_FILE, DELETE → 501. |
| `GET /wopi/convert/:ticket/:name` | ONLYOFFICE conversion source. |

Database: `wopi_tokens`, `wopi_locks`. Migration: `apps/server/drizzle/0019_wopi.sql`.
Settings are stored in `system_settings` under the `office.integration` key.

## Environment variables

Environment variables are only defaults. A value saved on the administration page takes precedence.

| Variable | Meaning |
|---|---|
| `CDE_OFFICE_EDITOR` | `onlyoffice` or `collabora` |
| `CDE_OFFICE_EDITOR_URL` | The editor's address from the CDE server (e.g. `http://onlyoffice`) |
| `CDE_OFFICE_EDITOR_PUBLIC_URL` | The editor's address from the browser (if different) |
| `CDE_OFFICE_CONVERTER` | `auto`, `onlyoffice`, `collabora`, `gotenberg`, `local`, `none` |
| `CDE_OFFICE_CONVERTER_URL` | Converter address (if empty, the address of the editor of the same type) |
| `CDE_OFFICE_JWT_SECRET` | ONLYOFFICE JWT secret (`ONLYOFFICE_JWT_SECRET` in compose) |
| `CDE_GOTENBERG_AUTH` | Gotenberg basic authentication, `user:password` |
| `CDE_WOPI_BASE_URL` | The CDE address as seen by the editor (compose default `http://app:8080`) |
| `CDE_WOPI_VERIFY_PROOF` | `0` turns proof verification off |
| `CDE_CONVERT_TIMEOUT_MS` | Default conversion time limit (180000) |

For the compose profiles: `ONLYOFFICE_TAG`, `ONLYOFFICE_PORT` (8081), `COLLABORA_TAG`, `COLLABORA_PORT` (9980),
`COLLABORA_SERVER_NAME`, `COLLABORA_EXTRA_PARAMS`, `COLLABORA_ADMIN_USER`, `COLLABORA_ADMIN_PASSWORD`, `GOTENBERG_TAG`.
In production, pin the image tags (a version instead of `latest`).

## Converter limits

- Time limit (default 180 s), maximum file size (100 MB), concurrent conversions (2) and retries (2) are configurable.
- Network errors, 429 and 5xx are retried. 4xx and timeouts are not.
- If the converter cannot be reached, the preview becomes `unavailable`; this is not counted as a file error. **Try Again** queues it again.

## Limitations

- No new file creation and no "save as" (PUT_RELATIVE). Renaming is not done from the editor.
- In ONLYOFFICE, editing doc/xls/ppt requires "convert and edit"; this is not supported (the files are viewed).
- "X is editing" shows the first person who took the lock. Other users co-editing are not listed.
- `npm test` does not run a real editor: it works with a mock server and discovery files taken from real versions.
  The manual trial with real editors is below.
- Collabora's save on close depends on the editor. "Close" first asks Collabora to save if there are changes (waits at most 5 s).
- The converters write numbers in US format (1,234.50); Turkish format (1.234,50) does not appear in the PDF.
- ONLYOFFICE 9.x also reports PDFs as "editable"; the CDE does not show the Edit button on PDFs (PDFs work with markup).

## Real test results (10.10.2026)

Environment: Windows 11 arm64 development machine, Docker Engine 29.1.2 (linux/arm64, 12 cores, 16 GB).
CDE development server `wopi.localhost:8797`; the containers reached the CDE via `host.docker.internal:8797`.
Versions: ONLYOFFICE Docs **9.4.0** (arm64), Collabora CODE **26.04.5.1** (arm64), Gotenberg **8.37.0** (arm64).
All three images have an arm64 build and ran without problems.

### What worked

| Check | ONLYOFFICE 9.4 | Collabora 26.04 | Gotenberg 8.37 |
|---|---|---|---|
| Discovery | 29 formats editable; proof key present | 40 formats editable; **no proof key** (present once the key is mounted) | — |
| DOCX / XLSX / PPTX open in the editor | Yes / Yes / Yes | Yes / Yes / Yes | — |
| Save → new CDE version | Yes (DOCX, PPTX; note "Edited in the browser (ONLYOFFICE)") | Yes (DOCX, XLSX) | — |
| X-WOPI-Proof verification | Passed | Passed once the key was mounted | — |
| Lock / "X is editing" | Yes; the lock is released after the save | Yes; the lock is released together with the save | — |
| Upload blocked while locked | Yes | Yes | — |
| Approval-gated folder | Edit disabled (403); a read-only session opens | Edit disabled; "Read-only" opens, no lock is taken | — |
| Name not matching the naming standard | Edit disabled (403) | Edit disabled (403) | — |
| Search text from the new version | Yes (including PPTX speaker notes) | Yes | — |
| Office → PDF preview | Yes (ConvertService, JWT) | Yes (convert-to) | Yes |
| The editor's own "Close" button | UI_Close arrives, returns to the file | Not tried (the CDE "Close" button was tried) | — |
| "Test Connection" | All green | Proof key step red (without a key) | All green |

### Bugs found and fixed

1. **The save arrives after closing.** ONLYOFFICE saves ≈ 5–6 s after the last user leaves. Collabora sends the save
   at the same moment as the close. The drawer was showing the old version. Fix: when the editor page closes, the drawer waits for the new
   version ("Waiting for the editor's last save…") and refreshes the list when it arrives. If the lock is released and nothing
   has arrived within 20 s, the wait ends (no changes were made); the upper limit is 60 s.
2. **Collabora sends UNLOCK without waiting for the PutFile response.** If the order was reversed, the save could be
   lost with "not locked" (409). Fix: the lock is not deleted on UNLOCK; its expiry is set to "now"; a save arriving with the same lock within 60 s
   is accepted (test: `wopi.test.ts`).
3. **The Collabora frame was blocked in the browser** (`frame-ancestors`). Fix: `CDE_PUBLIC_HOST` →
   `net.frame_ancestors` in compose; if the editor does not open within 25 s, the page shows an explanatory warning.
4. **The Collabora image has no proof key.** Documented; key mount lines were added to compose.
5. **ONLYOFFICE conversion** is now requested synchronously (`async: false`); the polling loop runs only for long conversions.
6. In a read-only session the header says "Read-only: changes are not saved."
7. The real discovery files (ONLYOFFICE 9.4, Collabora 26.04) became test fixtures. ONLYOFFICE 9.x, like Collabora, publishes
   apps named by MIME type; the parser reads both.

### Timings (arm64, warmed up)

Direct request to the converter (range of 3 runs):

| File | Gotenberg | Collabora | ONLYOFFICE |
|---|---|---|---|
| DOCX, 2 pages | 0.14–0.22 s | 0.10–0.26 s | 1.0 s |
| DOCX, 23 pages | 0.28–0.30 s | 0.24–0.37 s | 2.0 s |
| PPTX, 1 slide | 0.23 s (first: 0.79) | 0.25 s | 1.0 s |
| XLSX | 0.12 s | 0.11 s | 1.0 s |
| 4 × 23 pages concurrently | 1.2 s | 0.3 s | 5.0 s |

- ONLYOFFICE ConvertService reports the result in 1 s steps; that is why the times come out as 1.0 / 2.0 s. It queues
  concurrent conversions.
- In the CDE, "upload → PDF ready" adds ≈ 1 s to the above (job queue and reading the PDF text): Gotenberg and Collabora
  ≈ 1.1–1.4 s, ONLYOFFICE ≈ 1.9–2.9 s.
- Container ready: Gotenberg 1.5 s, Collabora ≈ 8 s, ONLYOFFICE ≈ 7 s (healthcheck).
- Editor opening (server side, CheckFileInfo → lock): Collabora ≈ 0.3 s, ONLYOFFICE ≈ 1.3 s.
- Close → new version: Collabora < 1 s, ONLYOFFICE ≈ 6 s.

### Appearance (converted PDFs)

- Turkish characters are correct in all three converters. Carlito (metric-compatible) is used instead of Calibri; page counts
  are the same (2 and 23 pages).
- DOCX: all three are nearly identical. Collabora draws the table header slightly bolder with Liberation Sans.
- XLSX: formulas are recalculated (the total is correct). Numbers are in US format (1,234.50). The ₺ sign is correct.
- PPTX: all three are the same; ONLYOFFICE uses Arial, the others Liberation Sans.

### 20-connection limit (ONLYOFFICE)

- `http://127.0.0.1:8000/info/info.json` (only from inside the container) showed `quota.edit.connectionsCount = 1`
  with one editor open. While three conversions ran concurrently, the count stayed at 1: **conversion requests do not count as connections.**
- The 9.4.0 Community licence info shows `hasLicense: false` and `connections: 2147483647`. The limit of 20 was not
  reached in this test (20 separate browser sessions were not opened); the documented limit is 20 concurrent editing connections.

### Not tried

- XLSX save in ONLYOFFICE, PPTX save in Collabora (opening was tried). Because browser automation cannot type into nested frames,
  the ONLYOFFICE save was done by opening the editor address in a separate tab; the drawer waiting for the save was tried from the CDE page.
- HTTPS reverse proxy, more than 20 concurrent ONLYOFFICE sessions, large (100 MB+) files.
