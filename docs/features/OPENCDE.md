# SiteKeep — OpenCDE and OAuth2

This document describes the live part of OpenCDE compliance. The research and the full plan are in `docs/archive/research/OPENCDE_ARASTIRMA.md`.

## 0. Status

| Part | Status | Note |
|---|---|---|
| Foundation API 1.1 + built-in OAuth2 | ✓ Live | §1 |
| Documents API 1.0 | ✓ Live | §1, §3a. Document upload, selection, download, version query |
| BCF file (.bcfzip 2.1 / 3.0) import / export | ✓ Live | `docs/features/BCF.md`. File exchange, not an API |
| BCF API 3.0 (live connection, e.g. Solibri BCF Live) | Pending | §6. The `CDE_OPENCDE_APIS=bcf` flag must stay off |

## 1. What is live

**OpenCDE Foundation API 1.1** (at the root address, outside `/api/v1`):

| Endpoint | What it does |
|---|---|
| `GET /foundation/versions` | Lists the OpenCDE APIs offered: `foundation 1.1` and `documents 1.0`. |
| `GET /foundation/1.1/auth` | Returns the OAuth2 addresses. Flow is `authorization_code_grant` only. `http_basic_supported: false`. No dynamic client registration. |
| `GET /foundation/1.1/current-user` | Returns the owner of the access token: `id` = email, `name`. Without a token, `401`. |

- Responses are JSON. Errors have the form `{ "message": "…" }` (`error.json` in the specification).
- Absolute addresses are built from `CDE_PUBLIC_URL`. If the variable is not set, the address the request came to is used.
- `api_base_url` is the full address of each API, e.g. `https://cde.company.local/foundation/1.1`.
- CORS headers are set for browser clients (`*`, no cookies).
- An unknown version (`/foundation/1.0/auth`) returns a JSON `404`.
- The list is data-driven (`apps/server/src/oauth/foundation.ts`, `OPENCDE_APIS`). Documents 1.0 is always announced.
  The BCF 3.0 entry is ready but is not announced until the flag is on: `CDE_OPENCDE_APIS=bcf`. **Do not turn the flag on before the BCF API goes live.**

