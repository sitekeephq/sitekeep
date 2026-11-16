# Subprocessors and transfers

**A default SiteKeep installation has no subprocessors and makes no transfers.** It runs on the
organisation's server, sends no telemetry and connects to no outside server
([privacy](../features/PRIVACY.md)). 7Dimensions, the maker of SiteKeep, does not receive any data
from an installation and is not a processor of it (unless a separate support or hosting contract
says otherwise).

Each integration below is **off until an administrator configures it**, appears in **Administration
→ Privacy Centre → External Connections** with its servers and last use, can be switched off on its
own, is stopped by **Turn Off All External Connections**, and logs every call without content. When
one points to a server outside the organisation's network, that service becomes a **processor
(subprocessor) or a separate controller of the data sent**, and sending data to it can be a
**transfer abroad**. Establishing the legal basis is the organisation's duty as data controller:

| Law | What the controller arranges before turning an integration on |
|---|---|
| GDPR / UK GDPR | A data processing agreement (Art. 28); for a country without an adequacy decision, Standard Contractual Clauses (UK: IDTA or the UK Addendum) and a transfer impact assessment (Art. 44–49) |
| Swiss nFADP | A contract with the processor (Art. 9); for a country not on the Federal Council's list, SCCs recognised by the FDPIC (Art. 16) |
| KVKK | Transfer abroad under KVKK m.9 (as amended in 2024): an adequacy decision, or appropriate safeguards such as the **standard contract** notified to the Authority within five working days of signing, or a listed exception; a data processing agreement with the processor (m.12) |
| PIPL (China) | Separate consent and a personal information protection impact assessment; then the CAC **standard contract**, certification or a CAC security assessment, depending on volume (Art. 38–39, 55) |
| LGPD (Brazil) | Standard contractual clauses of the ANPD or another mechanism of Art. 33 |
| Others (PIPA, APPI, DPDP, Saudi and UAE PDPL, CCPA/CPRA) | Each law's rules on processors ("service providers" in CCPA) and on transfers; see [law mapping](LAW_MAPPING.md) |

Record each integration you turn on in your [records of processing](RECORDS_OF_PROCESSING.md) (and,
for KVKK, in VERBİS under transfers abroad). The **outbound connection log** (Privacy Centre, CSV) is
the evidence of what was actually sent, when and where.

## Optional integrations

| Integration (connection id) | Edition | Server it connects to | Data sent | Role of the service | Ways to avoid the transfer |
|---|---|---|---|---|---|
| **AI provider** (`ai:<providerId>`, `ai:env`; personal keys `ai:personal:anthropic`, `ai:personal:cursor`) | AI module (report model `ai:env`: Platform) | The configured provider: local (Ollama, vLLM, LM Studio) or cloud (OpenAI, Anthropic, Google Gemini, Mistral, DeepSeek, Groq, OpenRouter, Azure OpenAI) | The question and summaries of related records; e-mail, Turkish phone, national ID, IBAN and member names masked ([masking](MASKING.md)); report builder: dataset schema and the request | Processor (check the provider's API terms) | A local model on the network; AI off; per-project consent for external providers. Data location per provider: [AI providers](../features/AI_PROVIDERS.md). **DeepSeek processes data in the People's Republic of China** |
| **Sign in with Google** (`google`) | Community | `oauth2.googleapis.com`, `openidconnect.googleapis.com` | OAuth code; Google returns the verified e-mail and name | Separate controller (Google account) | Password sign-in only (switch it off) |
| **OpenID Connect sign-in** (`oidc:<id>`, one per provider) | Community | The provider's issuer: discovery document, token endpoint, keys, userinfo (only when the ID token has no e-mail) | Authorization code with PKCE verifier and the client credentials; the provider returns the ID token (e-mail, name, groups) | The organisation's identity provider (e.g. Microsoft Entra ID, Okta: processor of the organisation; Keycloak on its own server: none) | Password sign-in only, or a provider inside the network ([OpenID Connect sign-in](../features/OIDC_SIGN_IN.md)) |
| **E-mail (SMTP)** (`smtp`) | Community | The configured SMTP server | Letters (text, PDF attachment, recipients); invitations (address, inviter's and project's name, link); [security alerts](../features/SECURITY_LOG.md#alerts-g-8) (alert name, text and time only) | Processor (your mail provider) | An SMTP server in your network or the country; without SMTP, letters are downloaded as `.eml` and invitation links handed over by hand |
| **Office editor** (`office:editor`): ONLYOFFICE Docs, Collabora Online | Connect module (editing) | The configured editor | Server: only the discovery request. The editor fetches the file from SiteKeep over WOPI | Processor if hosted by a third party | Run the editor container next to SiteKeep (`docker compose --profile onlyoffice` / `collabora`) |
| **Office → PDF converter** (`office:converter`): ONLYOFFICE, Collabora, Gotenberg | Community | The configured converter | The file to convert | Processor if hosted by a third party | Run the converter next to SiteKeep (`--profile gotenberg`), or LibreOffice on the server |
| **Autodesk APS / ACC** (`autodesk`) | Connect module | `developer.api.autodesk.com` and Autodesk's signed download addresses | OAuth code and read-only project API requests; ACC users, issues, forms, reviews, RFIs and files are brought **in** | Autodesk is the controller's existing provider for ACC; the sync itself moves data from Autodesk to your server | Do not set up the connection |
| **Inbound: MCP clients, AI task queue, OAuth applications (OpenCDE)** | Community (MCP stdio, OAuth), AI module (hosted MCP, task queue) | — (the client connects to SiteKeep) | What the access key, task or approved scope allows | The client's operator (e.g. Anthropic for Claude, OpenAI for ChatGPT) | Do not issue keys; MCP policy and task queue settings in Administration |

No other component of SiteKeep contacts an outside server: fonts, scripts and images are served by
the installation itself (strict content security policy), there is no update check, and the
installation bundle loads its images from the bundle (`pull_policy: never`).

## Where the operator itself uses providers

Outside the software, the operator's own choices can also be transfers: the hosting or cloud provider
of the server, the backup target (SFTP, S3, NAS), remote administration tools, and 7Dimensions or a
partner when they are given access for support. Record them the same way.
