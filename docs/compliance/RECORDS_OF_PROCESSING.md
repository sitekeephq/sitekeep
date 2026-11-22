# Records of processing (GDPR Art. 30) and VERBİS helper

A template for the organisation that runs SiteKeep. The organisation is the data controller and keeps
these records; this page fills in what the software does, so only the organisation's own facts
(names, legal basis, periods it chose) are left. Text in *italics* is for you to replace. Not legal
advice: have your data protection officer or counsel review the result.

Sources for each line: [personal data inventory](PERSONAL_DATA_INVENTORY.md) (tables, retention,
deletion), [subprocessors and transfers](SUBPROCESSORS.md), [DPIA helper](DPIA_HELPER.md).

## 1. Controller

| Field | Value |
|---|---|
| Controller | *Organisation name, address, registration number* |
| Representative in the EU / UK (Art. 27), only for controllers outside the EU / UK that must appoint one | *…* |
| Data protection officer / contact person ("irtibat kişisi") | *Name, e-mail* |
| System | SiteKeep *Community / Enterprise, version*, installed on *server, location (country, data centre or own premises)*, operated by *IT department / service provider* |

## 2. Processing activities

One row per activity. The columns are those of GDPR Art. 30(1), with the legal basis (Art. 6, and
KVKK m.5 / m.6) added because you need it for every activity; the KVKK / VERBİS terms are in section 4.
Choose and justify the basis for each activity.

