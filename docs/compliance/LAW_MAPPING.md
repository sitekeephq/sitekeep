# Data protection laws and SiteKeep features

SiteKeep helps the organisation running it meet the requirements data protection laws place on its
systems. The organisation is the data controller (under CCPA/CPRA: the business); SiteKeep is the
tool. This page maps the twelve laws named on sitekeep.org to the features that support each
requirement (issue #85). **Not legal advice**: the article references are pointers for your counsel,
and most requirements also need organisational measures that no software provides.

## Laws

| Short name | Law |
|---|---|
| GDPR | EU General Data Protection Regulation (EU) 2016/679 |
| UK GDPR | UK GDPR and Data Protection Act 2018 |
| nFADP | Swiss Federal Act on Data Protection (revised, 2023) |
| KVKK | Turkish Personal Data Protection Law No. 6698 (as amended by Law No. 7499) and its secondary legislation |
| CCPA/CPRA | California Consumer Privacy Act as amended by the California Privacy Rights Act |
| PIPL | Personal Information Protection Law of the People's Republic of China |
| PIPA | Personal Information Protection Act of the Republic of Korea |
| APPI | Act on the Protection of Personal Information of Japan |
| LGPD | Brazilian General Data Protection Law (Lei 13.709/2018) |
| DPDP | Indian Digital Personal Data Protection Act 2023 |
| KSA PDPL | Personal Data Protection Law of Saudi Arabia |
| UAE PDPL | UAE Federal Decree-Law No. 45 of 2021 on the Protection of Personal Data |

## Requirement → feature

| Requirement | Where the laws ask for it | SiteKeep feature | Edition |
|---|---|---|---|
| **Data stays under the controller's control; no hidden transfers** | GDPR / UK GDPR Ch. V (Art. 44–49); nFADP Art. 16–17; KVKK m.8, m.9; PIPL Art. 38–39; PIPA Art. 28-8; APPI Art. 28; LGPD Art. 33; DPDP s.16; KSA PDPL Art. 29; UAE PDPL Art. 22–23 | On-premises installation: data stays on the organisation's server unless an administrator enables an integration (AI, e-mail, sign-in, Autodesk); no telemetry; every outbound connection off until turned on, listed in the Privacy Centre, logged without content; **Turn Off All External Connections** stops outbound calls to servers outside the network, the AI task queue for external clients, and suspends API access keys and OAuth access tokens ([privacy](../features/PRIVACY.md#turn-off-all-external-connections), [processors and transfers](SUBPROCESSORS.md)) | Community |
| **Right of access and portability** | GDPR / UK GDPR Art. 15, 20; nFADP Art. 25, 28; KVKK m.11(1)(a)–(c) (access only: KVKK has no right to data portability); CCPA §1798.100, .110; PIPL Art. 45; PIPA Art. 35, 35-2; APPI Art. 33; LGPD Art. 18; DPDP s.11; KSA PDPL Art. 4; UAE PDPL Art. 13–14 | Personal data export (ZIP of JSON and CSV), by an administrator or by the person in My account ([data subject rights](../features/DATA_SUBJECT_RIGHTS.md#export)) | Community |
| **Right to rectification** | GDPR / UK GDPR Art. 16; nFADP Art. 32; KVKK m.11(1)(d); CCPA §1798.106; PIPL Art. 46; PIPA Art. 36; APPI Art. 34; LGPD Art. 18; DPDP s.12; KSA PDPL Art. 4; UAE PDPL Art. 15 | Name and company editing; **Change E-mail** with uniqueness check, audited | Community |
| **Right to erasure** | GDPR / UK GDPR Art. 17; nFADP Art. 32; KVKK m.7, m.11; CCPA §1798.105; PIPL Art. 47; PIPA Art. 36; APPI Art. 35; LGPD Art. 18; DPDP s.12; KSA PDPL Art. 4; UAE PDPL Art. 15 | **Erase and pseudonymise user**. Supports GDPR Art. 17 / KVKK m.7: identifying data is erased and history pseudonymised. Pseudonymised records remain personal data and are kept only under an Art. 17(3) exception / KVKK m.5(2) condition, then deleted at the end of the retention period ([erase and pseudonymise](../features/DATA_SUBJECT_RIGHTS.md#erase-and-pseudonymise-user)) | Community |
| **Restriction / objection** | GDPR / UK GDPR Art. 18, 21; PIPA Art. 37; APPI Art. 35; LGPD Art. 18; UAE PDPL Art. 16–17 | Art. 18 (restriction): disabling the account ([restriction](../features/DATA_SUBJECT_RIGHTS.md#restriction-of-processing)). Art. 21 (objection): the controller assesses the objection; SiteKeep then offers the same tools (disabling, erasure, editing records) | Community |
| **Storage limitation and periodic destruction** | GDPR / UK GDPR Art. 5(1)(e); nFADP Art. 6(4); KVKK m.4(2)(d), m.7 and the Regulation on Deletion, Destruction or Anonymisation; PIPL Art. 19, 47; PIPA Art. 21; APPI Art. 22; LGPD Art. 15–16; DPDP s.8(7); KSA PDPL Art. 18; UAE PDPL Art. 5 | Retention settings (recycle bin, audit log, audit personal data, outbound log), daily deletion job, **disposal record** CSV ([retention](../features/DATA_SUBJECT_RIGHTS.md#retention)) | Community |
| **Transparency: informing data subjects** | GDPR / UK GDPR Art. 13–14; nFADP Art. 19; KVKK m.10; CCPA §1798.100 (notice at collection); PIPL Art. 17; PIPA Art. 15, 30; APPI Art. 21; LGPD Art. 9; DPDP s.5; KSA PDPL Art. 12; UAE PDPL Art. 13 | **Privacy notice** on the sign-in and invitation pages, optional acceptance recorded per version ([privacy notice](../features/PRIVACY_NOTICE.md)) | Community |
| **Security of processing** | GDPR / UK GDPR Art. 32; nFADP Art. 8; KVKK m.12(1) (for special category data also Board decision 2018/10); CCPA §1798.100(e), §1798.150 ("reasonable security"); PIPL Art. 51; PIPA Art. 29; APPI Art. 23; LGPD Art. 46; DPDP s.8(5); KSA PDPL Art. 19; UAE PDPL Art. 20 | Permissions and task teams; password rules with a breached-password list; failed-attempt limits; two-factor (can be required); session limits ([sign-in security](../features/SIGN_IN_SECURITY.md)); single sign-on over [OpenID Connect](../features/OIDC_SIGN_IN.md); secrets encrypted; HTTPS, HSTS, strict CSP. Disk and backup encryption: the operator's ([encryption at rest](../onprem/docker-compose.md#encryption-at-rest)) | Community |
| **Accountability and logs** | GDPR / UK GDPR Art. 5(2), 30; nFADP Art. 12; KVKK m.12(1), (3), m.16 (VERBİS); PIPL Art. 54; PIPA Art. 29; LGPD Art. 37; KSA PDPL Art. 31; UAE PDPL Art. 7 | Append-only, hash-chained **audit log** with verification and CSV; read-only **auditor** role; IP address and user agent kept apart with their own retention ([audit log](../features/AUDIT_LOG.md)); [records of processing](RECORDS_OF_PROCESSING.md) template and VERBİS helper | Community |
| **Breach detection and notification** | GDPR / UK GDPR Art. 33 (72 hours where feasible), Art. 34 (without undue delay); nFADP Art. 24; KVKK m.12(5) (Board decisions 2019/10 and 2019/271); PIPL Art. 57; PIPA Art. 34; APPI Art. 26; LGPD Art. 48; DPDP s.8(6); KSA PDPL Art. 20; UAE PDPL Art. 9 | [Security log](../features/SECURITY_LOG.md) with filters and CSV; security alerts on screen and by e-mail with the GDPR / KVKK notification periods on the alert; outbound log of every external call | Community |
| **Data protection by design and by default** | GDPR / UK GDPR Art. 25; nFADP Art. 7; LGPD Art. 46(2); PIPL Art. 51 | Everything external off by default; AI off by default; masking on by default for external models; least-privilege folder permissions | Community |
| **Impact assessment** | GDPR / UK GDPR Art. 35; nFADP Art. 22; PIPL Art. 55–56; PIPA Art. 33 (public bodies); LGPD Art. 38; UAE PDPL Art. 21 | [DPIA helper](DPIA_HELPER.md): risks and SiteKeep's measures | Community (document) |
| **Processors and transfers documented** | GDPR / UK GDPR Art. 28, 30(1)(e), 30(2); KVKK m.9, m.12(2), VERBİS; PIPL Art. 21, 38–39; LGPD Art. 33, 39 | [Processors, third parties and transfers](SUBPROCESSORS.md); draft [DPA](DPA_TEMPLATE.md) and [KVKK standard contract](KVKK_STANDARD_CONTRACT_TEMPLATE.md) templates; outbound log as evidence | Community (document) |
| **Data minimisation in AI** | GDPR / UK GDPR Art. 5(1)(c), 25; KVKK m.4(2)(ç); PIPL Art. 6; LGPD Art. 6(III) | Masking of identifiers and member names in prompts (masked prompts remain personal data); per-project approval for external providers (an administrative setting, not explicit consent) ([masking](MASKING.md)) | AI module |
| **AI transparency and AI literacy** | EU AI Act (Regulation (EU) 2024/1689) Art. 50(1), Art. 4 | AI output in the interface carries an "AI-generated" label; [AI literacy](../features/AI_PROVIDERS.md#ai-act-transparency-and-ai-literacy) guidance for the deployer | AI module |
| **Records of data subject requests** | GDPR / UK GDPR Art. 5(2), 12(3)–(4), 24; KVKK m.13(2) (answer within 30 days); CCPA regulations (records of requests, 24 months) | Every export, correction, erasure and pseudonymisation, and restriction is an audit row (`user.data_exported`, `user.email_changed`, `user.anonymised`, `user.updated`) | Community |

## Notes by law

- **KVKK:** VERBİS registration and the periodic destruction record are supported by the
  [records of processing](RECORDS_OF_PROCESSING.md#4-verbis-helper-kvkk) helper and the disposal
  record; whether you must register (m.16, Board exemption decisions 2018/87 as amended) remains the
  controller's. Transfers abroad need m.9's mechanisms; cloud AI providers are transfers
  ([AI providers](../features/AI_PROVIDERS.md#transfers-abroad-kvkk-and-gdpr)).
- **PIPL:** cross-border transfer requires separate consent and one of the CAC mechanisms; keep AI and
  every external connection inside China or off for projects processing Chinese residents' data.
- **CCPA/CPRA:** SiteKeep does not sell or share personal information and has no advertising or
  tracking; the business answers consumer requests with the export, correction and erasure tools.
- **DPDP:** the "consent manager" and notice in multiple Indian languages are the controller's; the
  privacy notice text can carry them.
- **KSA PDPL / UAE PDPL:** registration and transfer rules (e.g. SDAIA's transfer regulation) are the
  controller's; the outbound log and the kill switch keep transfers visible and controllable.
- **NIS2:** customers under the NIS2 Directive assess their software suppliers (Art. 21(2)(d)); see
  [SECURITY.md](../../SECURITY.md#nis2-and-your-supply-chain).
