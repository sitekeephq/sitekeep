# ÇŞB 2026 file naming (EK-1, EK-2)

The regulation on the digital preparation of architecture and engineering projects of the Turkish
Ministry of Environment, Urbanisation and Climate Change ("Mimarlık ve Mühendislik Projelerinin
Dijital Olarak Hazırlanması Hakkında Yönetmelik", Resmî Gazete 5 August 2026, no. 33331; in force
1 September 2027) names every file submitted with a building permit by a fixed template (EK-2) built
on a project code given by the authority (EK-1). SiteKeep ships it as a built-in naming standard,
**ÇŞB 2026 (EK-2)**, on top of the ordinary [naming standards](DOCUMENT_CODES.md). Community.

```
Proje Kodu_Bina Kodu_Disiplin_Alt Disiplin/Öge_Dosya Türü_Dosya Tipi_Kat/Konum_Sıra No_Revizyon No
270001    _00       _MM      _DUVA             _PL        _MMC       _K01      _01     _000      .dwg
```

35 characters without the extension, nine fields separated by `_`. The regulation gives no example
name; the examples on this page are built from its tables.

## Where it is

- **Turkish construction template** (`iso19650-yapim-tr`, [project templates](PROJECT_TEMPLATES.md)):
  the template brings the profile as a third naming standard next to the ISO 19650 document naming and
  the correspondence naming. The ISO 19650 naming stays the default document code standard.
- **Set-up wizard** ([project set-up wizard](PROJECT_SETUP_WIZARD.md)): step 7 (Document Codes) offers
  **ÇŞB 2026 (EK-2)** as the document code standard. Choosing it also points the folders named by the
  template's document code standard (Shared, Published and below) at the profile; correspondence keeps
  its own naming. Step 3 (Project Basics) asks for the **ÇŞB project code (EK-1)** when the template
  uses it.
- **Any project**: the profile can be created through the API (`POST /projects/:pid/naming-standards`
  with the definition of `csb2026NamingStandard()`) and assigned to folders in Project Settings.

## Fields

| # | Field | Characters | SiteKeep field | Rule |
|---|---|---|---|---|
| 1 | Proje Kodu | 6 | text, 6 × A–Z / 0–9; a one-value list once the EK-1 code is known | EK-1 |
| 2 | Bina Kodu | 2 | text, 2 × A–Z / 0–9, suggestion `00` | 2.3: `00` for a single building |
| 3 | Disiplin | 2 | list | Tablo 2.2 |
| 4 | Alt Disiplin / Öge | 4 | list depending on Disiplin | Tablo 2.3–2.11, `DIGR`, `XXXX` |
| 5 | Dosya Türü | 2 | list | Tablo 2.12 |
| 6 | Dosya Tipi | 3 | list | Tablo 2.13 |
| 7 | Kat / Konum | 3 | text, 3 × A–Z / 0–9, suggestions from Tablo 2.14 | 2.9 |
| 8 | Sıra No | 2 | number, 2 digits | 2.10 |
| 9 | Revizyon No | 3 | number, 3 digits, not part of the document code | 2.11 |

A name is refused when it is longer than 35 characters, when a field has the wrong length or
characters (capital Latin letters and digits only), or when a code is not in its list, including an
Alt Disiplin / Öge code of another discipline (`MM_BETO`: BETO is a Statik code).

### Proje Kodu (EK-1)

The authority gives each project a six-character code: the two-digit year of the application and a
four-digit sequence number of that year (e.g. `270001`). Tablo 2.1 calls the field alphanumeric, so
letters are accepted too. The code is a project attribute: the wizard stores it in the project details
(`details.csbProjectCode`, `POST /projects/from-template`) and the template's `{EK1}` token fills it
into the profile, so Proje Kodu becomes a one-value list: names are suggested with it and other codes
are refused. Without the code (it is often given only when the application is made), Proje Kodu takes
any six capital letters or digits; once it is known, change the field to a list with the code in
Project Settings → Naming (`Proje Kodu | list | 270001`).

### Alt Disiplin / Öge

The list depends on Disiplin (`dependsOn`): each code carries the disciplines whose table lists it
(`parents`), e.g. `AKSR` (Aksesuar) is allowed after `MM` and `IM`, `BETO` only after `ST`. `XXXX`
(Genel, no item) and `DIGR` (Diğer, 2.6) are allowed after every discipline, including Yangın (YN),
Güneş Enerji Sistemi (GS) and Akustik (AK), which have no table of their own. Codes added to the list
(2.6 allows project-specific items) are allowed after every discipline unless they are given parents.