**OpenCDE Documents API 1.0** (`api_base_url` = `<root>/documents/1.0`, specification:
https://github.com/buildingSMART/documents-API). Field names match `swagger.yaml` exactly.

| Endpoint (relative to base) | Counterpart in the specification | What it does |
|---|---|---|
| `POST /upload-documents` | `/upload-documents` | Takes `callback`, `files[]` (`file_name`, `session_file_id`, optional `document_id`); returns `upload_ui_url`, `expires_in`, `max_size_in_bytes`. |
| `POST /upload-sessions/{id}` | `upload_documents_url` | Takes file sizes; returns `documents_to_upload[]` (`upload_file_parts`, `upload_completion`, `upload_cancellation`). |
| `PUT` (or `POST`) `/upload-sessions/{id}/files/{fid}/parts/{n}` | `upload_file_parts[].url` | One part. 16 MB parts, `content_range_start/end` bounds inclusive, in any order. |
| `POST /upload-sessions/{id}/files/{fid}/completion` | `upload_completion` | Joins the parts, saves through the normal upload service, returns `DocumentVersion`. Calling it again gives the same result. |
| `POST /upload-sessions/{id}/files/{fid}/cancellation` | `upload_cancellation` | Deletes the parts, `204`. |
| `POST /select-documents` | `/select-documents` | Takes `callback`, optional `server_context`, `supported_file_extensions`; returns `select_documents_url`, `expires_in`. |
| `GET /selections/{id}` | `selected_documents_url` | `server_context` and the selected `documents[]` (`DocumentVersion`). |
| `GET /documents/{document_id}/versions` | `document_versions` | All versions, newest first. |
| `GET /documents/{document_id}/versions/{n}` | `document_version` | A single version. |
| `GET /documents/{document_id}/versions/{n}/metadata` | `document_version_metadata` | `metadata[]` (`name`, `value[]`, `data_type`): project, folder, version, uploader, date, size, SHA-256, description, attributes. |
| `GET /documents/{document_id}/versions/{n}/download` | `document_version_download` | The file itself (`200`, no redirect). Requires download permission. |
| `POST /document-versions` | `/document-versions` | `document_ids[]` → latest versions. `ETag` + `If-None-Match` → `304`. |

- `document_id` = the file ID in the CDE, `version_index` = version number, `version_number` = `v3`,
  `title` = file name without extension (document code), `document_details` = the file's page in the CDE.
- `server_context` is an opaque value: the last project and folder worked in. If the client sends it back in the next session, the page opens there.
  It is ignored if the user can no longer see that project.
- `include_authorization: true`: the parts go to the same server and need the Bearer token. No external storage; no external calls are made.
- `multipart_form_data` is not sent (the part body is plain binary). `additional_headers` contains only `Content-Length`.
- Errors are `{ "error", "message" }`. Expired session `410`, someone else's session `404`, missing permission `403`, no Bearer `401`.
- CORS: `*` on every endpoint (cookies are not accepted; these endpoints cannot be called with a browser session).

**CDE pages** (addresses the application opens in the browser, `apps/web/src/features/integrations/pages/OpenCdeDocuments.tsx`):

- `/opencde/upload?key=…` → **Upload from an External Application**: the requesting application (OAuth application name), incoming files, project and
  only the folders with write permission, a "Name in the CDE" per file (checked instantly against the naming standard),
  **Revision**, **Status / Suitability** (S0–S4, A, B), **Description**, project attributes tied to the folder. **Cancel** or
  **Start Upload**. The server checks everything again; errors are shown on the file row.
- `/opencde/select?key=…` → **Select Documents for an External Application**: project, folder tree, search by name, multiple selection, filter for the requested
  extensions (e.g. only `.ifc`). **Cancel** or **Send Selection**.
- If the user is not signed in, the sign-in page comes first, then the same page opens.
- Revision and Status / Suitability are written to the file's `Revizyon` and `Uygunluk` attributes. If the project defines attributes with these names,
  the fixed field is hidden and the project's definition (list, required) is used. Description is the version description.

**Built-in OAuth2 authorization server:**

| Endpoint | What it does |
|---|---|
| `GET /oauth2/authorize` | Authorization code flow. PKCE (S256). Without a session, the sign-in page, then the consent page. |
| `POST /oauth2/token` | `authorization_code` and `refresh_token`. The refresh token is rotated on every use. |
| `POST /oauth2/revoke` | RFC 7009 revocation. If a refresh token is given, the whole family is revoked. |

- Implicit flow, password sign-in (ROPC) and client credentials are **not supported**.
- Parameters may be in the form body or in the query string (the bSI example uses the query).
- Both `redirect_uri` and `redirect_url` are accepted.
- In the token request `redirect_uri` is optional (the bSI example does not send it). If sent, it must match exactly.
- Client authentication: HTTP Basic or `client_secret_post`. The two cannot be used together.
- PKCE is required for public clients and optional for confidential clients. Only `S256`.
- A confidential client that does not use PKCE must send `state`.
- The authorization code is single-use and valid for at most 60 seconds. It is bound to the client, the redirect address and the PKCE value.
- The access token is valid for 1 hour, the refresh token for 30 days.
- Response: `access_token`, `token_type: "Bearer"`, `expires_in`, `refresh_token`, `scope`.

**Web interface:**

- Consent page `/oauth/consent`: "<Application> wants to access your account", permissions, **Approve** / **Deny**.
  It does not open inside another site's frame.
- Consent is remembered per user + application. The page is not shown again for the same permissions (except with `prompt=consent`).
- **My Account → Connected Applications**: application, permissions, last use, **Remove Access**.
- **Administration → OAuth Applications**: registration, editing, disabling, secret rotation, deletion, connection details.

## 2. Permissions (scope)

| Scope | Meaning |
|---|---|
| `read` | The existing `/api/v1`, read-only (same as "Read Only" on an API access token). |
| `write` | The existing `/api/v1`, read + write. |
| `bcf` | OpenCDE BCF API (when it arrives). |
| `documents` | The whole OpenCDE Documents API: upload (new document, new version), document selection, versions, metadata, download, version query. Shown as "OpenCDE Documents" on the consent page. AEC Pilot requests this. |
| `documents:read` | Only selection, versions, metadata, download, version query; upload returns `403`. Shown as "OpenCDE Documents (read)" on the consent page. For read-only tools (viewers). |

- If the client sends no `scope`, it requests all registered permissions.
- A token that has only `bcf`/`documents`/`documents:read` cannot access `/api/v1` (`403`). `current-user` works.
- `read`/`write` do not grant access to the Documents API. Personal API access tokens (My Account) can also use the Documents API:
  "Read Only" selects and downloads, "Read + Write" also uploads. A token always works with the user's own folder permissions.
- Unknown scope names (e.g. `openid`) are ignored. A known scope that is not registered returns `invalid_scope`.

## 3. How to register an application (Solibri example)

1. **Administration → OAuth Applications → + Application**.
2. Name: `Solibri Office`. The description appears on the consent page.
3. Type: **Public Client** for a desktop application (PKCE required). If Solibri asks for a secret, choose **Confidential Client**.
4. Redirect address: the address Solibri provides. Desktop applications usually use `http://127.0.0.1/…` or
   `http://localhost/…`. These addresses match any port (RFC 8252). Other addresses must match exactly and must be https.
5. Permissions: `BCF Issues` + `Read` (`Write` if needed).
6. **Save**. For a confidential client the secret is shown **once**. Copy it.
7. The **Connection Details** button on the row shows what Solibri's private connection form asks for:
   server address (Foundation URL), authorization address, token address, `client_id`, redirect address. All can be copied.
8. In Solibri, enter the root address as the server address (e.g. `https://cde.company.local`). It finds the rest through `/foundation/versions` and
   `/foundation/1.1/auth`.

Note: Solibri BCF Live requires BCF API 3.0. This version has Foundation, OAuth and the Documents API; BCF is only
imported and exported as a .bcfzip file (`docs/features/BCF.md`, see §6).

## 3a. Uploading from AEC Pilot and other tools

A recipe for AEC Pilot's (Revit / Civil 3D) **Send to CDE** button and similar desktop tools. `<root>` = the server address the user
entered (e.g. `https://cde.company.local`).

**Once (administrator):** Administration → OAuth Applications → **Add AEC Pilot** (one click). Ready-made entry: Name `AEC Pilot`, type
**Public Client** (PKCE, no secret), redirect address `http://127.0.0.1/aecpilot/opencde/oauth` (any port, path
exact), permission **OpenCDE Documents** (`documents`). Copy the `cde-…` client ID from the Connection Details that open and
paste it into AEC Pilot (no dynamic client registration). Manual registration with the same values also works.

**Connecting (once per user, then the refresh token):**

1. `GET <root>/foundation/versions` → the `api_base_url` of the `documents 1.0` entry (= `<docs>`, e.g. `<root>/documents/1.0`).
2. `GET <root>/foundation/1.1/auth` → `oauth2_auth_url`, `oauth2_token_url`.
3. The tool opens a free local port (e.g. `http://127.0.0.1:53682/aecpilot/opencde/oauth`) and opens `oauth2_auth_url` in the browser with
   `response_type=code`, `client_id`, `redirect_uri`, `scope=documents`, `state`, `code_challenge` (S256).
4. The user signs in and clicks **Approve**. The browser returns to `redirect_uri?code=…&state=…`.
5. `POST oauth2_token_url` (`grant_type=authorization_code`, `code`, `client_id`, `redirect_uri`, `code_verifier`) →
   `access_token` (1 hour), `refresh_token` (30 days, rotated on every use; store the new one).

**Upload (every "Send to CDE"):**

1. Start the IFC export (no need to wait for it to finish).
2. Open a local port; `POST <docs>/upload-documents` (Bearer):
   `{"callback":{"url":"http://127.0.0.1:<port>/<random>/","expires_in":3600},"server_context":"<previous value or none>","files":[{"file_name":"model.ifc","session_file_id":"<guid>"}]}`.
   If it is a new version of the same document, add `"document_id":"<document_id from the previous response>"` to the file.
3. Open the `upload_ui_url` from the response in the default browser (within `expires_in` seconds; default 10 minutes, single-use).
4. On the page, the user chooses the folder, name, revision and status and clicks **Start Upload**. The browser
   comes to `http://127.0.0.1:<port>/<random>/?upload_documents_url=…` (URL-encoded). On **Cancel**, `?user_cancelled_upload=true` arrives.
   Return a short "Done, you can go back to CAD" page to the browser.
5. `POST <upload_documents_url>` (Bearer) `{"files":[{"session_file_id":"<guid>","size_in_bytes":<size>}]}` →
   `server_context` and `documents_to_upload[].upload_file_parts`.
6. For each part: to `url` with `http_method`, the file bytes `content_range_start`–`content_range_end` (inclusive),
   with Bearer because `include_authorization: true`. Parts can be sent in parallel or in any order.
7. `POST <upload_completion.url>` (no body, Bearer) → `DocumentVersion`. Store the `document_id` and the `server_context` from step 5:
   the next send becomes a new version and the page opens in the same folder.
8. If the user gives up, `POST <upload_cancellation.url>` → `204`.

**Selection / download:** `POST <docs>/select-documents` `{"callback":{…},"supported_file_extensions":[".ifc"]}` →
open `select_documents_url` in the browser → `?selected_documents_url=…` (or `?user_cancelled_selection=true`) →
`GET` (Bearer) → download from `documents[].links.document_version_download.url`. For freshness use
`POST <docs>/document-versions` `{"document_ids":[…]}` and `If-None-Match`.

**Callback rules:** `callback.url` must match the application's registered redirect address exactly. Desktop applications with a registered loopback
address (`http://127.0.0.1/…`, `http://localhost/…`) may use any loopback port and path
(RFC 8252). An https web application only returns to its registered address. There is no redirect to any other address;
addresses containing `#`, a user name or a password are rejected. With personal API tokens, loopback only.

**Durations and limits:** the page link must be opened within 10 minutes at most and only works in the first browser session that opens it
(another user or another browser gets `403`). After the page is submitted, the instructions, parts and completion are valid for 24 hours.
`callback.expires_in` counts as 24 hours at most; once it passes, the page cannot be submitted (`410`). A single file at most
`max_size_in_bytes` (the server's upload limit, default 20 GB), at most 50 files per session, at most 200 documents in a selection.

**What happens:** completion uses the normal upload service (`addVersion` + `afterVersionAdded`): folder permission, review
gate, naming standard, required attributes, a new version if a file with the same name exists, IFC → Fragments, preview and
search text jobs, audit log (`file.uploaded` / `file.version_added`, `via: "opencde-documents"`). If permissions changed after the page
was submitted, completion is rejected.

**Audit log:** `opencde.upload_started`, `opencde.upload_prepared`, `opencde.upload_instructions`,
`opencde.upload_completed`, `opencde.upload_cancelled`, `opencde.select_started`, `opencde.documents_selected`,
`opencde.selection_read`, `opencde.select_cancelled`, downloads `file.downloaded` (`via: "opencde-documents"`).

**Contract test:** `apps/server/test/opencde-documents.test.ts` → "meets the AEC Pilot Send to CDE contract" replays AEC Pilot's
request sequence exactly (discovery, ready-made OAuth entry, upload-documents, page, callback with a random path, instructions,
two parts, additional headers, prefix/suffix framing if `multipart_form_data` is present, completion, two cancellation paths, error format).
SiteKeep does not send `multipart_form_data`; the client's framing step stays empty.

**Left out of the specification:** external storage and `multipart_form_data` (not needed, everything is local), keeping the connection alive with
whitespace on long completion requests (completion is a local join and is short), `303`
redirect on download (direct `200`), selecting an old version on the selection page (the latest version is always selected; old
versions are reached through `document_versions`).

## 4. Security notes

- Codes, access tokens, refresh tokens and secrets are stored only as SHA-256 hashes.
- OAuth access tokens are stored in the `tokens` table as `kind = "oauth"`. They go through the **same** Bearer
  validation and the same project/folder permission checks as API access tokens. An application cannot see more than the user's permissions.
- An OAuth token cannot do work that requires a browser session: token management, password, administration changes, granting consent,
  removing a connected application, office editing in the browser. The MCP endpoint only accepts personal API access tokens.
- A code is only issued with a browser session. Calling `/oauth2/authorize` with a Bearer token goes to the sign-in page.
- There is never a redirect to an unregistered redirect address. Unknown-client and wrong-address errors are shown to the user as a page.
- The return address after sign-in (`/login?next=`) can only be `/oauth2/authorize` on the same server.
- If a code is used a second time, all tokens issued from that code are revoked.
- If an old refresh token arrives again, the whole family (access + refresh) is revoked and recorded in the audit log.
- When an application is disabled, its tokens stop working immediately. Re-enabling brings them back.
  Deleting it also deletes the consents and tokens.
- Failed requests to `/oauth2/token` and `/oauth2/revoke` are limited per IP: 20 errors in 10 minutes, then `429` + `Retry-After`.
  The counter is in memory, per server process. Behind a reverse proxy (nginx, IIS) all requests come from the proxy's IP;
  in that case the limit is shared by everyone. If needed, the Fastify `trustProxy` setting must be enabled separately.
- Audit log: `oauth.authorize`, `oauth.consent_granted`, `oauth.consent_denied`, `oauth.token_issued`,
  `oauth.token_refreshed`, `oauth.token_failed`, `oauth.code_reused`, `oauth.refresh_reused`, `oauth.revoked`,
  `oauth.client_*`. The details contain no secret values.
- In logs, the `code`, `access_token`, `refresh_token`, `client_secret`, `code_verifier`, `token` query parameters and
  `7dcde_…` tokens are masked with `***` (`redactUrl`, `redactSecrets`).
- In production, **HTTPS and `CDE_PUBLIC_URL` are required**. Foundation requires at least TLS 1.2. The customer's internal CA certificate
  must be trusted on the Windows machines where Solibri runs.

## 5. Future SSO (Keycloak / Entra ID)

- The addresses in the `/foundation/1.1/auth` response are configurable: `CDE_OAUTH_AUTH_URL`, `CDE_OAUTH_TOKEN_URL`.
- Today these variables only change the announced address. Tokens (JWT) issued by an external identity provider are not
  **validated** yet. So leave them empty for now.
- Work needed: JWT validation with JWKS, `sub`/`email` → 7D user mapping, scope mapping, a flag to turn off the built-in server.

## 6. Next steps

1. **BCF API 3.0** (research §7.1 step B): projects, topic, comment, viewpoint. After the viewer branch is merged.
   When done, `CDE_OPENCDE_APIS=bcf` and the Solibri private connection application.
2. ~~Documents API 1.0~~ ✓ (see §1, §3a).
3. Dynamic client registration (`oauth2_dynamic_client_reg_url`): if needed, Phase 3.
4. Shared store for rate limiting (if there are several server processes).

## 7. Smoke test (manual)

`apps/server/scripts/opencde-smoke.mjs` runs the whole flow against a running **local** development server:
versions → auth → sign-in → temporary public client → authorize (PKCE) → consent → code → token → current-user and `/api/v1`
→ refresh rotation → reuse detection → Documents API (foreign callback rejected, upload and selection pages opened and
cancelled; no file is written) → Remove Access → client deletion.

```bash
cd apps/server
node --env-file=.env.development scripts/opencde-smoke.mjs
```

- Environment: `PORT` (default 8787) or `CDE_SMOKE_BASE`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
- Only works on `127.0.0.1` / `localhost` addresses. It stops if another address is given.
- It does not print tokens in full. It deletes the temporary client at the end.
- In development, Vite (`:5173`) forwards `/foundation`, `/oauth2` and `/documents` requests to the server. Use this address when testing with Solibri and AEC Pilot
  (page links are also built with this address).

## 8. Code map

| File | Contents |
|---|---|
| `apps/server/src/oauth/foundation.ts` | Foundation endpoints, the `OPENCDE_APIS` list |
| `apps/server/src/oauth/routes.ts` | `/oauth2/authorize`, `/oauth2/token`, `/oauth2/revoke` |
| `apps/server/src/oauth/authorize.ts` | Authorization request validation |
| `apps/server/src/oauth/service.ts` | Code, token, family, revocation |
| `apps/server/src/oauth/redirect.ts` | Redirect address rules (loopback) |
| `apps/server/src/oauth/api-routes.ts` | Consent page, Connected Applications, administration endpoints |
| `apps/server/src/db/schema-oauth.ts` | Tables (migration `0026_opencde_auth`) |
| `packages/shared/src/oauth.ts` | Scopes, Turkish labels, DTOs |
| `apps/web/src/features/integrations/pages/OAuthConsent.tsx`, `apps/web/src/features/admin/pages/AdminOAuth.tsx` | Consent page, administration tab |
| `apps/server/src/opencde/documents.ts` | Documents API 1.0 endpoints (`/documents/1.0/…`) |
| `apps/server/src/opencde/pages.ts` | API for the CDE pages (`/api/v1/opencde/sessions/…`), browser session only |
| `apps/server/src/opencde/common.ts` | Access and callback rules, `server_context`, `DocumentVersion` |
| `apps/server/src/db/schema-opencde-docs.ts` | Sessions, files, parts (migration `0030_opencde_docs`) |
| `packages/shared/src/opencde-documents.ts` | Scope → access, limits, page DTOs, Suitability codes |
| `apps/web/src/features/integrations/pages/OpenCdeDocuments.tsx` | Upload from an External Application, Select Documents for an External Application |
