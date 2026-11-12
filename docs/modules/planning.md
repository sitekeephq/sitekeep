# Planning modülü

SiteKeep Planning: İş Programı (Primavera P6 XER, MS Project XML, Excel / CSV içe aktarma, sürümler,
karşılaştırma, Gantt, S-eğrisi) ve 4D (bağlantı kuralları, faaliyet bağları, 4D durumu, görüntüleyicinin
4D paneli). Ürün açıklaması: SiteKeep sürümler ve modüller §2.
Özellik belgesi: [4D / 5D](../features/4D_5D.md).

| | |
|---|---|
| Depo | [7Dimensions-Project/sitekeep-planning](https://github.com/7Dimensions-Project/sitekeep-planning) (kapalı); yerel klon `~/Desktop/7dimensions/sitekeep-planning` |
| Paket | `@7dimensions-project/sitekeep-ee-planning` (GitHub Packages) |
| Bu depodaki sürüm | `0.3.0` (`apps/server/package.json`, `apps/web/package.json`) |
| Kullandığı SDK | `@7dimensions-project/sitekeep-sdk` `>=0.11.0 <1.0.0` |
| Kimlik | `planning` (`SITEKEEP_MODULES`) |

Taşınmadan önceki geçmiş bu depodadır (`apps/server/src/{schedule,sim}`,
`apps/web/src/features/{schedule,sim}`).

## Sınır

5D maliyet Cost'tadır ([cost.md](cost.md)); Cost programlara `planning.schedules` yeteneğiyle erişir.
SDK 0.4.0 ile eski geçici exportlar (`loadActivities`, `scheduleFor`, `refDate`, `canPlan`,
`elementActivities`, `scheduleApi` …) kaldırıldı; bu yüzden Cost `0.2.0` ile birlikte gelir.

Çekirdeğe alınan ortak parçalar:

| Çekirdek | Ne |
|---|---|
| `apps/server/src/core/formats/{xml,zip,text,dates}.ts` | XML okuyucu (BCF de kullanır), ZIP, metin çözme, tarih yardımcıları |
| `apps/server/src/i18n` `Translate`, `defaultTranslate` | Ayrıştırıcıların uyarı dili |
| `apps/server/src/model/versions.ts` | Görünür IFC sürümleri, ayrıntılı indeks (4D ve 5D ortak) |
| `apps/server/src/model/rule-match.ts`, web `shared/ui/RuleMatchEditor.tsx` | Kural motoru ve düzenleyicisi (Cost ile ortak) |
| `apps/web/src/sim.css` | 4D / 5D panel stilleri (`main.tsx` yükler) |

## Pakette ne var

| Yer (depoda) | İçerik |
|---|---|
| `server/index.ts` | Modül: migration'lar, rotalar, `tables`; yüklenirken `planning.schedules` yeteneğini ve `schedule_activities` veri kümesini kaydeder |
| `server/schedule/` | İçe aktarma (XER, MSPDI, Excel / CSV ve formüller), programlar, faaliyetler, sürüm karşılaştırma, rotalar |
| `server/routes.ts`, `service.ts`, `fourd.ts`, `suggest.ts` | 4D: bağlantı kuralları, öneriler, 4D durumu |
| `server/schema-tables.ts` | `schedules`, `schedule_activities`, `schedule_dependencies`, `activity_links`, `schedule_link_rules` |
| `web/` | İş Programı sayfası (Gantt, faaliyet çekmecesi, içe aktarma), 4D paneli, bağlantı kuralları diyaloğu, API istemcisi |
| `migrations/0000_planning` | Kendi günlüğü `drizzle.__drizzle_migrations_planning`; çekirdeğin önceki migration'larından idempotent |

## Çekirdeğe bağlandığı yerler

| Çekirdek | Nasıl |
|---|---|
| Rotalar | `ServerModule.routes` |
| "Bugün": program etiketleri | `planning.schedules.labels` |
| Cost: 5D faaliyetleri, nakit akışı, planlamacı yetkisi | `planning.schedules` |
| Raporlar: `schedule_activities` | modül yüklenirken kaydedilir |
| Görüntüleyici: 4D paneli (`?takvim=1`) | `planning.fourD`; yoksa 4D düğmesi görünmez |
| Menü, sayfa, Model sekmesi, eski adresler | `projectNav` (Planlama grubunun başında), `projectRoutes`; `MODEL_TABS.webModule`, `LEGACY_URLS.module` |
| Geliştirici araçları (demo programı, sıfırlama, tarih kaydırma) | `moduleTable("planning", …)` |

Proje modül anahtarı (`schedule`, proje ayarları) değişmedi: Planning kuruluyken bir projede İş
Programı kapatılabilir.

## Testler

| Yer | Ne |
|---|---|
| `sitekeep-planning`: `npm test` | Sınır kontrolü, Excel formül değerlendiricisi birim testi |
| `apps/server/test/modules/planning/` | İçe aktarma ve program API'si, 4D motoru, 4D + 5D HTTP senaryosu (5D adımları Cost kuruluysa) |
| `e2e/specs/` | iş programı ve 4D senaryoları |

## Çekirdekte kalanlar

Açık iş yok (10.11.2026). Aşağıdakiler bilerek çekirdekte duruyor ya da başka modüllerle paylaşılıyor:

- İş programı DTO'ları, faaliyet durumu etiketleri ve 4D bağlama kuralları pakettedir (`shared/schedule.ts`, `shared/sim.ts`); çekirdeğin de kullandığı faaliyet tarihleri, tarih yardımcıları, kural eşleme ve nakit akışı tipleri çekirdekte. Metinler modülde (`locales/`); Cost'un da kullandığı `schedule` / `sim` anahtarları çekirdekte.