### Kat / Konum

Tablo 2.14 lists the usual floors (`B03` … `B01`, `K00` … `K04`, `NNN` for files independent of a
floor) and continues them (`…`). 2.9.2 allows `KXX` codes chosen by the designer for mezzanines, roof
pieces and plant floors, and 2.9.3 a three-character location code for sections and elevations, so any
three capital letters or digits are accepted; the table codes are offered as suggestions.

### Revizyon No and ISO 19650 revision codes

Revizyon No counts the revisions the authority asks for: `000` for the first submission, then `001`,
`002` … (2.11). It is a field of the name, set by whoever names the file; SiteKeep does not derive it.
It is kept apart from the ISO 19650 codes of every version ([CDE states](CDE_STATES.md#codes)):

| | Revizyon No (EK-2) | ISO 19650 revision (P01, C01 …) |
|---|---|---|
| Counts | Revisions requested by the permit authority | Every shared (P) and published (C) version |
| Where | In the file name | On the version (code profile of the project) |
| Changes | When the authority asks for a revision | With every review and publication |

There is no fixed mapping: a revision requested by the authority usually produces a new contractual
version (C02 after C01) and the next Revizyon No (`001` after `000`), but internal revisions (P02, P03)
do not change Revizyon No. Revizyon No is not part of the [document code](DOCUMENT_CODES.md)
(`inCode: false`): `270001_00_MM_DUVA_PL_MMC_K01_01_000.dwg` and `…_01_001.dwg` are the same document
(code `270001_00_MM_DUVA_PL_MMC_K01_01`): the revision is a new version of the document, and a
separate file with the same code is refused when the project enforces unique codes.

### Dosya Tipi

Tablo 2.13 groups the codes by discipline (Mimari, Statik, Mekanik, Elektrik, Harita, Diğer and "all
disciplines"). The groups are shown in the descriptions below but not enforced: the regulation does not
say that a discipline may only use its own group.

## Deviations from the printed text

| Where | Printed | SiteKeep |
|---|---|---|
| Tablo 2.3, Islak Hacim | `İSLH` (dotted capital I) | `ISLH`, as in Tablo 2.4; `İSLH` is refused |
| Tablo 2.11, Zemin | `IKS`, `KZK`, `ZTE` (3 characters; 2.5 asks for 4) | Kept: such names have 34 characters |
| Tablo 2.1 / EK-1 | Proje Kodu alphanumeric / "a six-digit number" | Six capital letters or digits |
| Tablo 2.1 / 2.8 | Dosya Tipi alphabetic / alphanumeric | List codes as printed |
| Tablo 2.12, KS | "KS (Tip kesitler de dahil)" | Code `KS`, the note in the description |
| Tablo 2.14 | `…` rows | Not listed; any three characters are accepted (2.9.2, 2.9.3) |

## Engine settings used by the profile

The profile is data (`packages/shared/src/kernel/naming-profiles/csb-2026-ek2.json`); the naming engine
(`packages/shared/src/kernel/naming.ts`) gained settings any standard can use:

| Setting | On | Effect |
|---|---|---|
| `maxLength` | standard | Longest name without the extension |
| `dependsOn` | list field | Name of an earlier list field; values with `parents` are allowed only after one of those codes |
| `parents` | list value | Codes of the parent field |
| `charset` | text field | `alphanumeric` (A–Z, 0–9), `alphabetic` (A–Z), `numeric` (0–9) |
| `suggestions` | text field | Codes offered in pick-lists; they do not limit the value |
| `inCode` | any field | `false`: in the name but not in the document code |
| `fixed` | text field, templates only | A value with tokens (`{EK1}`): the field becomes a one-value list when the token resolves |

Project Settings → Naming edits fields as text; settings the text form cannot show (`dependsOn`,
`parents`, `charset`, `suggestions`, `inCode`, `maxLength`) are kept when a field keeps its name and
type.

## Code

| What | Where |
|---|---|
| Tables (as transcribed) | `packages/shared/src/kernel/naming-profiles/csb-2026-ek2.json` |
| The standard | `csb2026NamingStandard()` in `packages/shared/src/kernel/naming-csb2026.ts` |
| Turkish template | `apps/server/templates/src/iso19650-yapim.mjs` (`csbStandard()`, same JSON) |
| Wizard: document code standard switches folders; EK-1 code | `applySetupOverrides`, `checkSetupDetails` in `packages/shared/src/platform/project-setup.ts`; `apps/web/src/features/projects/setup/` |
| Document code without Revizyon No | `documentCodeOf` in `apps/server/src/cde/document-code.ts` |

## Tests

| What | Test |
|---|---|
| Tables, names from the tables, every code with its discipline, refusals (length, codes, characters, discipline), EK-1 code, tokens, engine settings, wizard choices | `packages/shared/test/naming-csb2026.test.ts` |
| Template equals the shared profile; wizard project with the profile (folders, EK-1 code, name checks); without the code; document code; naming API | `apps/server/test/projects/naming-csb2026.test.ts` |
| Wizard draft, request and sample name | `apps/web/test/projects/setup-csb.test.ts` |
| The wizard in the browser: EK-1 code, the profile as document code standard, sample names, the created project | `e2e/specs/naming-csb2026.spec.ts` |

## Planned

The other annexes of the regulation (EK-3 disciplines and spaces, EK-4 CAD layers, EK-5/6 IFC) follow
in their own steps.

## EK-1 Proje kodu belirleme esasları (summary)

1.1.1: before submitting, the designer applies to the authority with the project information of
Tablo 1.1 and receives a project code: two digits of the application year and a four-digit sequence
number restarting each calendar year (six characters). 1.1.2: when files are delivered through a digital
system with a secure electronic signature, the system generates the code from the same information.

**Tablo 1.1** Proje Bilgileri

| Yıl | İl | İlçe | Mahalle | Ada No | Parsel No | Durum |
|---|---|---|---|---|---|---|

## EK-2 tables

Transcribed from the Resmî Gazete; names and codes as printed (see the deviations above).

**Tablo 2.1** Dosya İsimlendirme Şablonu

| Bilgi Alanı | Proje Kodu | Bina Kodu | Disiplin | Alt Disiplin / Öge | Dosya Türü | Dosya Tipi | Kat / Konum | Sıra No | Revizyon No |
|---|---|---|---|---|---|---|---|---|---|
| Karakter Sayısı | 6 | 2 | 2 | 4 | 2 | 3 | 3 | 2 | 3 |
| Veri Türü | Alfanümerik | Alfanümerik | Alfabetik | Alfabetik | Alfabetik | Alfabetik | Alfanümerik | Sayısal | Sayısal |

**Tablo 2.2 Disiplin İsimlendirmesi**

| Disiplin | İsimlendirme |
|---|---|
| Mimari | `MM` |
| İç Mimari | `IM` |
| Statik | `ST` |
| Elektrik | `EE` |
| Mekanik | `MK` |
| Harita | `HR` |
| Altyapı | `AL` |
| Peyzaj | `PY` |
| Zemin | `ZE` |
| Yangın | `YN` |
| Güneş Enerji Sistemi | `GS` |
| Akustik | `AK` |

**Tablo 2.3 Mimari Disiplinine Ait Öge İsimlendirmesi (MM)**

| Öge | İsimlendirme |
|---|---|
| Aks | `AKSS` |
| Aksesuar | `AKSR` |
| Asansör | `ASAN` |
| Asma Tavan | `ASTV` |
| Baca | `BACA` |
| Bitki | `BITK` |
| Bordür | `BORD` |
| Cam | `CAMM` |
| Cephe | `CEPH` |
| Çatı | `CATI` |
| Çatı Kaplama | `CKAP` |
| Çatı Kaplama Tahtası | `CKTA` |
| Çatı Taşıyıcı | `CTAS` |
| Çevre | `CVRE` |
| Çörten | `CORT` |
| Denizlik | `DENZ` |
| Doğrama | `DOGR` |
| Döşeme | `DOSM` |
| Duvar | `DUVA` |
| Duvar Kaplama | `DUVK` |
| Emsal | `EMSL` |
| Giydirme Cephe | `GIYC` |
| Güneş Kırıcı | `GNKR` |
| Harpuşta | `HARP` |
| Hatıl | `HATL` |
| Isı Yalıtımı | `ISYA` |
| Islak Hacim | `ISLH` (printed `İSLH`) |
| Kaldırım | `KALD` |
| Kapı | `KAPI` |
| Kartonpiyer | `KARP` |
| Kolon | `KOLN` |
| Korkuluk | `KORK` |
| Lento | `LENT` |
| Merdiven | `MERD` |
| Oluk | `OLUK` |
| Pencere | `PENC` |
| Rampa | `RAMP` |
| Şap | `SAPP` |
| Ses Yalıtımı | `SESY` |
| Sıva | `SIVA` |
| Su Yalıtımı | `SUYA` |
| Süpürgelik | `SUPR` |
| Taşıyıcı | `TASI` |
| Tavan | `TAVN` |
| Temel | `TEML` |
| Tefriş | `TEFR` |
| Tesviye Betonu | `TSVY` |
| Tretuvar | `TRET` |
| Yağmur İniş Borusu | `YIBO` |
| Yol | `YOLL` |
| Zemin Kaplama | `ZMNK` |
| Genel (Öge kullanılmaması durumunda) | `XXXX` |
| Diğer (Diğer ögeler için) | `DIGR` |

**Tablo 2.4 İç Mimari Disiplinine Ait Öge İsimlendirmesi (IM)**

| Öge | İsimlendirme |
|---|---|
| Ahşap Panel | `PANL` |
| Aksesuar | `AKSR` |
| Asansör | `ASAN` |
| Akustik Panel | `AKUS` |
| Asma Tavan | `ASTV` |
| Aydınlatma Elemanı | `AYDN` |
| Baca | `BACA` |
| Banyo Elemanı | `BNYO` |
| Bitki | `BITK` |
| Bordür | `BORD` |
| Bölücü Panel | `BOLP` |
| Cam | `CAMM` |
| Cam İç Bölme | `CMBL` |
| Cephe | `CEPH` |
| Çatı | `CATI` |
| Çatı Kaplama | `CKAP` |
| Çatı Kaplama Tahtası | `CKTA` |
| Çatı Taşıyıcı | `CTAS` |
| Çevre | `CVRE` |
| Çörten | `CORT` |
| Denizlik | `DENZ` |
| Doğrama | `DOGR` |
| Döşeme | `DOSM` |
| Duvar | `DUVA` |
| Duvar Kaplama | `DUVK` |
| Emsal | `EMSL` |
| Giydirme Cephe | `GIYC` |
| Güneş Kırıcı | `GNKR` |
| Harpuşta | `HARP` |
| Hatıl | `HATL` |
| Isı Yalıtımı | `ISYA` |
| Islak Hacim | `ISLH` |
| Kaldırım | `KALD` |
| Kapı Kanat | `KPKN` |
| Kapı Kasa | `KPKS` |
| Kartonpiyer | `KARP` |
| Klima İç Ünite | `KLIM` |
| Korkuluk | `KORK` |
| Lento | `LENT` |
| Menfez | `MNFZ` |
| Merdiven | `MERD` |
| Mutfak Elemanı | `MTFK` |
| Oluk | `OLUK` |
| Pencere Kanat | `PNKT` |
| Pencere Kasa | `PNKS` |
| Perde | `PRDE` |
| Priz/Anahtar | `PRIZ` |
| Rampa | `RAMP` |
| Şap | `SAPP` |
| Sabit Mobilya | `SMOB` |
| Ses Yalıtımı | `SESY` |
| Sıva | `SIVA` |
| Su Yalıtımı | `SUYA` |
| Süpürgelik | `SUPR` |
| Taşıyıcı | `TASI` |
| Tavan | `TAVN` |
| Temel | `TEML` |
| Tefriş | `TEFR` |
| Tesviye Betonu | `TSVY` |
| Tezgah | `TZGH` |
| Tretuvar | `TRET` |
| Yağmur İniş Borusu | `YIBO` |
| Yol | `YOLL` |
| Zemin Kaplama | `ZMNK` |
| Genel (Öge kullanılmaması durumunda) | `XXXX` |
| Diğer (Diğer ögeler için) | `DIGR` |

**Tablo 2.5 Statik Disiplinine Ait Alt Disiplin İsimlendirmesi (ST)**

| Alt Disiplin | İsimlendirme |
|---|---|
| Betonarme | `BETO` |
| Çelik | `CELK` |
| Yığma | `YIGM` |
| Ahşap | `AHSP` |
| Kompozit | `KMPT` |
| Genel (Alt disiplin kullanılmaması durumunda) | `XXXX` |
| Diğer | `DIGR` |

**Tablo 2.6 Mekanik Disiplinine Ait Alt Disiplin İsimlendirmesi (MK)**

| Alt Disiplin | İsimlendirme |
|---|---|
| Sıhhi Tesisat | `SHTT` |
| Isıtma Tesisat | `ISTT` |
| Havalandırma Tesisat | `HVLT` |
| Soğutma Tesisatı | `SGTT` |
| Temiz Su Tesisatı | `TMST` |
| Pissu Tesisatı | `PIST` |
| Yağmur Tesisatı | `YAGT` |
| Basınçlı Hava Tesisatı | `BSHT` |
| Otomatik Kontrol Tesisatı | `OTMT` |
| Medikal Gaz | `MDGZ` |
| Mutfak Tesisatı | `MUTT` |
| Çamaşırhane Tesisatı | `CMTT` |
| Doğalgaz Tesisatı | `DGTT` |
| Buhar Tesisatı | `BHTT` |
| Müşterek Tesisat | `ORTT` |
| Bahçe Sulama Tesisatı | `BSTT` |
| Havuz Tesisatı | `HVZT` |
| Atık Su Arıtma Tesisatı | `ASTT` |
| Klima Tesisatı | `DSDK` |
| Yangın Tesisatı | `YNGT` |
| Asansör | `ASNR` |
| Genel (Alt disiplin kullanılmaması durumunda) | `XXXX` |
| Diğer | `DIGR` |

**Tablo 2.7 Elektrik Disiplinine Ait Alt Disiplin İsimlendirmesi (EE)**

| Alt Disiplin | İsimlendirme |
|---|---|
| Kuvvetli Akım Tesisatı | `KUVA` |
| Zayıf Akım Tesisatı | `ZAYA` |
| Aydınlatma Tesisatı | `AYDT` |
| Güç Dağıtım Tesisatı -Mekanik Tesisat İçin Güç Dağıtımı Tesisatı-Reaktif Güç Kompanzasyonu | `GUDT` |
| Dizel Jeneratör Grubu Tesisatı | `DJGT` |
| Çevre Aydınlatma Tesisatı | `CAYT` |
| Topraklama Sistemleri Tesisatı -Yıldırımdan Korunma Sistemi | `TOST` |
| Orta Gerilim Enerji Temini (Trafo) | `OGET` |
| Telefon-Bilgi İletişim Ağı-TV Sistemleri Tesisatı | `TBIA` |
| Müzik Yayın, Anons Sistemi-Merkezi Saat Sistemi- Intercom Sistemi | `MYAS` |
| Yangın Algılama ve Alarm Tesisatı-Acil Anons Sistemleri -Acil Durum Aydınlatma ve Yönlendirme Tesisatı | `YAVA` |
| Kapalı Devre TV Sistemleri (CCTV)-Kartlı Geçiş ve Güvenlik Sistemleri | `CTVS` |
| Genel (Alt disiplin kullanılmaması durumunda) | `XXXX` |
| Diğer | `DIGR` |

**Tablo 2.8 Harita Disiplinine Ait Öge İsimlendirmesi (HR)**

| Öge | İsimlendirme |
|---|---|
| Proje Koordinat Bilgisi | `PKBL` |
| Koordinatlar | `KORD` |
| Dönüşüm Bilgisi | `DOSB` |
| Lejant | `LJNT` |
| Poligon | `PLGN` |
| Ada Parsel | `ADPL` |
| Parsel Zemin Kotu | `PZKT` |
| Bina Zemin Kotu | `BZKT` |
| Blok Adı | `BLKA` |
| Komşu Parseller | `KMPL` |
| Çekme Mesafesi | `CKMS` |
| Genel (Öge kullanılmaması durumunda) | `XXXX` |
| Diğer | `DIGR` |

**Tablo 2.9 Altyapı Disiplinine Ait Alt Disiplin İsimlendirmesi (AL)**

| Alt Disiplin | İsimlendirme |
|---|---|
| Yağmur Suyu | `YAGS` |
| Atık Su | `ATIS` |
| İçme Suyu | `ICMS` |
| Genel (Alt disiplin kullanılmaması durumunda) | `XXXX` |
| Diğer | `DIGR` |

**Tablo 2.10 Peyzaj Disiplinine Ait Alt Disiplin İsimlendirmesi (PY)**

| Alt Disiplin | İsimlendirme |
|---|---|
| Yapısal | `YAPS` |
| Bitkisel | `BITS` |
| Genel (Alt Disiplin kullanılmaması durumunda) | `XXXX` |
| Diğer | `DIGR` |

**Tablo 2.11 Zemin Disiplinine Ait Öge İsimlendirmesi (ZE)**

| Öge | İsimlendirme |
|---|---|
| İksa | `IKS` |
| Kazık | `KZK` |
| Zemin ve Temel | `ZTE` |
| Genel (Öge kullanılmaması durumunda) | `XXXX` |
| Diğer | `DIGR` |

**Tablo 2.12 Dosya Türü İsimlendirmesi**

| Dosya Türü | İsimlendirme |
|---|---|
| Plan | `PL` |
| Kesit (Tip kesitler de dahil) | `KS` |
| Görünüş | `GR` |
| Detay | `DT` |
| Şema | `SM` |
| Model | `MD` |
| Form | `FR` |
| Liste | `LS` |
| Doküman | `DK` |
| Rapor | `RP` |
| Hesap | `HS` |
| Genel | `GN` |

**Tablo 2.13 Dosya Tipi İsimlendirmesi**

| Grup | Dosya Tipi | İsimlendirme |
|---|---|---|
| MİMARİ DOSYA TİPLERİ | Mimari Çizim | `MMC` |
| MİMARİ DOSYA TİPLERİ | Mimari Açıklama Raporu | `MAP` |
| MİMARİ DOSYA TİPLERİ | Erişilebilirlik Çizimi | `ERP` |
| MİMARİ DOSYA TİPLERİ | Yangın Kaçış ve Güvenlik Planları | `YKG` |
| MİMARİ DOSYA TİPLERİ | Çatı Planı ve Detayları | `CAT` |
| MİMARİ DOSYA TİPLERİ | Vaziyet Planı | `VAZ` |
| MİMARİ DOSYA TİPLERİ | Mimari Hesap Raporu | `MIR` |
| STATİK DOSYA TİPLERİ | Statik Çizim | `STC` |
| STATİK DOSYA TİPLERİ | Statik Hesap Raporu | `SHR` |
| STATİK DOSYA TİPLERİ | İskele Çizimi | `ISC` |
| STATİK DOSYA TİPLERİ | İskele Hesap Raporu | `IHR` |
| MEKANİK DOSYA TİPLERİ | Mekanik Çizim | `MKC` |
| MEKANİK DOSYA TİPLERİ | Isıtma Tesisatı Hesap Raporu | `ITH` |
| MEKANİK DOSYA TİPLERİ | Isı Yalıtım Projesi Hesap Raporu | `IYP` |
| MEKANİK DOSYA TİPLERİ | Isı Kaybı Isı Kazanç Hesapları Raporu | `IKR` |
| MEKANİK DOSYA TİPLERİ | Enerji Kimlik Belgesi Ön Hesap Raporu | `EKB` |
| MEKANİK DOSYA TİPLERİ | Asansör Trafik Hesabı | `ASN` |
| MEKANİK DOSYA TİPLERİ | Mekanik Özel Teknik Şartname | `MTS` |
| ELEKTRİK DOSYA TİPLERİ | Elektrik Çizim | `ELC` |
| ELEKTRİK DOSYA TİPLERİ | Akim Kontrolü Ve Gerilim Düşümü Hesabi | `AGH` |
| ELEKTRİK DOSYA TİPLERİ | Trafo Güç Hesabı | `TGH` |
| ELEKTRİK DOSYA TİPLERİ | Aydınlatma Hesap Raporu | `AHR` |
| ELEKTRİK DOSYA TİPLERİ | Elektrik Özel Teknik Şartname | `ETS` |
| HARİTA DOSYA TİPLERİ | Yapı Aplikasyon Projesi | `YAP` |
| DİĞER DOSYA TİPLERİ | Diğer Çizim | `DIC` |
| DİĞER DOSYA TİPLERİ | Diğer Raporlar | `DGR` |
| TÜM DİSİPLİNLERDE OLABİLECEK DOSYALAR | Malzeme Listesi | `MLZ` |
| TÜM DİSİPLİNLERDE OLABİLECEK DOSYALAR | Mahal Listesi | `MHL` |
| TÜM DİSİPLİNLERDE OLABİLECEK DOSYALAR | Tip yok | `XXX` |
| TÜM DİSİPLİNLERDE OLABİLECEK DOSYALAR | Model Kontrol Formu | `MKF` |

**Tablo 2.14 Kat İsimlendirmesi**

| Kat/Konum | İsimlendirme |
|---|---|
| … | … |
| 3. Bodrum Kat | `B03` |
| 2. Bodrum Kat | `B02` |
| 1. Bodrum Kat | `B01` |
| Zemin Kat | `K00` |
| Kat 1 | `K01` |
| Kat 2 | `K02` |
| Kat 3 | `K03` |
| Kat 4 | `K04` |
| … | … |
| Kattan Bağımsız | `NNN` |
