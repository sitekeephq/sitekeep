# Terminology: Turkish terms in the interface

Date: 10.10.2026. In the Turkish interface, every name the user sees is Turkish: menus, pages, buttons, warnings, notifications, PDF/Excel output and
the answers of the "Sor" ("Ask") assistant. English loanwords such as "Review'lar" and "Issue'lar" are not used.

This document is a bilingual glossary. The Turkish terms are given verbatim, because they are what the Turkish locale must contain; where the
English locale (`apps/web/src/i18n/locales/en`) has a matching label, it is shown after the Turkish term as "en: …".

Internal names do not change: database tables and fields, status/enum values, API paths (`/issues`, `/reviews`), page
addresses, query parameters, event types (`review.started`), MCP tool names (`cde_issues_list`) and type keys
(`transmittal`, `aksiyon`). MCP tool descriptions stay in English for the models; the Turkish output of the tools uses
these terms.

Product and standard names stay as they are: IFC, BIM, ISO 19650, PDF, DWG, DXF, KEP, IDS (file format), MCP, Ollama,
ONLYOFFICE, Collabora, That Open. On the administrator screen, MCP appears with a Turkish description ("yapay zekâ istemcileri için araç
sunucusu", a tool server for AI clients).

## Glossary

| English / former | Turkish (en: English UI) | Note |
|---|---|---|
| Review, Review'lar | İnceleme, İncelemeler (en: Review, Reviews) | "İnceleme başlat" (Start Review), "İnceleme #12", inceleme zinciri (review chain), inceleme şablonu (review template) |
| Reviewer | İnceleyen (en: Reviewer) | "İnceleyen görüşleri" (Reviewer Comments) |
| Issue, Issue'lar | Sorun, Sorunlar (en: Issue, Issues) | "Sorun oluştur" (Create Issue), "Sorun #7" |
| Pin (issue pin) | Nokta (en: Pin) | "📍 Noktadan sorun" (Issue from Pin), "+ Görünümden sorun" (+ Issue from Viewpoint) |
| Viewpoint | Görünüm (en: Viewpoint) | |
| BCF topic | Sorun (en: Issue) | "BCF İçe Aktar" (Import BCF), "BCF Olarak Dışa Aktar" (Export as BCF) (../features/BCF.md). The name BCF stays as is |
| Conflict (on import) | Uyuşmazlık | "Çakışma" is reserved for model clashes |
| RFI, RFI log | Bilgi talebi, Bilgi talebi listesi (en: RFI, RFI Log) | The abbreviation appears only once in descriptions: "bilgi talebi (RFI)". In new projects the number abbreviation is **BT** (`…_BT_000`); in old projects the stored `…_RFI_000` remains |
| Submittal, submittal item / package | Teknik onay, teknik onay kalemi / paketi (en: Submittal, Submittal Items) | |
| Submittal register | Teknik onay listesi (en: Submittal Register) | Also the Excel sheet and file name: `…-teknik-onay-listesi.xlsx` |
| Spec, spec section | Şartname, şartname bölümü (en: Specification, Spec Section) | "Şartnameden teknik onay listesi çıkar" (Build Submittal Register from Specification) |
| Register ("şartname register'ı") | Liste (en: Register) | "Şartname listesini içe aktar" (Import Specification Register) |
| Transmittal, Transmittaller | Gönderim formu, Gönderim formları (en: Transmittal, Transmittals) | Cover PDF title "GÖNDERİM FORMU" (TRANSMITTAL); default folder "Gönderim formları" (see below). In new projects the number abbreviation is **GF** (`{Proje}-GF-…`); in old projects the stored `{Proje}-TRM-…` remains |
| Markup | İşaretleme (en: Markup) | "İşaretlemeler" (Markups), "İşaretleme olarak kaydet" (Save as Markup) |
| Clash, clash testi | Çakışma, çakışma testi (en: Clash) | |
| Model Coordination | Model koordinasyonu | "Koordinasyon" (Coordination) in the menu |
| Model viewer (menu) | Model Görüntüleyici (en: Model Viewer) | User decision (10.10.2026); previously "Model" |
| Model set | Model seti (en: Model set) | |
| Federation, federated | Birleşik model | |
| Viewer | Görüntüleyici (en: Viewer) | "Görüntüleyicide aç" (Open in Viewer) |
| Dashboard | Panel (en: Dashboard) | Report dashboard |
| Monitoring | Sistem Durumu (en: System Status) | Tab in Administration and Project Settings; not Grafana |
| Log / logs | Son Hatalar (en: Recent Errors) | In System Status; not the raw server log |
| Cleanup (disk) | Türevleri Temizle (en: Clean Up Derivatives) | Previews and Fragments; project files are not deleted |
| Workflow | İş akışı (en: Workflow) | |
| Template | Şablon (en: Template) | |
| Ball in court ("Top kimde") | Sıradaki taraf (en: Ball in Court) | Work card, RFI log and submittal register (including Excel) |
| Baseline | Temel plan (en: Baseline) | "Temel plan yap" (Make Baseline), "Planlanan (temel plan)" (planned (baseline)) |
| Lookahead | Yakın dönem planı | |
| WBS | İş kırılımı (en: WBS) | "İş kırılımı (WBS)" in the import mapping |
| Gantt | Gantt şeması (en: Gantt chart) | |
| Action (meeting item), Aksiyon | Eylem, Eylemler (en: Action, Actions) | User decision (10.10.2026). In new projects the number pattern is `{Proje}-EYL-{0000}` |
| Token (API) | Erişim anahtarı (en: Access Token) | "API erişim anahtarları" (API Access Tokens), "Yeni erişim anahtarı" (New Access Token) |
| Google Sign-In | Google ile devam et (en: Continue with Google) | `/login` button. Not the OpenCDE OAuth application. [Google sign-in](../features/GOOGLE_SIGN_IN.md) |
| Domain allowlist | İzinli Alan Adı (en: Allowed Domain) | Administration → Users. Switch for creating new users via Google |
| Forma / ACC file sync | Forma Eşitleme (en: Forma Sync) | Project → Administration. ACC project connection, registration and file fetching on one page. [Forma sync](../features/FORMA_SYNC.md) |
| Upload / download | Yükle / indir (en: Upload / Download) | |
| WIP / Shared / Published / Archived | Çalışma / Paylaşılan / Yayınlanan / Arşivlenen (en: Work in Progress / Shared / Published / Archived) | ISO 19650 status labels |
| Shared for Review / Shared for Approval | İnceleme için / Onay için (en, latter only: For Approval) | Sub-status label in project templates |
| As-Built | İş sonu | From the name "04-İş Sonu (As-Built)" in the İBB structure |
| IDS check | Bilgi gereksinimi kontrolü (IDS) (en: Information Requirement Check) | Stays as the name of the IDS file format: "IDS dosyası" (IDS File) |
| Specification (inside IDS) | Gereksinim tanımı | |
| Embedding model | Arama modeli (embedding) | Only on the AI administration screen |
| Status open / closed / draft | Açık / Kapalı / Taslak (en: Open / Closed / Draft) | The label tables were already Turkish |

Language model prompts (the "Sor" assistant, the report dashboard generator, the clash summary) use the same list:
`packages/shared/src/terms.ts` (`UI_TERMS_TR`, `termsInstructionTr()`).

## Capitalisation rule

"Her Kelime Büyük Harf İle Başlasın" (Every Word Starts With A Capital Letter; user decision, 10.10.2026). **Names and labels** are written in Title Case, following Turkish
letter rules (i → İ, ı → I: "İş Programı", "Tüm İşler"):

- the left menu, group headings and "Sor…"; page and section headings (h1/h2/h3), tabs, dialog titles;
- work type and category names ("Gelen Yazı", "Teknik Onay Kalemi"), Work (İşler) sections, status labels ("Notlu Onaylandı",
  "Tutanak Hazırlanıyor"), quick filter and badge labels;
- checkbox and radio button texts ("Yalnız Açık İşler", "Sistem Yöneticisi"; user decision
  10.10.2026); a description after " — " or a full stop stays in sentence case;
- table columns, form field labels, buttons ("+ Yeni Yazı", "PDF Olarak Kaydet", "Sayfa Düzeninde Aç (PDF)"), options that act as
  names ("Gruplama Yok", "Tipe Göre"), administration tabs, report template names, PDF headings,
  Excel columns and sheet names, and field labels of the built-in types, the form library and the project templates.

Words that stay lower case (unless first): ve, ile, veya, ya da, için, de/da, ki, and the question particle
mı/mi/mu/mü under TDK's (Turkish Language Association) heading rule ("Formlar ve Konumlar", "Açık mı"). Words starting with a capital letter or a digit stay as they are: PDF,
IFC, BIM, ISO, KEP, MCP, BT, GF, numbers. A parenthetical explanation is not part of the name and stays in sentence case: "Yeni Şifre (en
az 10 karakter)", "Not (isteğe bağlı)".