| # | Activity | Purpose | Legal basis (Art. 6; KVKK m.5 / m.6) | Data subjects | Personal data | Recipients | Transfers abroad | Retention | Security measures |
|---|---|---|---|---|---|---|---|---|---|
| 1 | User accounts and sign-in | Giving project participants access; authentication | *Art. 6(1)(…); KVKK m.5(2)(…)* | Employees, employees of contractors, consultants and the client | Name, e-mail, company, password hash, two-factor secret, session data | System administrators | None by default ([optional sign-in with Google or an OpenID Connect provider](SUBPROCESSORS.md)) | Life of the account; sessions per Sign-in Security | §3 |
| 2 | Project document control (CDE) | Managing project information under ISO 19650 | *Art. 6(1)(…); KVKK m.5(2)(…)* | As above; people named in documents | Who uploaded, reviewed and approved what; content of documents and photos (may include any personal data, photo EXIF and location) | Project members according to folder permissions | None by default | *Contractual / statutory archiving period of the project, e.g. 10 years after completion*; recycle bin auto-purge *setting* | §3 |
| 3 | Correspondence and works (letters, RFIs, submittals, meetings) | Official project correspondence | *Art. 6(1)(…); KVKK m.5(2)(…)* | Contacts of the parties, signers, meeting attendees | Names, titles, postal and e-mail addresses, letter text, minutes | Project members; letter recipients (by e-mail only when SMTP is set up) | *SMTP server location* | *As project archive* | §3 |
| 4 | Audit log | Accountability, ISO 19650 audit trail, security investigations, evidence | *Art. 6(1)(…); KVKK m.5(2)(…)* | All users | Who did what and when; IP address, user agent, e-mail of failed sign-ins | System and project administrators | None | Events: *setting* (default unlimited); IP / user agent / e-mail: *setting* (default 12 months) | Append-only, hash-chained; personal part separate |
| 4a | Security log and security alerts | Detecting attacks and personal data breaches (GDPR Art. 33, KVKK m.12(5)) | *Art. 6(1)(…); KVKK m.5(2)(…)* | All users | Security events from the audit log; alerts name the account by id; alert recipients' e-mail addresses | System administrators and auditors; alert e-mails to the listed recipients | None (SMTP: *location*) | Events and IP data: as #4; alerts: *no automatic deletion* | Read-only auditor role |
| 5 | Outbound connection log | Evidence of every call to an external server | *Art. 6(1)(…); KVKK m.5(2)(…)* | Users who triggered a call | User id, project, host, time, sizes | System administrators | None | *setting* (default 90 days) | — |
| 6 | Privacy notice acceptance | Proof that people were informed | *Art. 6(1)(…); KVKK m.5(2)(…)* | All users | Version accepted, time, method | System administrators | None | Life of the account | — |
| 7 | AI features (only if enabled; AI module) | Answering questions about the project | *Art. 6(1)(…); KVKK m.5(2)(…); transfer: [m.9 / Ch. V](../features/AI_PROVIDERS.md#transfers-abroad-kvkk-and-gdpr)* | People named in project records | Question and related project text; e-mail, Turkish phone, national ID, IBAN and member names masked before leaving the network ([masking](MASKING.md)) | The chosen AI provider | *Provider and country, if external* | Not stored by SiteKeep beyond the call; provider: *its terms* | Per-project approval (an administrative setting, not explicit consent), masking, logging |
| 8 | Field forms (Field module) | Inspections, quality and safety forms | *Art. 6(1)(…); KVKK m.5(2)(…); special category data (health, accidents): also Art. 9(2) / KVKK m.6* | Workers, inspectors | Names, signatures, photos (with EXIF / location if the device wrote it), answers | Project members | None | *As project archive* | §3 |
| 9 | Data subject requests | Handling access, rectification and erasure requests | *Art. 6(1)(…); KVKK m.5(2)(…)* | Requesters | Export ZIP, request audit rows | System administrators | None | Export: 7 days; audit rows: as #4 | Two-step confirmation for erasure and pseudonymisation |
| 10 | Backups | Recovery | *As the activity backed up* | All of the above | All of the above | Operator | *Backup target and location* | *Backup retention (`CDE_BACKUP_KEEP`)* | *Backup encryption (operator)* |

Add rows for the optional integrations you turn on ([subprocessors](SUBPROCESSORS.md)): Google
sign-in, Autodesk ACC sync, office editor or converter outside your network.

**If you act as a processor** (for example a service provider running SiteKeep for a client, or
7Dimensions when it supports, hosts, migrates or backs up an installation for a customer), keep the
processor's records of GDPR Art. 30(2) as well: the name of each controller you act for, the
categories of processing carried out for it, transfers abroad and the security measures.

## 3. Technical and organisational measures (Art. 32) provided by SiteKeep

Describe these in the "security measures" column, adding your own (physical security, backups,
access to the server, training):

- Runs on the organisation's own server; no telemetry; every external connection is off until an
  administrator turns it on, is listed and logged; **Turn Off All External Connections** stops all
  outbound calls outside the network and suspends API access keys and OAuth access tokens
  ([privacy](../features/PRIVACY.md#turn-off-all-external-connections)).
- Role and folder based permissions (six levels), ISO 19650 task teams that hide other teams' work in progress;
  a read-only auditor role for the security log and the Privacy Centre.
- Security log with filters and CSV, and security alerts (failed sign-ins, bulk downloads, new
  administrators, external connections reopened, audit chain check) on screen and by e-mail
  ([security log](../features/SECURITY_LOG.md)).
- Single sign-on with the organisation's identity provider over OpenID Connect ([OIDC](../features/OIDC_SIGN_IN.md)).
- Passwords hashed (scrypt), checked against a breached-password list; failed-attempt limits;
  two-factor authentication (can be required); session lifetimes ([sign-in security](../features/SIGN_IN_SECURITY.md)).
- Secrets (provider keys, two-factor secrets, OAuth tokens) encrypted with AES-256-GCM.
- HTTPS with HSTS, secure cookies, strict content security policy, security headers.
- Append-only, hash-chained audit log with verification (`npm run audit:verify`).
- Retention periods and a daily deletion job with a disposal record.
- **Operator's part:** disk and backup encryption, server hardening, updates
  ([installation](../onprem/docker-compose.md#encryption-at-rest)).

## 4. VERBİS helper (KVKK)

VERBİS ("Veri Sorumluları Sicil Bilgi Sistemi") asks for the processing inventory in its own
categories. The table maps the activities above to the terms VERBİS uses; enter them on
verbis.kvkk.gov.tr under your organisation. The quoted labels are the closest entries of VERBİS's
lists; pick the exact entries the form offers.

| VERBİS field | What to enter for SiteKeep |
|---|---|
| **İşleme amacı** (purpose) | #1 "Bilgi Güvenliği Süreçlerinin Yürütülmesi", "Erişim Yetkilerinin Yürütülmesi"; #2–#3 "İş Faaliyetlerinin Yürütülmesi / Denetimi", "Sözleşme Süreçlerinin Yürütülmesi", "İletişim Faaliyetlerinin Yürütülmesi"; #4–#5 "Denetim / Etik Faaliyetlerinin Yürütülmesi", "Bilgi Güvenliği Süreçlerinin Yürütülmesi"; #8 "İş Sağlığı / Güvenliği Faaliyetlerinin Yürütülmesi" (Field forms) |
| **Veri konusu kişi grubu** (data subjects) | "Çalışan", "Tedarikçi Çalışanı", "Ürün veya Hizmet Alan Kişi" (client staff), "Diğer" (persons named in documents) |
| **Veri kategorisi** (data category) | "Kimlik" (name), "İletişim" (e-mail, address), "Özlük" / "Mesleki Deneyim" (company, role, title), "İşlem Güvenliği" (IP address, user agent, sign-in records, password hash), "Görsel ve İşitsel Kayıtlar" (photos), "Lokasyon" (photo EXIF, if kept), "Diğer" (project documents) |
| **Alıcı / alıcı grubu** (recipients) | Project members within the organisation and other project parties ("Hissedarlar" / "Tedarikçiler" / "İş Ortakları" as applicable); public authorities on request |
| **Yabancı ülkelere aktarılan veriler** (transfers abroad) | "Yok" with the default installation. Otherwise per integration: [subprocessors](SUBPROCESSORS.md) |
| **Saklama süresi** (retention) | The periods of section 2, from your retention and destruction policy ("Kişisel Veri Saklama ve İmha Politikası") |
| **İdari ve teknik tedbirler** (measures) | Technical: "Ağ Güvenliği ve Uygulama Güvenliği Sağlanmaktadır", "Erişim Logları Düzenli Olarak Tutulmaktadır", "Kullanıcı Hesap Yönetimi ve Yetki Kontrol Sistemi Uygulanmaktadır", "Log Kayıtları Kullanıcı Müdahalesi Olmayacak Şekilde Tutulmaktadır" (hash chain), "Şifreleme Yapılmaktadır" (secrets; disk only if you encrypt it), "Kişisel Veri İçeren Ortamların Güvenliği Sağlanmaktadır". Administrative: your own |

**Periodic destruction** ("periyodik imha", Regulation on the Deletion, Destruction or Anonymisation
of Personal Data): it must run at intervals of no more than six months (Art. 11), and the record of
each destruction operation is kept for at least three years (Art. 7). The daily retention job deletes
what its settings say and records every run in the disposal record, whose rows the application never
deletes; Privacy Centre → Retention → **Download CSV** is the basis for the destruction record ("imha
kaydı"). A retention and destruction policy ("Kişisel Veri Saklama ve İmha Politikası") is mandatory
for controllers that must register with VERBİS (Art. 5). The periods themselves come from your policy.

**VERBİS scope:** whether the organisation must register with VERBİS is decided under KVKK m.16 and
the Board's exemption decisions (2018/87 as amended); this helper supports the registration, it does
not decide it.

**Obligation to inform** ("aydınlatma yükümlülüğü", KVKK m.10): put your notice on the sign-in page
with the [privacy notice](../features/PRIVACY_NOTICE.md) setting.
