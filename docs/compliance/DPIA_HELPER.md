# Data protection impact assessment (DPIA) helper

Input for the organisation's DPIA (GDPR Art. 35, UK GDPR Art. 35, nFADP Art. 22, LGPD Art. 38 impact
report, PIPL Art. 55–56 personal information protection impact assessment, UAE PDPL Art. 21). The
organisation decides whether a DPIA is required and carries it out; this page lists the risks of
running a common data environment and what SiteKeep does about each, so the assessment can focus on
the organisation's own setting. Not legal advice.

## Is a DPIA likely needed?

A CDE may not on its own require a DPIA; assess against Art. 35(3) and your authority's list. These
make a DPIA more likely; note which apply:

- systematic monitoring of employees (audit log of views and downloads, IP addresses) used for
  performance evaluation rather than security and document control;
- many data subjects across many organisations (large projects with contractors and subcontractors);
- photos of people or sites with location data (Field forms, site photos);
- special category data in project content, e.g. health information in accident reports and safety
  forms (KVKK m.6, GDPR Art. 9; [special category data](PERSONAL_DATA_INVENTORY.md#special-category-data));
- AI features with an external provider (transfer, new technology);
- transfers outside the country ([subprocessors](SUBPROCESSORS.md)).

## Description of the processing

Use [records of processing](RECORDS_OF_PROCESSING.md) section 2 and the
[personal data inventory](PERSONAL_DATA_INVENTORY.md). Necessity and proportionality: the data are
those needed to know who issued, reviewed and approved project information (ISO 19650), plus the
security records the law asks for.

## Risks and SiteKeep's measures

Likelihood and severity are yours to rate for your installation; the last column is what remains for
the organisation.

| # | Risk | SiteKeep's measures | What remains for the organisation |
|---|---|---|---|
| R1 | **Unauthorised access** to accounts (guessed or leaked passwords) | Single sign-on with the organisation's identity provider ([OpenID Connect](../features/OIDC_SIGN_IN.md)); breached-password list, minimum length, name and e-mail check; failed-attempt limits per account and IP with `auth.locked`; TOTP two-factor that administrators can require; session absolute and idle limits; password change ends other sessions ([sign-in security](../features/SIGN_IN_SECURITY.md)) | Require two-factor (at least for administrators); offboarding: disable accounts promptly |
| R2 | **Excessive access** inside the project (people seeing documents they should not) | Folder permissions in six levels, roles, task teams hiding other teams' work in progress (404, not 403), exceptions audited | Design the folder and role structure; review memberships regularly |
| R3 | **Administrator misuse** | Every administrative change written to the append-only, hash-chained audit log; `audit:verify` detects changes (also daily, with an alert); privacy settings changes audited; an alert when someone becomes a system administrator; a read-only **auditor** role so that review does not need administrator rights ([security log](../features/SECURITY_LOG.md)) | Limit the number of system administrators; review the audit log; protect the database: an operator with database access can delete or change rows and recompute the chain; this is detectable if a head hash recorded outside the server no longer matches |
| R4 | **Data leaving the network** without the organisation knowing | No telemetry; every outbound connection off until turned on, listed in Privacy Centre with hosts and last use, logged without content; kill switch (also suspends API access keys and OAuth access tokens); modules cannot reach undeclared hosts ([privacy](../features/PRIVACY.md)) | Decide which integrations to turn on; legal basis for transfers ([subprocessors](SUBPROCESSORS.md)) |
| R5 | **Personal data in AI prompts** sent to a cloud model | AI off by default; per-project approval for external providers (an administrative setting, not explicit consent); Ollama `:cloud` models treated as external; masking of e-mail, Turkish phone, national ID, IBAN and member names; every call logged ([masking](MASKING.md)) | Masking is not anonymisation: masked prompts remain personal data, and indirect and non-Turkish identifiers pass. Transfer mechanism ([AI providers](../features/AI_PROVIDERS.md#transfers-abroad-kvkk-and-gdpr)). A local server or gateway that forwards to a cloud is not visible to SiteKeep. Prefer a local model for sensitive projects |
| R6 | **Excessive retention** | Settings for the recycle bin, audit log, audit personal data and outbound log; daily deletion job; disposal record CSV ([retention](../features/DATA_SUBJECT_RIGHTS.md#retention)) | Set the periods from your retention policy; backups follow their own retention |
| R7 | **Monitoring of employees** through the audit log | IP address, user agent and e-mail kept apart and deleted after the set period (default 12 months); views recorded at most once per person, version and 15 minutes; log visible only to administrators (project log: project administrators) | Use the log for security and document control, not performance evaluation; say so in the privacy notice and works agreement |
| R8 | **Data subject requests not answerable** | Export (JSON and CSV), e-mail correction, erasure and pseudonymisation with two-step confirmation, restriction by disabling, all audited ([data subject rights](../features/DATA_SUBJECT_RIGHTS.md)) | Free text and file contents are not changed automatically: review them per request. Pseudonymised records remain personal data: keep them only under an Art. 17(3) exception / KVKK m.5(2) condition |
| R9 | **Loss of data / availability** | Backup and restore in the installation bundle with verification; upgrade with automatic rollback ([installation bundle](../onprem/installation-bundle.md)) | Copy backups off the server; test restores |
| R10 | **Theft of disks or backups** | Secrets encrypted with AES-256-GCM. Stored files and the database are **not** encrypted by SiteKeep today (planned) | Disk encryption (LUKS, BitLocker) and encrypted backups: [encryption at rest](../onprem/docker-compose.md#encryption-at-rest) |
| R11 | **Location data in photos** | The browser gets no location permission (`Permissions-Policy: geolocation=()`); BCF snapshots are stored without EXIF | Photos uploaded to documents or Field forms keep EXIF (including GPS) as taken: switch location tags off on site phones where not needed |
| R12 | **People not informed** | Privacy notice on the sign-in and invitation pages, optional acceptance recorded per version ([privacy notice](../features/PRIVACY_NOTICE.md)) | Write the notice |
| R13 | **Security incident not noticed in time** (GDPR Art. 33(1): without undue delay and, where feasible, within 72 hours; KVKK m.12(5): as soon as possible, 72 hours by Board decision 2019/10; data subjects: decision 2019/271) | **Administration → Security Log** with filters and CSV; **security alerts** on screen and optionally by e-mail (many failed sign-ins, bulk downloads, a new system administrator, external connections reopened, a broken audit chain); breach notification guidance on the alert ([security log](../features/SECURITY_LOG.md)) | Set alert recipients; an incident procedure that decides whether an alert is a personal data breach and notifies within the legal period |
| R14 | **Vulnerabilities in the software** | Security policy with private reporting, supported versions, advisories and SBOM per release ([SECURITY.md](../../SECURITY.md)); dependency audit and CodeQL in CI | Apply security releases; subscribe to the repository's advisories; NIS2 supply-chain assessment ([SECURITY.md](../../SECURITY.md#nis2-and-your-supply-chain)) |

## Conclusion template

*Residual risk after the measures: low / medium / high. Consultation with the supervisory authority
(GDPR Art. 36) needed: yes / no. Reviewed by: … Date: … Next review: …*