**What stays in sentence case:** help and description texts, empty-list sentences, error and notification messages, placeholders,
description lines of choice cards, yes/no checklist items in the form library, activity log lines, AI
answers and prompts, document texts. Data written by the user (title, folder name, a type name given by the administrator)
never changes. Folder names did not change either (see below).

Helper: `packages/shared/src/title-case.ts` → `titleCaseTr(text)`, `isTitleCaseTr(text)`. Labels are written in Title Case
in the source; the helper is used only to upgrade stored defaults and in checks.

## Stored data

Stored values were not changed. The exception is the default names and labels installed into a project; if an administrator changed them,
their value stays:

- **Cover folder:** in new projects, transmittal covers are written to the "Gönderim formları" folder at the root. Projects that have the old
  "Transmittaller" folder at the root keep using it; no second folder is created.
- **Built-in work types:** the name, field labels and status labels take the current default the next time the project is opened ("Transmittal"
  / "Gönderim formu" → "Gönderim Formu", "Yazı tarihi" → "Yazı Tarihi", "Notlu onaylandı" → "Notlu Onaylandı"), but only
  if they still hold the value given by the seeder. The seeder stores the name it gave in `settings.seededName`, and field and status labels in
  `settings.seededLabels` (`f:anahtar`, `s:anahtar`). For old records created without these fields, the previous
  default is the known old name or the same words with different capitalisation (`isSeededDefaultLabel`).
  If an administrator later sets a label back to its old form, that is treated as their choice and kept. Running the upgrade twice
  changes nothing.
