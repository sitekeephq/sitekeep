# Cost modülü

SiteKeep Cost: sözleşme ve hakediş, IFC metraj envanteri ve metraj onayı, 2B metraj, 5D maliyet ve
Poz Öner. Ürün açıklaması: SiteKeep sürümler ve modüller §2.
Özellik belgeleri: [Metraj](../features/METRAJ.md), [Metraj Onayı](../features/METRAJ_ONAYI.md),
[2B Metraj](../features/2B_METRAJ.md), [Poz Öner](../features/POZ_ONERI.md), [4D / 5D](../features/4D_5D.md).

| | |
|---|---|
| Depo | [7Dimensions-Project/sitekeep-cost](https://github.com/7Dimensions-Project/sitekeep-cost) (kapalı); yerel klon `~/Desktop/7dimensions/sitekeep-cost` |
| Paket | `@7dimensions-project/sitekeep-ee-cost` (GitHub Packages) |
| Bu depodaki sürüm | `0.6.1` (`apps/server/package.json`, `apps/web/package.json`) |
| Kullandığı SDK | `@7dimensions-project/sitekeep-sdk` `>=0.11.0 <1.0.0` |
| Kimlik | `cost` (`SITEKEEP_MODULES`) |

Ayrılış: #24 (SDK sınırı), #26 (kendi paketi, migration günlüğü, Community derlemesi), ardından
`sitekeep-cost` deposu. Taşınmadan önceki geçmiş bu depodadır.

## Sınır

5D maliyet (birim fiyat, maliyet kuralı, Poz Öner, maliyet sonuçları) önceden `sim/` altında
Planning'in parçasıydı. Hakediş ve metraj tabloları `cost_items`'a bağlı olduğu için Cost'a alındı.
Planning'de 4D (bağlantı kuralları, 4D durumu) kalır. İki tarafın ortak kural motoru çekirdekte:
`apps/server/src/model/rule-match.ts`.

5D rotaları önceki gibi İş Programı modül anahtarına (`schedule`) bağlıdır.

## Pakette ne var

| Yer (depoda) | Yayımlanan | İçerik |
|---|---|---|
| `server/index.ts` | `dist/server/index.js` (`./server`) | Modül tanımı: migration'lar, rotalar, hatırlatmalar, Görevlerim kaynağı, rapor veri kümeleri |
| `server/contracts/` | `dist/server/contracts/` | Sözleşme, kalem, zeyilname, teminat, hakediş, onay akışı, hakediş PDF / Excel |
| `server/quantities/` | `dist/server/quantities/` | Metraj envanteri, 2B metraj, metraj onayı |
| `server/fived/` | `dist/server/fived/` | Birim fiyat, maliyet kuralı, içe aktarma, Poz Öner, maliyet ve nakit akışı |
| `server/schema/` | `dist/server/schema/` | 13 tablo: `contracts`, `contract_items`, `contract_variations`, `contract_guarantee_reminders`, `progress_payments`, `progress_payment_lines`, `takeoff_items`, `takeoff_scales`, `quantity_approvals`, `quantity_bindings`, `cost_items`, `cost_rules`, `poz_mappings` |
| `web/` | `dist/web/index.js` (`./web`, tek dosya) | Sayfalar, menü, yetenekler |
| `migrations/` | `migrations/` | Kendi Drizzle günlüğü |

Yayımlanan kod küçültülmüştür, kaynak ve source map içermez. `./internal/*` yalnız bu deponun
Cost testleri içindir (`dist/server/*`), API değildir.

Metinler pakettedir (`locales/server`, `locales/web`: `contracts`, `quantities` ve 5D'nin `sim` anahtarları). Ortak tiplerden yalnız Cost'un kullandıkları pakettedir (`shared/`: sözleşme ve hakediş, metraj envanteri, metraj onayı, Poz Öner, 2B metraj hesapları (`takeoff`), boşluk düşümü (`openings`), 5D maliyet kuralları ve özeti (`sim`); `./shared/*`). Sözleşme, hakediş ve maliyet miktarı etiketleri de pakettedir (Türkçe `*_LABELS_TR`, İngilizce `locales/shared/en/labels.json`). Çekirdekte kalanlar çekirdeğin de kullandıklarıdır: 2B metraj DTO'ları ve çizgi/alan hesabı, `OpeningSolid`, kural eşleme, maliyet satırı ve nakit akışı DTO'ları (`cost` yeteneği, rapor veri kümeleri); modül bunlara `@7dimensions-project/sitekeep-sdk/shared` ile erişir.

## Migration'lar

| Cost | Önceki çekirdek adı |
|---|---|
| `0000_fived` | `0025_sim_4d_5d` içindeki `cost_items`, `cost_rules` (+ rapor tetikleyicileri) |
| `0001_contracts_payment` | `0042_contracts_payment` |
| `0002_contracts_payment_extras` | `0043_…` |
| `0003_contracts_payment_workflow` | `0044_…` |
| `0004_poz_mappings` | `0045_…` |
| `0005_takeoff` | `0046_…` |
| `0006_quantity_approvals` | `0047_…` |

Günlük tablosu `drizzle.__drizzle_migrations_cost`; çekirdeğinkilerden sonra çalışır (`db/index.ts`).
Hepsi idempotenttir (`IF NOT EXISTS`, `duplicate_object` yakalama, `CREATE OR REPLACE TRIGGER`).
Mevcut kurulumlarda (canlı, `v1.0.0-rc1`) tablolar zaten var: Cost günlüğü ilk açılışta yedi kaydı
yazar, veritabanında değişiklik olmaz (`apps/server/test/modules/cost/migrations.test.ts`). Çekirdeğin
`0025`'i değiştirilmedi; Community kurulumunda boş `cost_items` / `cost_rules` oluşur, temiz açık
kaynak deposunda çekirdek günlüğü sıfırdan başlarken çıkarılır.

`contract_variations.work_id` → Manage'in `works` tablosu: yabancı anahtar yalnız `works` varsa
eklenir (`0001`), kod tarafı bunu `manage.workExists` yeteneğiyle denetler.

## Çekirdeğe bağlandığı yerler

| Çekirdek | Nasıl |
|---|---|
| Yükleme | `SITEKEEP_MODULES` → `app/modules.ts` (sunucu), `virtual:sitekeep-modules` (web) |
| Migration'lar | `ServerModule.migrations` → `db/index.ts` |
| Rotalar | `ServerModule.routes` → `build-app.ts` |
| Hatırlatmalar (hakediş adımı, teminat vadesi) | `ServerModule.reminders` → `workflow/reminders.ts` |
| Görevlerim (hakediş onayı) | `ServerModule.taskSources` → `workflow/routes/notifications.ts` |
| Raporlar (`sozlesmeler`, `hakedisler`, `model_costs`, `cost_cashflow`) | Modül yüklenirken `reportDatasets.register`; "Maliyet (5D)" şablonu veri kümeleri varsa görünür |
| Hakediş PDF fontları | SDK `pdfFontBytes()` (çekirdeğin `assets/fonts`'u) |
| Proje menüsü, sayfalar | `WebModule.projectNav`, `projectRoutes` |
| 4D paneli, İş Programı | `cost` yeteneği |
| Programlar, faaliyetler, planlamacı yetkisi (5D) | `planning.schedules` (Planning yoksa maliyet faaliyetlere bağlanmaz) |
| PDF / DWG görüntüleyici | `cost.takeoff` yeteneği |
| Zeyilnameye iş bağlama | `manage.workExists` yeteneği (Manage sağlar) |
| Yapay zekâ araçları (`cde_cost_summary`, `cde_quantity_inventory`) | HTTP rotaları üzerinden; import yok |

## Testler

| Yer | Ne |
|---|---|
| `sitekeep-cost`: `npm test` | Sınır kontrolü (`scripts/check-boundary.mjs`), saf yardımcıların birim testleri (SDK yerine test kopyaları) |
| `apps/server/test/modules/cost/` | Uygulamayı kurarak: sözleşme / hakediş / onay akışı API'si, metraj ve 2B metraj, metraj onayı, Poz Öner, 5D hesap ve içe aktarma, migration'lar |
| `apps/server/test/simulation/sim-api.test.ts` | 4D + 5D senaryosu; 5D adımları Cost kuruluyken koşar |
| `e2e/specs/` | `contracts*`, `quantities*`, `quantity-approvals`, `takeoff`, `poz-suggest` ve mobil karşılıkları |

Davranış testleri burada durur çünkü yayımlanan paketi gerçek çekirdekle çalıştırır. Cost'ta değişiklik
→ `sitekeep-cost`'ta `npm pack`, burada tarball'ı kurup testler (depo README'si), sonra yayın ve sürüm
yükseltme ([Modül sürümü yükseltme](README.md#modül-sürümü-yükseltme)).

## Sonra

- Cost'a özel ortak tipleri pakete almak (çekirdeğin yetenek tipleri ayrıştırılınca).
- Davranış testlerini modül deposunun CI'ında da koşmak (çekirdeğin yayımlanmış imajına karşı).
