# Field modülü

SiteKeep Field: form şablonları (PDF'ten şablon dahil), formlar, onay akışı ve form PDF'leri.
Ürün açıklaması: SiteKeep sürümler ve modüller §2.
Özellik belgesi: [Form PDF](../features/FORM_PDF.md).

| | |
|---|---|
| Depo | [7Dimensions-Project/sitekeep-field](https://github.com/7Dimensions-Project/sitekeep-field) (kapalı); yerel klon `~/Desktop/7dimensions/sitekeep-field` |
| Paket | `@7dimensions-project/sitekeep-ee-field` (GitHub Packages) |
| Bu depodaki sürüm | `0.3.2` (`apps/server/package.json`, `apps/web/package.json`) |
| Kullandığı SDK | `@7dimensions-project/sitekeep-sdk` `>=0.11.0 <1.0.0` |
| Kimlik | `field` (`SITEKEEP_MODULES`) |

Cost'tan farklı olarak üç adım tek seferde yapıldı (altyapı hazırdı). Taşınmadan önceki geçmiş bu
depodadır (`apps/server/src/modules/forms`, `apps/web/src/features/forms`).

## Sınır

Konumlar (konum ağacı, konum bağları) çekirdekte kalır: sorunlar ve dosyalar da konuma bağlanır.
Bir formun konumu çekirdeğin `location_links` kaydıdır (`kind = "form"`).

Yapay zekâ özellikleri (form şablonu taslağı, iş akışı taslağı, PDF alan adlandırma) Field'ın
rotalarını HTTP ile çağırır; ortak oldukları API sözleşmeleri çekirdekte durur:
`apps/server/src/contracts/forms.ts` (şablon, akış ve adlandırma şemaları; Field SDK'dan alır).

## Pakette ne var

| Yer (depoda) | İçerik |
|---|---|
| `server/index.ts` | Modül: migration'lar, rotalar, Görevlerim kaynağı, geliştirici araçları için `tables`; yüklenirken yetenekleri ve "forms" rapor veri kümesini kaydeder |
| `server/routes/`, `service.ts`, `flow.ts`, `library.ts` | Şablonlar, formlar, ekler, sorunlar, akış, şablon kütüphanesi |
| `server/pdf*.ts` | PDF alan bulma, PDF'e yazma, sayfa düzeni (worker), PDF dışa aktarma |
| `server/capabilities.ts` | `field.forms`, `field.externalForms` |
| `server/schema-tables.ts` | `form_templates`, `form_pdf_sources`, `form_template_versions`, `forms`, `form_attachments`, `form_issue_links` |
| `web/` | Formlar sayfası, form doldurma, PDF şablon sayfası, "+ Yeni" form diyaloğu, çevrimdışı taslaklar |
| `migrations/0000_forms` | Kendi günlüğü `drizzle.__drizzle_migrations_field`; çekirdeğin 0012, 0020, 0021'inden idempotent |

Henüz çekirdekte: web API istemcisinin form çağrıları (`api.formTemplates`, `api.forms` …),
ortak tipler (`packages/shared`), yukarıdaki sözleşmeler. Metinler modüldedir (`locales/`).

## Çekirdeğe bağlandığı yerler

| Çekirdek | Nasıl |
|---|---|
| Rotalar, Görevlerim (form adımları) | `ServerModule.routes`, `taskSources` |
| "Bugün": taslak formlarım; hub etiketleri | `field.forms` (`drafts`, `list`, `link`) |
| Konumlar: forma konum bağlama, etiketler | `field.forms` (`list`) |
| Raporlar: `forms` veri kümesi | modül yüklenirken kaydedilir |
| Raporlar: iş akışı adımlarında form etiketi, konumlara göre form sayıları | `field.forms` (`list`) |
| Autodesk formları (Forma Eşitleme) | `field.externalForms` (`upsert`); Field yoksa formlar atlanır |
| Geliştirici araçları (demo veri, sıfırlama, tarih kaydırma, betikler) | `ServerModule.tables` → `moduleTable("field", …)` |
| Menü, sayfalar, İşler'deki "Formlar" görünümü, eski adresler | `WebModule.projectNav`, `projectRoutes`; `HubView.webModule`, `LEGACY_URLS.module` |
| "+ Yeni" → Form | `field.newFormDialog` |
| PDF fontları | SDK `pdfFontBytes()` |

## Testler

| Yer | Ne |
|---|---|
| `sitekeep-field`: `npm test` | Sınır kontrolü, PDF alan kimliği birim testi (SDK yerine test kopyaları) |
| `apps/server/test/modules/field/` | Formlar API'si, PDF şablonları, alan bulma, PDF'e yazma, akış |
| Çapraz testler (yapay zekâ, MCP, raporlar, hub, geliştirici araçları) | Form adımları `hasField` ile (`test/helpers/modules.ts`) |
| `e2e/specs/` | form senaryoları |

## Çekirdekte kalanlar

Açık iş yok (10.11.2026). Aşağıdakiler bilerek çekirdekte duruyor ya da başka modüllerle paylaşılıyor:

- Form API istemcisi pakettedir (`web/api.ts`, `formsApi`); çekirdeğin `api.ts`'inde yalnız İşler "+ Yeni → Form" için `formTemplates` kalır. Form yapay zekâ özellikleri Field kurulu değilken listelenmez ve kuyruğa alınmaz (AI modülü, `product`). Yalnız Field'ın kullandığı form yardımcıları (değer doğrulama, puanlama, form numarası, şablon benzerliği, akış satırları) pakettedir (`shared/forms.ts`, `shared/form-pdf.ts`); form şablonu ve form DTO'ları çekirdeğin form PDF'i, rapor ve AI tarafları da kullandığından çekirdekte. Metinler modülde (`locales/`).