- **Number patterns** are stored and do not change; existing numbers are not reissued. In new projects, RFIs are numbered with `BT`
  (`{Gönderen}_{Alıcı}_{Disiplin}_BT_{000}`), transmittals with `GF` (`{Proje}-GF-{Gönderen}-{YYYY}-{0000}`) and actions with `EYL`.
  Old projects continue with `RFI`, `TRM` and `AKS`. The "Standart" preset now writes `BT`; the "ZAVM" preset
  stayed with `RFI` because it continues the customer's Forma coding (`PAS_CNS_{D}_RFI_{001}_{Konu}`).
- **Sub-status label:** "İş sonu" written by the templates becomes "İş Sonu" at server startup
  (`apps/server/src/seeded-labels.ts`). Other manually written labels stay.

Project templates (`apps/server/templates`) and the form library affect only newly created projects and newly added form
templates: template names, approval step names, attribute names and naming standard names became Title Case.
Dashboards created from report templates are user data and do not change.

## Checks

`npm test` also runs the `apps/web/scripts/check-ui-terms.mjs` script. The script searches JSX text, string literals
and template strings in `apps/web/src` for these words: Review, Issue, RFI, Submittal, Transmittal, Markup,
Clash, Dashboard, Viewer, Register and Aksiyon (plurals and suffixed forms such as "Review'lar"). Identifier-like strings (`"review"`,
`"/issues"`, `"?markup="`), object keys, imports, types and comments are skipped. A `ui-terms-ok` comment can be added to a line
where the English word is genuinely needed. For the shared label tables there is `packages/shared/test/terms.test.ts`.

