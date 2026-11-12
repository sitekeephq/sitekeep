# Coordinate modülü

SiteKeep Coordinate: çakışma testleri ve parametre değişikliği talepleri. Ürün açıklaması:
SiteKeep sürümler ve modüller §2. Özellik belgesi:
[Parametre Değişikliği](../features/PARAMETRE_DEGISIKLIGI.md).

| | |
|---|---|
| Depo | [7Dimensions-Project/sitekeep-coordinate](https://github.com/7Dimensions-Project/sitekeep-coordinate) (kapalı); yerel klon `~/Desktop/7dimensions/sitekeep-coordinate` |
| Paket | `@7dimensions-project/sitekeep-ee-coordinate` (GitHub Packages) |
| Bu depodaki sürüm | `0.3.0` (`apps/server/package.json`, `apps/web/package.json`) |
| Kullandığı SDK | `@7dimensions-project/sitekeep-sdk` `>=0.11.0 <1.0.0` |
| Kimlik | `coordinate` (`SITEKEEP_MODULES`) |

Taşınmadan önceki geçmiş bu depodadır (`apps/server/src/{coordination,param-change}`,
`apps/web/src/features/coordination`).

## Sınır

Çekirdekte kalanlar: model setleri ve kayıtlı görünümler (federasyon, görüntüleyici), sorunlar,
işaretlemeler, BCF, IDS kontrolleri (Community'de, karar §8.1-3), model sorgusu ve sürüm
karşılaştırma. Koordinasyon sayfası model setleri ve IDS sekmelerini her zaman, çakışma
testleri sekmesini Coordinate kuruluysa gösterir.

Çakışma ve parametre değişikliği **işçileri** (`apps/server/src/jobs/clash-worker.ts`,
`param-change-worker.ts`) çekirdekte kalır: web-ifc ile çalışan geometri motorlarıdır, kendi
çevirilerini çekirdeğin klasöründen okurlar. Modül onları SDK'nın `runWorker` / `workerFile`'ı ile
çalıştırır.

Yapay zekânın parametre planı şeması çekirdekte: `apps/server/src/contracts/param-change.ts`.

## Pakette ne var

| Yer (depoda) | İçerik |
|---|---|
| `server/index.ts` | Modül: migration'lar, rotalar, `tables`; yüklenirken yetenekleri ve `clash_results` veri kümesini kaydeder |
| `server/routes/clash.ts`, `clash-service.ts`, `clash-access.ts` | Çakışma testleri, çalıştırmalar, sonuçlar, gruplar, durumlar, gruptan sorun, özet |
| `server/param-change/` | Talepler, plan (sorgu + değerler), yapay zekâ planı, IFC'ye uygulama, sonraki sürüm kontrolleri |
| `server/capabilities.ts` | `coordinate.modelSets`, `coordinate.linkTargets`, `coordinate.paramChanges` |
| `server/schema-tables.ts` | `clash_tests`, `clash_runs`, `clash_groups`, `clashes`, `param_change_requests`, `param_change_items`, `param_change_checks` |
| `web/` | Çakışma testleri sekmesi, görüntüleyicinin çakışma paneli, parametre değişikliği sayfaları, dosya çekmecesi parçaları, API istemcisi |
| `migrations/0000_coordinate` | Kendi günlüğü `drizzle.__drizzle_migrations_coordinate`; çekirdeğin 0011, 0020, 0027'sinden idempotent |

## Çekirdeğe bağlandığı yerler

| Çekirdek | Nasıl |
|---|---|
| Rotalar | `ServerModule.routes` |
| Model seti düzenleme / silme (testlerin kullandığı dosyalar) | `coordinate.modelSets` |
| Sorun ↔ çakışma grubu bağı (işaretleme / sorun bağları) | `coordinate.linkTargets` |
| "Bugün": parametre değişikliği etiketleri | `coordinate.paramChanges` |
| Raporlar: `clash_results`; Koordinasyon şablonu | modülle kaydedilir; şablon veri kümesi varsa görünür |
| Manage'in işleri (talebe iş bağlama, etiket) | `manage.workExists`, `manage.workLabels` |
| Koordinasyon sayfası: Çakışma testleri sekmesi | `coordinate.clashTests` |
| Görüntüleyici: çakışma modu (`?clash=…&ct=…`) | `coordinate.viewerClash`; yoksa parametre yok sayılır |
| Dosya çekmecesi: parametre değişikliği düğmesi ve rozeti | `coordinate.paramFile` |
| Menü, sayfalar, Model sekmesi, "+ Yeni" → Değişiklik Talebi, eski adresler | `projectNav`, `projectRoutes`; `MODEL_TABS.webModule`, `LEGACY_URLS.module` |
| Geliştirici araçları | `moduleTable("coordinate", …)` |

## Testler

| Yer | Ne |
|---|---|
| `sitekeep-coordinate`: `npm test` | Sınır kontrolü, çakışma kimliği birim testi |
| `apps/server/test/modules/coordinate/` | Parametre değişikliği API'si |
| `apps/server/test/coordination/coordination.test.ts` | Model setleri ve IDS her zaman; çakışma adımları Coordinate kuruluysa (`hasCoordinate`) |
| `apps/server/test/coordination/{clash-depth,param-change-worker}.test.ts` | Çekirdekteki işçiler |

## Çekirdekte kalanlar

Açık iş yok (10.11.2026). Aşağıdakiler bilerek çekirdekte duruyor ya da başka modüllerle paylaşılıyor:

- Parametre değişikliği DTO'ları ve yardımcıları ile çakışma durumu etiketleri pakettedir (`shared/param-change.ts`, `shared/coordination.ts`); çekirdeğin de kullandığı durum/sahiplik etiketleri, `ParamChangeSettings`, model seti ve çakışma DTO'ları çekirdekte. Metinler modülde (`locales/`); çekirdeğin de kullandığı `coordination` anahtarları çekirdekte.
