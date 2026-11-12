# Manage modülü

SiteKeep Manage: proje yönetimi kategorileri. Bunlar RFI (bilgi talebi), teknik onay (submittal ve
paketleri), toplantı ve tutanak, eylemler, resmi yazışmalar ve şartname kütüğüdür. Ürün açıklaması:
SiteKeep sürümler ve modüller §2, §3.2.

| | |
|---|---|
| Depo | [7Dimensions-Project/sitekeep-manage](https://github.com/7Dimensions-Project/sitekeep-manage) (kapalı); yerel klon `~/Desktop/7dimensions/sitekeep-manage` |
| Paket | `@7dimensions-project/sitekeep-ee-manage` (GitHub Packages) |
| Bu depodaki sürüm | `0.3.1` (`apps/server/package.json`, `apps/web/package.json`) |
| Kullandığı SDK | `@7dimensions-project/sitekeep-sdk` `>=0.11.0 <1.0.0` |
| Kimlik | `manage` (`SITEKEEP_MODULES`) |

## Sınır: İşler motoru çekirdekte

"İşler" (iş tipleri, kayıtlar, numaralandırma, bağlar, olaylar, iş akışı, ekler, mektup ve gönderim
altyapısı, alındı kaydı) çekirdektedir. Nedenleri:

- **Transmittal (gönderim formu)** ISO 19650'nin bilgi gönderimidir ve Community'dedir (ürün belgesi §6, ISO-6). Bir iş kategorisi olarak bu motoru kullanır.
- İncelemeden otomatik transmittal (`works/transmittal-listener.ts`) ve iş akışı şablonlu genel işler de bu motoru kullanır.
- Mektup verisi (konu, alıcı, imzacı, PDF, e-posta, KEP) transmittal kapağı ve gönderim kanallarıyla ortaktır.

Manage bu motorun üstüne kendi kategorilerini ve onlara özgü araçları ekler. Kurulu değilken
`correspondence`, `rfi`, `submittals`, `meetings` ve `spec` proje anahtarları **her projede kapalıdır**
(`apps/server/src/projects/modules.ts` `PRODUCT_SWITCHES`). Saklı ayar korunur; Manage yeniden
kurulunca eski hâline döner. Kapalı anahtarlar mevcut mekanizmayla her yerde geçerlidir. Yeni kayıt
`403 module_disabled` alır. Menüdeki İşler bölümleri, "+ Yeni" seçenekleri, Sor araçları, rapor
kataloğu ve Modüller sekmesi bu kategorileri göstermez. Mevcut kayıtlar açılabilir ve okunabilir.

Çekirdeğe alınan parçalar:

| Çekirdek | Ne |
|---|---|
| `works/detail.ts` | İş akışlı işlerin detay ekleri (`buildDetail`), görünür işler, iş akışı durumu |
| `works/meeting-data.ts` | Toplantı verisinin okunması (detay ve raporlar) |
| `works/routes/work-flow.ts` | `submit`, `respond`, `revise`, `cancel` ve otomatik transmittal dinleyicisi |
| `works/letter-translate.ts` | Mektup çevirisi (yapay zekâ kapısı üzerinden) |
| `contracts/works.ts` | Eylem, RFI taslağı ve "Bırak, kaydet" yapay zekâ şemaları (AI modülü de doğrular) |
| `reports/datasets-works.ts` | `correspondence`, `rfis`, `submittals`, `meetings`, `actions` veri kümeleri; yalnız Manage kuruluyken kaydedilir |
| web `BuildPanel` | İş detayındaki iş akışı paneli |

## Pakette ne var

| Yer (depoda) | İçerik |
|---|---|
| `server/index.ts` | Modül: rotalar |
| `server/routes/build-works.ts` | Teknik onay paketi kalemleri, toplantı (gündem, tutanak, sonraki toplantı, PDF), teknik onay kütüğü ve RFI günlüğü (Excel), şartname kütüğünden içe aktarma, numaralandırma ön ayarı, yapay zekâ ile eylem önerisi ve RFI taslağı |
| `server/routes/intake.ts`, `intake*.ts` | "Bırak, kaydet": PDF / e-posta / Office dosyasından kayıt taslağı, isteğe bağlı yapay zekâ geçişi |
| `server/build.ts`, `meetings.ts`, `build-ai.ts` | Kütükler, toplantılar, yapay zekâ taslakları |
| `web/` | Paket kalemleri, toplantı kutusu, kütük görünümleri, içe aktarma, RFI taslağı, "Bırak, kaydet" (`manage.ui`) |

Kendi tablosu ve migration'ı yoktur; kayıtlar çekirdeğin `works` tablolarındadır.

## Çekirdeğe bağlandığı yerler

| Çekirdek | Nasıl |
|---|---|
| Rotalar | `ServerModule.routes` |
| Proje anahtarları | `PRODUCT_SWITCHES.manage` (kurulu değilse kapalı) |
| Rapor veri kümeleri | Çekirdekte, `moduleInstalled("manage")` ile |
| İş detayı: paket kalemleri, toplantı | web `manage.ui` (`PackageItems`, `MeetingBox`) |
| İşler: kütük ve günlük görünümleri | `manage.ui.RegisterView` |
| Şartname analizi: kütüğü içe aktar | `manage.ui.ImportDialog` |
| Yeni iş: RFI taslağı; "+ Yeni": dosyadan kayıt, İşler'e dosya bırakma | `manage.ui.RfiDraftBox`, `FileRecordDialog`, `FileDropZone` |
| Proje Ayarları → Modüller | Manage anahtarları yalnız kuruluyken görünür |
| `manage.workExists`, `manage.workLabels` | Çekirdeğin İşler motoru sağlar (Cost, Coordinate kullanır) |

## Testler

| Yer | Ne |
|---|---|
| `sitekeep-manage`: `npm test` | Sınır kontrolü, dosyadan kayıtta eşleştirme |
| `apps/server/test/modules/manage/` | Kütükler, toplantılar, iş akışı adımları, "Bırak, kaydet", resmi yazışmalar |
| Çapraz testler | RFI / yazışma / toplantı oluşturan adımlar `hasManage` ile |

## Çekirdekte kalanlar

Açık iş yok (10.11.2026). Aşağıdakiler bilerek çekirdekte duruyor ya da başka modüllerle paylaşılıyor:

- Teknik onay listesi içe aktarma, Bırak-kaydet yardımcıları ve toplantı aksiyonu ayrımı pakettedir (`shared/`); İşler motorunun DTO'ları (iş tipleri, alanlar, cevap seçenekleri, RFI/teknik onay satırları) çekirdekte. Metinler modülde (`locales/`); İşler motorunun `works` anahtarları çekirdekte.
- Manage'siz kurulumda İşler motoru transmittal üzerinden denenir (`test/works/works.test.ts`: gönderim formu, incelemeden otomatik transmittal, taslak görünürlüğü, numaralandırma, liste filtreleri). Alındı zinciri, KEP ve "Bugün" gelen kutusu senaryoları yazışmayla kurulduğundan yalnız Manage kuruluyken çalışır.
- Şartname analizi (`docintel/spec.ts`) çekirdekte; `spec` anahtarı Manage'siz kapalı olduğundan sayfası görünmez.