The capitalisation rule is checked by `apps/web/test/app/ui-terms.test.ts`: menu names, Work views, Model and Project Settings
tabs (`apps/web/src/nav.ts`), Work sections and quick filters, names of built-in work types, field and status labels, and the shared `*_LABELS_TR` tables
must be Title Case according to `isTitleCaseTr`. Checkbox and radio button texts are checked too: the script's
`findChoiceLabels()` function collects the own text and the `<strong>` heading of `<label>` elements that contain an `<input type="checkbox|radio">`
(excluding nested `<span>` notes and the description after " — "). Four tables that hold sentences (`ACCESS_VIA_LABELS_TR`, `MODEL_OP_LABELS_TR`,
`ROLE_PACKAGE_ACTION_LABELS_TR`, `STAGE_REVISE_LABELS_TR`) are deliberately excluded.

## Decisions (10.10.2026)

1. **Folder names stay.** The default folders ("01-WIP (Çalışmada)", "02-SHARED (Paylaşılan)", "03-PUBLISHED
   (Yayınlanan)", "04-ARCHIVED (Arşiv)"), "01-Paylaşılan (Shared for Review)" and "04-İş Sonu (As-Built)" in the İBB template, and
   the cover folder "Gönderim formları" stayed as they were.
2. **Number abbreviations:** in new projects, RFI is `BT` and transmittal is `GF` (see above). The other built-in
   abbreviations did not change: `GLN` (incoming letter), `TPL` (meeting), `EYL` (action), form library `BDO`, `TKK`, `GSR`,
   `ISG`, `MKS`, submittal types `MOS`, `NUM`, `UCZ`, `YB`, `IP`, `ISG`, `TR`, `PMR`, `KS`, `IKOF`, `BAS`, `MKF`.
   All are of Turkish origin. The only ones of English origin are the ISO 19650 document
   type codes in the templates' naming standards (`DR`, `RP`, `SP`, `SH`, `CO`, `RF`, `RI`, `DE`, `SD`, `CD`, `MC`, `HO`, `M3`); they stayed
   because they are standard.
3. **Menu:** "Model" → "Model Görüntüleyici". With the 11.10.2026 simplification (docs/product/SIMPLIFICATION.md, phase 1) the menu again has
   "Model"; the viewer is its "Görüntüleyici" (Viewer) tab, next to the "Koordinasyon" (Coordination) and "İş Programı" (Schedule) tabs.
4. **Terms:** "Teknik Onay" and "Gönderim Formu" stay.
5. **Capitalisation rule:** see above; checkbox and radio button texts are Title Case too, the question particle mı/mi/mu/mü stays
   lower case, and the "ZAVM" number preset stays with `RFI`.

## Pending decisions

1. **Technical screens.** On the office editor (WOPI) administration screen, "WOPI", "Proof", "JWT", "Discovery" and the editor's
   own error messages stayed as technical names. Project Settings → Work Types still shows the internal key
   (`rfi`, `aksiyon`, `transmittal`) in lower case in its table. It was left that way because the key did not change.
2. **Research and dated documents.** `docs/archive/ANALIZ.md`, `docs/archive/research/OPENCDE_ARASTIRMA.md`, `docs/archive/research/FORMA_MODUL_YAPILARI.md`,
   `docs/archive/research/ORNEK_PROJELER_PKF_MBE.md`, `docs/product/CONCEPT.md`, `docs/archive/YOL_HARITASI.md`, QA reports and morning summaries refer to Forma/ACC modules by their English
   names. They were not changed because they do not describe the interface.
3. **Template skeleton dimensions.** The dimension names in project templates ("Bölge grubu" (zone group), "Doküman tipi" (document type)) stayed as
   template-internal keys; they appear under these names in the wizard.

- Yes/no checklist items in the form library stay in sentence case (decision 10.10.2026).
