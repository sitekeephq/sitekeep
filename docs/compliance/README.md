# Compliance

Documents for the organisation that runs SiteKeep: what the software does with personal data, and
templates for the records data protection laws ask the organisation (the data controller) to keep.
They are asked for in sales and in public tenders. Everything here describes **SiteKeep Community**;
rows that need an Enterprise module say so.

| Document | Use it for |
|---|---|
| [Personal data inventory](PERSONAL_DATA_INVENTORY.md) | Which table and column holds which personal data, why, how long, and how it is deleted or anonymised |
| [Records of processing and VERBİS helper](RECORDS_OF_PROCESSING.md) | GDPR Art. 30 records template; KVKK VERBİS terms and periodic destruction |
| [DPIA helper](DPIA_HELPER.md) | Risks of running a CDE and SiteKeep's measures, for your impact assessment |
| [Subprocessors and transfers](SUBPROCESSORS.md) | None by default; each optional integration as a possible transfer and the legal basis you set up |
| [Law mapping](LAW_MAPPING.md) | GDPR, UK GDPR, nFADP, KVKK, CCPA/CPRA, PIPL, PIPA, APPI, LGPD, DPDP, Saudi and UAE PDPL → features |
| [Masking in AI prompts](MASKING.md) | What is masked before a prompt leaves the network, and the limits |
| [ISO 19650 conformance](ISO19650.md) | CDE requirements of ISO 19650-1 and -2, with the tests that prove them |

Related feature documents: [privacy](../features/PRIVACY.md), [data subject rights and
retention](../features/DATA_SUBJECT_RIGHTS.md), [audit log](../features/AUDIT_LOG.md), [sign-in
security](../features/SIGN_IN_SECURITY.md), [privacy notice](../features/PRIVACY_NOTICE.md). Security
of the software itself (supported versions, vulnerability reporting, SBOM): [SECURITY.md](../../SECURITY.md).
Encryption of disks and backups: [encryption at rest](../onprem/docker-compose.md#encryption-at-rest).

None of these documents is legal advice. They describe the software; the organisation decides its
purposes, legal bases and retention periods, and has the result reviewed by its data protection
officer or counsel.
