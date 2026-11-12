# Connect modülü

SiteKeep Connect kurumsal bağlantıları içerir:
- Autodesk Forma / ACC ile kayıt eşitleme (sorun, inceleme, form, RFI, teknik onay, konum, kullanıcı),
- APS üzerinden dosya içe aktarma,
- ofis dosyalarını tarayıcıda düzenleme (ONLYOFFICE / Collabora için WOPI).

Ürün açıklaması: SiteKeep sürümler ve modüller §2, §3.2.
Özellik belgeleri: [Forma Eşitleme](../features/FORMA_ESITLEME.md).

| | |
|---|---|
| Depo | [7Dimensions-Project/sitekeep-connect](https://github.com/7Dimensions-Project/sitekeep-connect) (kapalı); yerel klon `~/Desktop/7dimensions/sitekeep-connect` |
| Paket | `@7dimensions-project/sitekeep-ee-connect` (GitHub Packages) |
| Bu depodaki sürüm | `0.3.2` (`apps/server/package.json`, `apps/web/package.json`) |
| Kullandığı SDK | `@7dimensions-project/sitekeep-sdk` `>=0.10.0 <1.0.0` |
| Kimlik | `connect` (`SITEKEEP_MODULES`) |

Taşınmadan önceki geçmiş bu depodadır. Sunucuda `apps/server/src/integrations/autodesk`,
`office/{wopi,locks}.ts` ve `admin/forma-sync.ts`; webde `apps/web/src/features/integrations/{components/OfficeEdit,pages/OfficeEditor}.tsx`
ve `features/admin/{pages/AdminFormaSync,pages/ProjectFormaSync,forma-sync}`.

## Sınır

Office: **görüntüleme ve dönüştürme çekirdekte, düzenleme Connect'te.** Çekirdekte kalanlar ve nedenleri:
- Office ayarları (Yönetim → Office: editör ve dönüştürücü adresleri, test) çekirdektedir.
- Office → PDF dönüştürme (ONLYOFFICE, Collabora, Gotenberg, yerel soffice) çekirdektedir; önizlemeler buna bağlıdır.
- Keşif (discovery) ve proof doğrulaması çekirdektedir.
- `wopi_locks` / `wopi_tokens` tabloları çekirdektedir; yeni sürüm yüklemesi düzenleme kilidini kontrol eder.

Connect yokken dosya çekmecesinde "Düzenle" düğmesi ve kilit notu görünmez. `/edit/:fileId` sayfası
ve `/wopi` uç noktaları da yoktur.

Autodesk tamamen modüldedir. Bağlantılar, dış varlıklar ve bağları, eşitleme çalıştırmaları, dosya
içe aktarmaları, zamanlayıcı ve yarım kalan içe aktarmaların sürdürülmesi buraya dahildir. İçe aktarma
çekirdeğin kayıtlarına yazar: sorun, inceleme, iş, konum. Formlar `field.externalForms` yeteneğiyle
yazılır; Field yoksa atlanır.

## Pakette ne var

| Yer (depoda) | İçerik |
|---|---|
| `server/index.ts` | Modül: migration'lar, rotalar, `rootRoutes` (`/wopi`), `start` (eşitleme zamanlayıcısı, yarım kalan içe aktarmalar), `tables` |
| `server/autodesk/` | APS istemcisi, OAuth (PKCE), doküman gezinme, dosya içe aktarma, kayıt eşitleme ve izdüşümü, rotalar |
| `server/office/` | WOPI ana makinesi (`/wopi/files/...`), kilitler, dosya editör uç noktaları (`/files/:id/office`, `/office/session`, `/office/lock`) |
| `server/forma-sync.ts` | `GET /admin/forma-sync` (Yönetim → Forma Eşitleme örnek ekranı) |
| `server/schema-tables.ts` | `autodesk_connections`, `external_entities`, `external_entity_links`, `integration_sync_runs`, `autodesk_file_imports` |
| `web/` | Forma Eşitleme sayfası ve Yönetim bölümü, editör sayfası, "Düzenle" düğmesi, kilit notu (`connect.ui`) |
| `migrations/0000_connect` | Kendi günlüğü `drizzle.__drizzle_migrations_connect`; çekirdeğin 0031, 0040, 0041'inden idempotent |

## Çekirdeğe bağlandığı yerler

| Çekirdek | Nasıl |
|---|---|
| Rotalar; `/wopi` | `ServerModule.routes`, `rootRoutes` |
| Arka plan işleri | `ServerModule.start` (yeni): sunucu açılırken, iş kuyruğundan sonra; kapanırken durdurulur |
| Dosya çekmecesi: Düzenle, kilit | web `connect.ui` (`useFileOffice`, `OfficeEditButton`, `OfficeLockNote`) |
| Yönetim → Forma Eşitleme | `connect.ui.AdminFormaSyncSection`; sekme yalnız kuruluyken |
| Proje sayfaları `edit/:fileId`, `forma-esitleme` | `WebModule.projectRoutes`; `LEGACY_URLS.module` |
| Field formları | `field.externalForms` |

## Testler

| Yer | Ne |
|---|---|
| `sitekeep-connect`: `npm test` | Sınır kontrolü, Forma Eşitleme durum kuralları |
| `apps/server/test/modules/connect/` | Autodesk eşitleme ve dosya içe aktarma, WOPI ve office ayarları |
| `apps/server/test/platform/admin-status.test.ts` | Forma Eşitleme uç noktası `hasConnect` ile |

## Çekirdekte kalanlar

Açık iş yok (10.11.2026). Aşağıdakiler bilerek çekirdekte duruyor ya da başka modüllerle paylaşılıyor:

- Office ayarları ve Office → PDF dönüştürme çekirdekte; ONLYOFFICE'in kaynak dosyayı indirdiği `/wopi/convert/:ticket/:name` de çekirdeğin (`office/routes.ts`, Connect 0.3.2'den önce Connect'teydi ve Connect'siz kurulumda ONLYOFFICE dönüştürme çalışmıyordu). Connect'siz senaryo: `apps/server/test/integrations/office-conversion.test.ts` (ayarlar, Gotenberg, ONLYOFFICE). WOPI editörü Connect'in (`wopi.test.ts`).
- Forma Eşitleme tipleri pakette (`shared/forma-sync.ts`); Autodesk ve Office DTO'ları çekirdekte. Metinler modülde (`locales/`); çekirdekteki Office ayarları ve dönüştürmenin `office` anahtarları çekirdekte.
- `scripts/import-autodesk.ts` (doküman anlık görüntüsü içe aktarma betiği) çekirdekte, Autodesk modül koduna dayanmaz.
