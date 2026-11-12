# AI modülü

SiteKeep AI: dil modeli istemcileri (yerel ve bulut sağlayıcılar, kişisel Claude / Cursor anahtarları),
"Projeye Sor", yapay zekâ görev kuyruğu ("Yapay Zekâya Gönder"), yapay zekâ özellik kataloğu, MCP uç
noktası (`/mcp`) ve geliştiricinin yapay zekâ değerlendirmesi. Ürün açıklaması:
SiteKeep sürümler ve modüller §2, §3.2.

| | |
|---|---|
| Depo | [7Dimensions-Project/sitekeep-ai](https://github.com/7Dimensions-Project/sitekeep-ai) (kapalı); yerel klon `~/Desktop/7dimensions/sitekeep-ai` |
| Paket | `@7dimensions-project/sitekeep-ee-ai` (GitHub Packages) |
| Bu depodaki sürüm | `0.4.0` (`apps/server/package.json`, `apps/web/package.json`) |
| Kullandığı SDK | `@7dimensions-project/sitekeep-sdk` `>=0.12.0 <1.0.0` |
| Kimlik | `ai` (`SITEKEEP_MODULES`) |

Taşınmadan önceki geçmiş bu depodadır (`apps/server/src/ai`, `apps/server/src/integrations/mcp`,
`apps/server/src/dev/ai-eval.ts`, `apps/web/src/features/ai`, `AdminAi.tsx`, `ProjectAi.tsx`).

## Sınır: çekirdeğin model kapısı

Çekirdekte modeli kullanan özellikler var: Modele Sor, doküman karşılaştırma özeti, paftadan
isim önerisi, Günün Özeti, rapor taslağı, RFI / toplantı / çeviri taslakları, Poz Öner, form ve
parametre planı taslakları. Bunlar modeli **çekirdeğin kapısından** ister
(`apps/server/src/ai/provider.ts`: `resolveProvider`, `resolveProviderSetup`, `resolveSelectedProvider`).
Kapı gerçek istemciyi `ai.provider` yeteneğinden alır; AI kurulu değilse her çağrı
`403 ai_off` ("Yapay zekâ sistem yöneticisi tarafından kapatıldı.") döner. Özellikler zaten bu
durumda kurallı sonuca düşer ya da düğmeyi gizler; Community'de dışarı model çağrısı yapan kod yoktur.

Çekirdekte kalanlar ve nedeni:

| Çekirdek | Neden |
|---|---|
| `ai/provider.ts` | Kapı: tipler (`AiProvider`, `ChatMessage` …), tek `AiError` sınıfı (`instanceof`), `stripThinking` |
| `ai/settings.ts` | Genel ayar deposu (`system_settings`), AI modu ve sağlayıcı listesi, proje AI politikası; Gizlilik Merkezi okur |
| `ai/hosts.ts` | İç ağ / dış adres kuralı; giden bağlantı kaydı (`privacy/outbound`) kullanır |
| `ai/override.ts` | Bir istek için modelin yerine geçen sağlayıcı (görev kuyruğu cevabı, değerlendirme) |
| `core/platform/ask-bridge.ts` | İstek içi kimlik köprüsü; geliştirici araçları da kullanır |
| `admin/settings.ts` | `GET /admin/settings`, `PUT /admin/settings/mcp`: **API erişim anahtarı politikası** (kim oluşturur, yazma anahtarı, süre). API anahtarları REST ve OpenCDE için de gerekir |
| `@sitekeep/cde-tools` | Araç tanımları; MCP sunucusu modülde, katalog SDK'dan verilir. Katalog yalnız kurulu modüllerin araçlarını sunar (`TOOL_MODULES`, `core/platform/cde-tools.ts`); yerel stdio sunucusu (`apps/mcp`) kurulu modülleri `GET /api/v1/modules` ile öğrenir |
| Modele Sor (`model/`), doküman karşılaştırma ve pafta okuma | Kurallı kısımları Community'nin (FP-1, FP-2); yapay zekâ kısmı kapı üzerinden |

AI kurulu değilken Yönetim'de "Yapay Zekâ ve MCP" sekmesi, proje ayarlarında "Yapay Zekâ" sekmesi,
"Sor" düğmesi, "Yapay Zekâya Gönder" düğmeleri ve hesap sayfasındaki MCP bağlantı örnekleri görünmez.
API anahtarı politikası bu durumda Yönetim → OAuth sekmesinde ayrı bir kartta durur.

## Pakette ne var

| Yer (depoda) | İçerik |
|---|---|
| `server/index.ts` | Modül: migration'lar, rotalar, `rootRoutes` (MCP), `devTools` (`cde_dev_ai_eval`, `cde_dev_ai_check`), `tables`; yüklenirken `ai.provider` ve `ai.tasks` yeteneklerini sağlar |
| `server/provider.ts` | OpenAI uyumlu ve Anthropic istemcileri, gizlilik maskeleme, sağlayıcı seçimi |
| `server/personal.ts` | Kişisel Claude / Cursor anahtarları |
| `server/ask-*.ts`, `run-ask.ts`, `assistant.ts` | "Projeye Sor" |
| `server/tasks.ts`, `features.ts` | Görev kuyruğu ve yapay zekâ özellik kataloğu (şemalar çekirdekten, SDK ile) |
| `server/routes/` | `/admin/settings/ai`, `/admin/ai/providers`, `/me/ai-credentials`, `/projects/:pid/ai`, `/ask`, `/ai-tasks`, `/ai/schemas` |
| `server/mcp/routes.ts` | `/mcp` (Streamable HTTP) |
| `server/schema-tables.ts` | `ai_tasks`, `user_ai_credentials` |
| `web/` | Sor paneli, görev düğmesi ve listesi, Yönetim "Yapay Zekâ ve MCP", proje "Yapay Zekâ" ayarları |
| `migrations/0000_ai` | Kendi günlüğü `drizzle.__drizzle_migrations_ai`; çekirdeğin 0023, 0036, 0039'undan idempotent |

## Çekirdeğe bağlandığı yerler

| Çekirdek | Nasıl |
|---|---|
| Model isteyen her özellik | `ai.provider` (kapı); yoksa `ai_off` |
| Bugün: açık "Günün Özeti" görevi | `ai.tasks` |
| `/api/v1` dışı uç nokta (`/mcp`) | `ServerModule.rootRoutes` (yeni) |
| Geliştirici araçları | `ServerModule.devTools` (yeni), dev yardımcıları SDK'nın "Developer tools" bölümünde |
| Sor paneli, görev düğmesi, yönetici ve proje AI ayarları | web `ai.ui`; çekirdeğin `shared/ai/AiTaskButton` sarmalayıcısı (yoksa düğme yok) |

## Testler

| Yer | Ne |
|---|---|
| `sitekeep-ai`: `npm test` | Sınır kontrolü, yapay zekâ seçeneği seçimi (`ai-options`) |
| `apps/server/test/modules/ai/` | Sağlayıcılar, MCP, görev kuyruğu, Sor |
| Çapraz testler | Model kuran adımlar `hasAi` ile; AI'sız kurulumda `ai_off` ve REST üzerinden geliştirici araçları denenir |
| `apps/web/test/ai/ai-tasks.test.ts` | Çekirdekteki görev kuyruğu istemcisi |

## Çekirdekte kalanlar

Açık iş yok (10.11.2026). Aşağıdakiler bilerek çekirdekte duruyor ya da başka modüllerle paylaşılıyor:

- DTO'lar (`AiProviderDto`, `AskJob` …) çekirdekte; sağlayıcı ön ayarlarını çekirdeğin ayar ekranı da kullanır. Pakette yalnız `isIntakeKind` (`shared/record-intake.ts`). Metinler modülde (`locales/`); çekirdeğin model kapısının kullandığı `ai` anahtarları (ör. `ai_off`) çekirdekte.
- Model çıktı şemaları (`actionsSchema`, `rfiSchema`, `intakeAiSchema`, `flowOutputSchema`, `paramPlanSchema` …) çekirdeğin `apps/server/src/contracts/` klasöründe; hem AI hem Manage / Field / Coordinate kullandığından paylaşımlıdır ve SDK'dan alınır (modüller birbirini import etmez).
- Bir özelliğin rotası başka bir modüldeyse (`FeatureDef.product`: form → Field; toplantı aksiyonları, RFI taslağı, Bırak-kaydet → Manage; parametre değişikliği → Coordinate) o modül kurulu değilken özellik `cde_ai_schemas`'ta listelenmez ve görevi `404 feature_not_installed` ile reddedilir (SDK 0.12.0 `moduleInstalled`).
