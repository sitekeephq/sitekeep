# Privacy

SiteKeep is a privacy-first CDE. This document describes what leaves the server, when, and where to.

## Principle

- Data stays on the customer's server.
- The server does not send data out on its own. There is no telemetry, no usage statistics and no update check.
- Every external connection is turned on by an administrator. All of them are visible in **Administration → Privacy Centre**.
- Every external call is logged. The log never holds content.
- A single switch cuts all external connections.

## Data flows

In the default installation, the server makes no connections outside the network. The following run only if an administrator configures them.

| Connection | When | What is sent | Purpose in the log |
|---|---|---|---|
| AI provider (Ollama, vLLM, DeepSeek, Claude…) | When an AI feature is used | Prompt: the question, summaries of related records. Personal data is masked in prompts that leave the network. | `yapay_zeka:<sağlayıcı>` |
| Report model (`AI_BASE_URL`) | When the report builder is used | Dataset schema and the request | `yapay_zeka:rapor` |
| Email server (SMTP) | When an official letter is sent with "Send" | Letter text and PDF attachment, recipients | `eposta` |
| Office editor (ONLYOFFICE / Collabora) | Editor settings and opening a file | Server: only the discovery request. The editor fetches the file from the CDE itself over WOPI. | `ofis:onlyoffice`, `ofis:collabora` |
| Office → PDF converter (ONLYOFFICE, Collabora, Gotenberg) | Office file preview | The file to convert | `ofis:<dönüştürücü>` |
| Sign in with Google | When a user chooses Google sign-in | OAuth code; the verified email information is then received | `giris:google` — [Sign in with Google](GOOGLE_SIGN_IN.md) |
| Autodesk APS / ACC | When a project administrator sets up the connection and when sync runs | OAuth code and read-only project API requests; ACC records are brought into the CDE | `entegrasyon:autodesk` |

Inbound connections (the server does not connect out; the client connects to the CDE):

- **MCP server:** clients such as Claude and ChatGPT connect with an access key. They read as much data as the key permits.
- **AI task queue:** a connected client picks up the prompt of a pending task. The client is an external AI.
- **OAuth applications (OpenCDE):** an application the user has consented to receives data within the approved scope.

Browser side: pages are served with a strict content security policy (CSP). The browser loads no scripts, fonts or images from other sites. The only exception is the address of the configured office editor.

## Outbound connection log

Every external call on the server goes through a single helper (`apps/server/src/privacy/outbound.ts`). A test fails if a new `fetch(` call is written outside this helper.

What is recorded for each call:

- time, purpose, host name, method;
- bytes sent and received, HTTP status, duration;
- requesting user and project (if known);
- for AI calls: feature, provider, model, number of characters sent, counts of masked data.

Content, prompts, responses and file names are not recorded. Records are kept for 90 days by default. The period is changed in the Privacy Centre. Expired records are deleted daily. The log can be downloaded as CSV.

## Data minimisation in AI

In every prompt sent to a model outside the network, the following data is replaced with placeholders:

- email addresses → `[E-POSTA_1]`
- Turkish phone numbers (+90, 0, area code, with or without spaces) → `[TELEFON_1]`
- Turkish national ID (TC kimlik) numbers (those with a valid check digit) → `[TCKN_1]`
- TR IBANs → `[IBAN_1]`
- full names of project members → role and company, e.g. `[Proje Müdürü (Poyraz)]` (can be turned off in settings)

The mapping is kept in memory only for the duration of that call. Placeholders in the model's response are replaced with the originals before the response is shown to the same user. The mapping is never written anywhere.

Masking is off by default for local models. If **Mask for the Local Model Too** is turned on, the local model also receives a masked prompt.

## Turn off all external connections

When the **Turn Off All External Connections** switch in the Privacy Centre is turned on:

- The server does not connect to any address outside the network. The call stops with a clear Turkish error and is logged as "Blocked".
- The AI mode becomes fully local (`local_only`). The selected mode is kept and comes back when the switch is turned off.
- The task queue for external AI clients stops.
- Scheduled Autodesk sync stops; new OAuth and API calls are blocked.
- Administrators see a warning banner at the top of every page.

The local network is defined as:

- private IP ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, IPv6 fc00::/7 and fe80::/10);
- names ending in `localhost`, `.local`, `.lan`, `.internal`, `.home.arpa`, and single-label names (e.g. `ollama` in Docker);
- the administrator's **Internal Network Servers** list: a full name, `*.firma.com.tr`, or an IPv4 range such as `100.64.0.0/10`.

Each connection can also be turned off individually from the **External Connections** list.

## Storage and deletion of Autodesk data

User names, emails, companies, issues, forms, reviews, RFIs and submittal records brought in from ACC are stored in the project
database. OAuth access and refresh tokens are kept encrypted with AES-GCM using `CDE_SECRET_KEY`;
they are not written to the UI or the outbound connection log.

- The mapping between the source record and the CDE record is kept; re-syncing the same record does not create a copy.
- The default retention period is the project's retention period. Turning off the connection stops new syncs;
  it does not automatically delete project records brought in earlier.
- A project administrator can turn off the connection in the project settings; imported local records are managed
  by the normal deletion/archiving rules of their own modules. When the project is deleted, the connection, the encrypted
  tokens, the raw sync records and the mappings are deleted relationally.
- Transferring personal data from ACC to the CDE and setting the retention period are the responsibility of the
  data controller organisation.

## KVKK notes

KVKK is the Turkish Personal Data Protection Law.

- The organisation is the data controller. SiteKeep processes the data on the organisation's server.
- Using a cloud AI provider may count as a transfer of data abroad. Therefore:
  - the system administrator turns on an external provider, and each project gives separate permission;
  - personal data is masked;
  - every call is logged.
- The organisation should assess the provider's data processing agreement and the legal basis for the transfer.
- The outbound connection log can be used as evidence for the transfer inventory and for audits.
- Masking is a security layer, not full anonymisation. Indirect identifiers in free text (e.g. address, job title) are not masked.

## Security headers

On every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: SAMEORIGIN`, `Permissions-Policy` (camera only for this site; form photos), `Cross-Origin-Opener-Policy: same-origin-allow-popups`. `Strict-Transport-Security` when served over HTTPS.

`Content-Security-Policy` on pages: own files only, wasm (pdf.js, web-ifc), `blob:` workers, `data:`/`blob:` images. Inline scripts in the report frame run with a nonce generated per page. `frame-ancestors 'self'`.

OAuth paths (`/oauth2/*`, consent page) do not get COOP, for clients that use pop-ups. Paths that set their own CSP (preview, markup, comparison report) keep their own policy.

## Roadmap (phase 2)

- On-disk encryption for stored files.
- KVKK user data export and anonymisation (data subject requests).
- Retention policies: duration and automatic deletion by project, folder and record type.
- Full project export (in OpenCDE BCF and Documents API format): the customer can move their data to another CDE at any time.
- Two-factor authentication (2FA) and enterprise single sign-on (SSO).
- Masking of task queue prompts as well.
