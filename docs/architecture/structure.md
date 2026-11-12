# SiteKeep Repository Structure & Architecture Rules
## 1. Amaç, kapsam ve yetki
Bu belge SiteKeep repository'sinin yaşayan ve bağlayıcı mimari sözleşmesidir. Amaçları:
- güncel monorepo yapısını tarif etmek; her dizinin ve dosya türünün sahibini belirlemek;
- bağımlılık yönlerini açık tutmak; güvenlik, gizlilik ve proje izolasyonunu varsayılan yapmak;
- yeni kodun doğru yere eklenmesini kolaylaştırmak; backend, frontend, ortak paketler ve MCP arasında tek bir sözleşme kurmak;
- inceleme ve Definition of Done ölçütlerini standartlaştırmaktır.
Kapsam:
- `apps/server`; `apps/web`;
- `apps/mcp`; `packages/shared`;
- `packages/cde-tools`; testler;
- veritabanı migration'ları; kök build ve çalışma düzeni;
- mimari belgeler.
Bu belge tarihsel bir taşıma planı değildir. Diskteki mevcut refaktör edilmiş yapı esastır. Eski düz `src/routes`, `src/pages` veya `src/components` yerleşimleri yeni kod için mimari yüzey değildir. Bir çelişkide öncelik sırası:
1. güvenlik ve veri izolasyonu;
2. çalışan API sözleşmesi ve migration güvenliği;
3. bu belge;
4. feature belgeleri;
5. yerel uygulama tercihi.
Bu belgeyi güncelleme sorumluluğu:
- mimari sınırı değiştiren geliştiriciye; yeni workspace, domain veya public API ekleyen kişiye;
- code review yapan ekip sahibine aittir.
Kod yapısı değiştiği halde bu belge değişmiyorsa değişiklik tamamlanmış sayılmaz.
### 1.1 RFC tarzı kural sözcükleri
Bu belgede:
- **MUST / ZORUNLU:** İstisnasız varsayılandır; sapma yazılı mimari kararla gerekçelendirilir; **MUST NOT / YASAK:** Yeni kodda uygulanamaz.
- **SHOULD / ÖNERİLİR:** Güçlü varsayılandır; sapma incelemede açıklanır; **SHOULD NOT / KAÇINILMALIDIR:** Ancak somut fayda ve düşük risk varsa seçilir.
- **MAY / OLABİLİR:** Bağlama göre serbest tercihtir.
“Mevcut kod böyle” tek başına istisna gerekçesi değildir.
## 2. Monorepo ve çalışma alanları
Repository npm workspaces kullanan tek bir monorepo'dur. Kök:
```text
7d-cde/
├── apps/
│   ├── server/
│   ├── web/
│   └── mcp/
├── packages/
│   ├── shared/
│   ├── cde-tools/
│   └── sdk/              modüllerin çekirdeğe eriştiği paket (@7dimensions-project/sitekeep-sdk)
├── docs/                 server/ (bizim canlı), onprem/ (müşteri kurulumu), product/, features/…
├── deploy/               deploy.sh (canlıya), onprem/ (kurulum paketi, docs/onprem/kurulum-paketi.md)
├── tools/                harden-dist.mjs (sürüm derlemesini küçültür; Dockerfile)
├── .github/workflows/    ci.yml, release.yml (v* etiketi → kurulum paketi)
├── package.json
├── package-lock.json
├── tsconfig.base.json
├── Dockerfile
└── docker-compose.yml
```

Node.js sürümü kök `package.json` gereği **22 veya üstüdür**:

```json
{ "engines": { "node": ">=22" } }
```

Paket yöneticisi npm'dir. `package-lock.json` authoritative lock dosyasıdır.

### 2.1 Workspace sorumlulukları
| Workspace | Sahiplik |
|---|---|
| `@sitekeep/server` | Fastify API, güvenlik, kalıcılık, storage, job ve entegrasyonlar |
| `@sitekeep/web` | React uygulaması, kullanıcı etkileşimi ve görüntüleyiciler |
| `@sitekeep/mcp` | stdio MCP taşıma adaptörü ve yerel dosya kabiliyeti |
| `@sitekeep/shared` | Ortak saf sözleşmeler, sabitler ve domain kuralları |
| `@sitekeep/cde-tools` | Transport-bağımsız CDE/MCP araç tanımları |

### 2.2 Workspace bağımlılık yönü
İzin verilen ana yön:

```text
apps/web ────────────────> packages/shared
apps/web ────────────────> @7dimensions-project/bim-viewer
apps/server ─────────────> packages/shared
apps/server ─────────────> packages/cde-tools
apps/mcp ────────────────> packages/cde-tools
packages/cde-tools ──────> packages/shared
packages/shared ─────────> harici runtime-bağımsız kütüphaneler
sitekeep-<id> (modül deposu) → @7dimensions-project/sitekeep-sdk (çekirdeğe yalnız SDK ile; docs/modules/README.md)
apps/server, apps/web ───> @7dimensions-project/sitekeep-ee-<id> yalnız paket adıyla, çalışırken (app/modules.ts)
```

Yasak yönler:

```text
packages/shared ─X─> herhangi bir apps/*
packages/cde-tools ─X─> apps/server veya apps/web
packages/cde-tools ─X─> DB, Drizzle veya storage
apps/web ─X─> apps/server kaynak dosyaları
apps/server ─X─> apps/web kaynak dosyaları
app/package ─X─> başka paketin src içindeki derin yolu
```

Paketler yalnız package public export yüzeyinden import edilir:

```ts
// İyi
import type { WorkSummary } from "@sitekeep/shared";
// Kötü
import type { WorkSummary } from "../../../packages/shared/src/works/work-summary";
```

### 2.2.1 Harici özel paket: `@7dimensions-project/bim-viewer`

IFC / 3B model motoru bu monorepoda değildir. `apps/web` onu GitHub Packages'tan
sürümlü bağımlılık olarak alır:

- paket: `@7dimensions-project/bim-viewer`
- kaynak depo: https://github.com/7Dimensions-Project/7dimensions-bim-viewer
- kurulum: kök `.npmrc` → `npm.pkg.github.com`; `NODE_AUTH_TOKEN` + `read:packages`
- pin: `apps/web/package.json` (`--save-exact`; geçerli sürüm oradadır, 08.11.2026'da `0.4.6`)

CDE sarıcıdır: `features/coordination/pages/Viewer.tsx` ve ilgili HUD/araçlar
`bim-viewer`, `bim-viewer/react`, `bim-viewer/tools` public export'larından gelir.
Kesit kutusu, federasyon, ölçü, Fragments/That Open motor değişikliği paket
deposunda yapılır; yayınlanan sürüm CDE'de yükseltilir. Motor `vendor/*.tgz` olarak
gömmeyin; `apps/web` paketin `src`'sine derin import yapmaz.

### 2.3 Kök script'ler ve kesin sıra
Kök `package.json` script'leri:

```text
dev
  server dev ve web dev süreçlerini birlikte başlatır
build
  shared
  → cde-tools
  → server
  → mcp
  → web
test
  shared build
  → cde-tools build
  → shared test
  → cde-tools test
  → server test
  → web test
typecheck
  typecheck script'i olan bütün workspace'leri kontrol eder
e2e
  production server/web build'ini Chromium ile kritik yol testlerine açar
scenarios
  shared build
  → cde-tools build
  → server scenarios
```

Tam komutlar:

```bash
npm run dev
npm run build
npm test
npm run typecheck
npm run e2e
npm run scenarios -- <argümanlar>
```

Build sırası değiştirilmemelidir. `shared` declaration çıktıları `cde-tools`, server ve web tarafından kullanılır. `cde-tools`, server ve MCP'den önce derlenir. Web en son derlenir. `e2e`, önceden üretilmiş server ve web `dist` çıktılarını kullanır.

## 3. Genel mimari ilkeler
SiteKeep:
- tek monorepo; modüler monolit backend;
- feature-first frontend; REST üzerinden konuşan MCP araç paketi;
- ortak saf domain paketi; uzun işler için kalıcı job kuyruğu
olarak geliştirilir. Temel akış:

```text
HTTP route / React page / MCP host
        ↓
service / feature API / tool definition
        ↓
domain kuralı ve access kararı
        ↓
DB / storage / REST / provider adaptörü
```

Zorunlu kurallar:
- Component page import etmez; Service route import etmez.
- Shared app import etmez; CDE tools DB'ye erişmez.
- Paket iç dosyasına deep import yapılmaz; Import cycle oluşturulmaz.
- Güvenlik kararı frontend veya MCP'ye bırakılmaz; Aynı iş kuralı route, UI ve tool içinde ayrı ayrı kopyalanmaz.
- Yeni ekran veya kullanıcıya görünen geliştirme, unit, masaüstü e2e ve mobil smoke yazılmadan bitmiş sayılmaz. Kural: [Testler](testler.md).

## 4. Güncel repository ağacı ve sahiplik

### 4.1 `apps/server`
Güncel üst seviye yapı:

```text
apps/server/
├── drizzle/
├── scripts/
├── src/
│   ├── access/
│   ├── admin/
│   ├── ai/
│   ├── app/
│   ├── auth/
│   ├── bcf/
│   ├── coordination/
│   ├── core/
│   │   ├── platform/
│   │   └── security/
│   ├── db/
│   ├── dev/
│   ├── doccompare/
│   ├── docintel/
│   ├── files/
│   ├── integrations/
│   │   ├── autodesk/
│   │   └── mcp/
│   ├── jobs/
│   ├── locations/
│   ├── model/
│   ├── modules/
│   │   ├── documents/
│   │   └── forms/
│   ├── oauth/
│   ├── office/
│   ├── opencde/
│   ├── param-change/
│   ├── previews/
│   ├── privacy/
│   ├── projects/
│   ├── reports/
│   ├── schedule/
│   ├── scripts/
│   ├── sdk/                # modüllerin çekirdeğe tek giriş noktası
│   ├── sim/
│   ├── templates/
│   ├── today/
│   ├── workflow/
│   ├── works/
│   └── index.ts
├── test/
├── package.json
├── drizzle.config.ts
└── tsconfig.json
```

Sahiplik:
- `src/app/`: Fastify composition root ve dependency sözleşmesi; `src/core/platform/`: HTTP hata modeli, audit, storage, secret, process altyapısı.
- `src/core/security/`: auth, rol, access ve token scope; `src/db/`: Drizzle bağlantısı ve schema export'ları.
- `drizzle/`: sıralı SQL migration'ları ve metadata; domain dizinleri: kendi route, service, access ve yardımcıları.
- `src/jobs/`: queue ve CPU/uzun işlem worker'ları; `src/admin/`: sistem yöneticisi (kullanıcı, firma, `GET /admin/status`).
- `src/auth/`: oturum, şifre ve Google ile giriş (§7.1). `src/oauth/` bunun karşıtı: CDE'nin OpenCDE OAuth2 sunucusu.
- `src/integrations/`: üçüncü taraf adaptörleri.
- `test/`: kategori bazlı backend integration ve davranış testleri.
- `src/sdk/`: modüllerin çekirdekten kullanabildiği tek yüzey (`bind.ts` onu modüllere açar); `src/app/modules.ts`: kurulu modülleri (`SITEKEEP_MODULES`) paket adıyla yükler. Modüller kendi depolarındadır ve sabit sürümlü paket olarak gelir (`@7dimensions-project/sitekeep-ee-<id>`). Kurallar ve yetenekler: [Modüller](../modules/README.md).

### 4.2 `apps/web`

```text
apps/web/
├── scripts/
├── src/
│   ├── app/
│   │   ├── context/
│   │   ├── layout/
│   │   ├── navigation/
│   │   ├── providers/
│   │   └── routes/
│   ├── features/
│   │   ├── admin/
│   │   ├── ai/
│   │   ├── auth/
│   │   ├── coordination/
│   │   ├── documents/
│   │   ├── forms/
│   │   ├── contracts/
│   │   ├── integrations/
│   │   ├── project-settings/
│   │   ├── projects/
│   │   ├── reports/
│   │   ├── reviews/
│   │   ├── schedule/
│   │   ├── sim/
│   │   └── works/
│   ├── shared/
│   │   ├── api/
│   │   ├── lib/
│   │   └── ui/
│   ├── viewers/
│   │   ├── cad/
│   │   └── office/
│   ├── pdf/
│   ├── main.tsx
│   ├── styles.css
│   └── theme.css
├── test/
├── package.json
├── tsconfig.json
└── vite.config.ts
```

Sahiplik:
- `app`: composition, router, provider, layout ve global context; `features`: domain sayfaları, bileşenleri, hook'ları ve domain API'leri.
- `sdk`: modüllerin web çekirdeğinden kullanabildiği tek yüzey; `app/modules.ts`: kurulu modüller (`virtual:sitekeep-modules`, `sitekeep-modules.ts`) ([Modüller](../modules/README.md)).
- `shared/api`: transport ve birden çok feature'ın kullandığı API adaptörleri; `shared/ui`: domain bağımsız UI primitive'leri.
- `shared/lib`: saf ve domain bağımsız frontend yardımcıları; `viewers`: CAD/office ve genel viewer yaşam döngüsü. IFC/3B motor `@7dimensions-project/bim-viewer` (bkz. §2.2.1).
- `features/admin`: Yönetim (kullanıcı, yapay zekâ, Office, OAuth, Gizlilik, Sistem Durumu, Forma Eşitleme). Sistem Durumu: §4.8. Forma: §4.9.
- `features/auth`: `/login`. Google düğmesi `GET /auth/methods` `google` bayrağına bağlıdır (§7.1).
- `pdf`: PDF.js, karşılaştırma ve worker sınırı.

### 4.3 `apps/mcp`

```text
apps/mcp/
├── src/
│   ├── index.ts
│   └── ai-connector.ts
├── package.json
└── tsconfig.json
```

`index.ts` stdio MCP host'udur. REST taban URL'sini ve bearer token'ı kullanır. Yerel dosya upload/download kabiliyeti yalnız bu hostta açılır. Araç iş mantığı burada kopyalanmaz.

### 4.4 `packages/shared`

```text
packages/shared/
├── src/
│   ├── coordination/
│   ├── core/
│   ├── contracts/
│   ├── documents/
│   ├── forms/
│   ├── kernel/
│   ├── platform/
│   ├── reports/
│   ├── schedule/
│   ├── viewers/
│   ├── workflow/
│   ├── works/
│   └── index.ts
├── test/
├── README.md
└── package.json
```

Domain sahiplikleri:
- `kernel`: permission, naming, attributes ve genel saf temel kurallar; `core`: temel tipler, modül tanımları ve modül state'i.
- `documents`: doküman zekâsı, karşılaştırma, Docs+ ve OpenCDE sözleşmeleri; `coordination`: coordination, BCF, model query, CAD bounds ve param change.
- `forms`: form, PDF ve PDF source sözleşmeleri; `workflow`: workflow, roller, assignee ve review chain sözleşmeleri.
- `works`: work catalog, access, numbering, letters, intake ve özetler; `schedule`: schedule ve sim sözleşmeleri.
- `contracts`: sözleşme kartı, birim fiyat cetveli, zeyilname, teminat ve hakediş DTO'ları; saf `calculateProgressPaymentTotals` (kümülatif, avans mahsubu, teminat, stopaj, damga, KDV ve tevkifat).
- `reports`: rapor ve report-frame sözleşmeleri; `viewers`: viewer, markup ve office sözleşmeleri.
- `platform`: hub, OAuth, privacy, template, locations, terms ve AI preset'leri.

### 4.5 `packages/cde-tools`

```text
packages/cde-tools/
├── src/
│   ├── core/
│   │   ├── define.ts
│   │   ├── register.ts
│   │   ├── result.ts
│   │   └── types.ts
│   ├── format/
│   │   ├── common.ts
│   │   ├── lists.ts
│   │   ├── schedule.ts
│   │   ├── workflow.ts
│   │   └── works.ts
│   ├── tools/
│   │   ├── modules/
│   │   ├── ai.ts
│   │   ├── bcf.ts
│   │   ├── core-rest.ts
│   │   ├── dev.ts
│   │   ├── model.ts
│   │   ├── param-change.ts
│   │   └── report.ts
│   └── index.ts
├── test/
└── package.json
```

### 4.6 Test dizinleri
Backend kategorileri:

```text
apps/server/test/
├── ai/
├── auth/
├── coordination/
├── documents/
├── fixtures/
├── forms/
├── integrations/
├── platform/
├── projects/
├── reports/
├── schedule/
├── simulation/
├── viewers/
├── workflow/
└── works/
```

Frontend kategorileri:

```text
apps/web/test/
├── ai/
├── app/
├── documents/
├── integrations/
├── viewers/
└── works/
```

Paket testleri:

```text
packages/shared/test/
packages/cde-tools/test/
```

Kök uçtan uca testleri:

```text
e2e/
├── fixtures/
├── specs/
├── support/
├── playwright.config.ts
└── README.md
```

`e2e/`, üretim server/web derlemesine karşı çalışan kritik kullanıcı yolculuklarının
sahibidir. Harness, veri ve veritabanını her koşuda izole eder; kullanım ve genişletme
kuralları için [E2E test rehberine](../../e2e/README.md) bakın. Yeni ekranda unit, masaüstü
e2e ve mobil smoke zorunluluğu [Testler](testler.md) belgesindedir.

### 4.7 `docs`

```text
docs/
├── architecture/
├── archive/
├── features/
├── onboarding/
├── product/
├── server/
└── README.md
```

`architecture` bağlayıcı teknik kuralları içerir. `features` çalışan özelliklerin davranış belgeleridir (`GOOGLE_GIRIS.md` dahil). `onboarding` kurulum ve geliştirme rehberleridir (yerel Google: `onboarding/GOOGLE_GIRIS.md`). `product` ürün dili ve kapsamıdır. `server` canlı kurulum, erişim ve canlı sonrası işletim notlarıdır (`server.md`, `yedekleme.md`, `izleme.md`, `forma-esitleme.md`); sır içermez. `archive` araştırma, planlama ve tarihli yol haritasıdır; uygulama sözleşmesi değildir.

### 4.8 Yedekleme ve Sistem Durumu

Lisanslı üründe izleme Grafana/SSH değildir; CDE **Yönetim → Sistem Durumu**.
Yedek aynı paketin işidir (`jobs` türü `backup`, henüz yok). Sözleşme ve “bugün /
gerçeğe geçmek”: [Yedekleme](../onprem/yedekleme.md), [İzleme](../onprem/izleme.md).

- Sunucu: `src/admin/status.ts`, `GET /api/v1/admin/status` (`requireAdmin`).
  Geliştirmede `STATUS_DEMO=1` örnek sayılar basar; üretimde `0` — o makinenin
  diski / RAM / `jobs` sayımı.
- Web: `features/admin/pages/AdminStatus.tsx`; menü `app/navigation.ts`
  (`sistem-durumu`, `systemAdmin`). Kart ve modal kabuktur; yedek işi, kopya
  silme, türev temizleme ve 24 saat çizgisi henüz gerçek veriye bağlı değil.
- Onay kutusu: `shared/ui/Ask.tsx` + `ConfirmDialog` (Chrome `confirm` yok).
- `backup` iş türü §10 kuyruğuna eklenince Şimdi Yedekle / gece 02:00 bağlanır.
  Ayrı Dkron paneli yok.

### 4.9 Forma dosya eşitleme

Kayıt eşitlemesi (sorun, inceleme) `src/integrations/autodesk/` ve Proje
Ayarları → Autodesk. **Dosya** motoru (Data Management, imzalı akış) henüz
yok. Ekibe gösterilen kabuk: **Yönetim → Forma Eşitleme**. Sözleşme ve
“bugün / gerçeğe geçmek”: [Forma eşitleme](../features/FORMA_ESITLEME.md).
Tasarım girdisi (sözleşme değil):
Yedekleme ve Forma Eşitleme §2.

- Sunucu: `src/admin/forma-sync.ts`, `GET /api/v1/admin/forma-sync`
  (`requireAdmin`). Örnek eşleme ve son tur; `configured` yalnız APS env.
- Web: `features/admin/pages/AdminFormaSync.tsx` (Yönetim → örnek eşleme ekranı; Şimdi
  Eşitle / Eşleme Ekle kabuk, ACC’ye dosya inmez). Proje menüsündeki `forma-esitleme`
  (`adminOnly`) canlı ekrandır: `ProjectFormaSync.tsx` (bağlantı, Getir, Aktarım).
- Motor `jobs` türü (örn. `forma-sync`) §10’a eklenince aynı ekran bağlanır.
  forma-mcp ürüne gömülmez.

## 5. Backend composition ve katmanlar

### 5.1 Composition root
`apps/server/src/index.ts` process bootstrap sahibidir. Burada:
- config environment'tan okunur; DB açılır ve migration uygulanır;
- storage oluşturulur; `JobQueue` oluşturulur;
- converter ve provider adaptörleri oluşturulur; `buildApp` çağrılır;
- queue ve scheduler'lar başlatılır; shutdown sinyalleri kapatılır.
`apps/server/src/app/build-app.ts` HTTP composition root'udur. Burada:
- Fastify oluşturulur; cookie ve multipart kaydedilir;
- auth hook'u kurulur; privacy/outbound context kurulur;
- security header'ları eklenir; `/api/v1` route'ları kaydedilir;
- WOPI, OAuth, OpenCDE Documents ve MCP özel yüzeyleri kaydedilir; gerekirse web build'i sunulur.
`apps/server/src/app/deps.ts` dependency sözleşmesidir. `AppDeps` testlerin ve bootstrap'ın sağladığı bağımlılıkları tanımlar. `ResolvedDeps` `buildApp` default'ları uyguladıktan sonraki türdür. Domain kodu global singleton aramak yerine dependency almalıdır.

### 5.2 Domain route yerleşimi
Yeni route domainin yanında bulunur:

```text
src/projects/routes.ts
src/reports/routes.ts
src/locations/routes.ts
src/modules/documents/routes.ts
```

Büyük route yüzeyi orchestrator + parçalar olarak ayrılır:

```text
src/modules/forms/routes.ts
src/modules/forms/routes/
  shared.ts
  templates.ts
  instances.ts
  attachments.ts
  issues.ts
  pdf-templates.ts
  pdf-export.ts
src/works/routes/works.ts
src/works/routes/
  route-helpers.ts
  work-items.ts
  work-actions.ts
  work-links.ts
  work-today.ts
  work-types.ts
```

Orchestrator:
- alt route kayıt sırasını belirler; ortak prefix ve ortak dependency'yi geçirir;
- domain işi veya büyük sorgu içermez.
Alt route:
- params/query/body doğrular; access helper çağırır;
- service/use-case çağırır; HTTP response üretir.

### 5.3 Dosya türü sahipliği
`routes.ts` veya `routes/*.ts`:
- HTTP method, URL, header, status; Zod boundary validation;
- multipart ve stream; service çağrısı.
`schema.ts`, `*-schemas.ts`, `template-schemas.ts`:
- runtime request veya config validation; şemadan türeyen tipler.
`service.ts`:
- use-case orchestration; domain durum geçişi;
- transaction kararı; job enqueue ve adaptör koordinasyonu.
`access.ts`, `*-access.ts`, `policy.ts`:
- görünürlük ve izin kararı; proje/klasör/rol kapsamı;
- deny-by-default guard'ları.
`dto.ts`:
- stabil dış response şekli; DB veya provider modelinden güvenli mapping.
`public.ts`:
- büyük modülün dışarı açtığı dar kayıt yüzeyi; iç route parçalarını saklayan facade.
`helpers.ts` veya `*-helpers.ts`:
- yalnız aynı domain içinde anlamlı, isimlendirilmiş tekrar; iş kuralını belirsiz “utils” klasörüne saklamaz.
`repository.ts` **opsiyoneldir**. Yalnız şu durumlarda değerlidir:
- karmaşık sorgu birden çok use-case'te tekrar kullanılıyorsa; sorgu için test double gerçek fayda sağlıyorsa;
- query composition domain anlamı taşıyorsa.
Her tablo için repository oluşturulmaz. Okunabilir, tek kullanımlı Drizzle sorgusu service veya açık domain helper içinde kalabilir.

### 5.4 Bağımlılık kuralları
İzin verilen:

```text
route → schema/access/service
service → access/domain/db/storage/job/provider
worker → saf worker input/output ve altyapı
domain helper → shared saf tipleri
```

Yasak:

```text
service → route
access → route
DB schema → Fastify request
worker → Fastify request/reply
domain → web component
route A → route B'nin handler'ı
```

Başka domainle işbirliği route üzerinden değil:
- service/public fonksiyon; ortak saf contract;
- job/event; REST adaptörü
ile yapılır.

## 6. Veritabanı ve migration kuralları

### 6.1 DB yüzeyi
`apps/server/src/db/index.ts`:
- PostgreSQL veya PGlite açar; migration uygular;
- typed `Db` verir; close yaşam döngüsünü sahiplenir.
`memory://` yalnız test/geliştirme içindir. Üretimde PostgreSQL önerilir.

### 6.2 Schema
Ana export `apps/server/src/db/schema.ts` içindedir. Feature tabloları `schema-*.ts` dosyalarında ayrılır. Yeni tablo:
- primary key taşır; proje kaynağıysa `projectId` taşır;
- foreign key davranışını açık seçer; filtre/sıralama ihtiyacına göre index taşır;
- timestamp anlamlarını açık adlandırır; sorgulanacak temel alanı gelişigüzel JSON'a gömmez.
DB satırı API DTO'su değildir. Secret, hash, storage key ve dahili kolonlar response'a sızdırılmaz.

### 6.3 Proje kapsamı
Her project-owned sorgu proje kapsamlıdır. İyi:

```ts
where(and(eq(records.projectId, projectId), eq(records.id, recordId)))
```

Kötü:

```ts
where(eq(records.id, recordId))
```

İstemciden gelen `projectId`, `userId`, `companyId` veya role ID güvenilir değildir. Kimlik server auth context'inden alınır. URL'deki proje üyeliği `projectAccess` benzeri merkezi guard ile doğrulanır.

### 6.4 Transaction
Transaction zorunludur:
- birden çok yazım birlikte başarılı olmalıysa; numara/sıra ayırma yarışı varsa;
- state ve audit kaydı atomik olmalıysa; workflow adımı ile kaynak durumu birlikte değişiyorsa.
Transaction içinde yapılmaz:
- LLM çağrısı; SMTP;
- dış HTTP; büyük dosya dönüşümü;
- worker sonucu bekleme.
Önce tutarlı DB durumu yazılır. Sonra job veya güvenli post-transaction etki başlatılır.

### 6.5 Migration
Migration'lar `apps/server/drizzle/` altındadır. Config:

```text
apps/server/drizzle.config.ts
schema: ./src/db/schema*.ts
out: ./drizzle
```

Komut:

```bash
npm run db:generate -w @sitekeep/server
```

Kurallar:
- schema değişikliği migration olmadan tamamlanmaz; sıra numarası çakışmaz;
- mevcut üretim verisi var kabul edilir; rename/drop için expand–migrate–contract düşünülür;
- backfill bounded ve tekrar çalıştırılabilir olur; generated snapshot elle rastgele düzenlenmez;
- migration hem PostgreSQL hem desteklenen PGlite davranışıyla uyumlu olmalıdır.

## 7. Auth, izolasyon ve token scope
Varsayılan politika deny-by-default'tur. `buildApp` içindeki `/api/v1` hook'u açıkça `public` olmayan route için auth ister. `apps/server/src/core/security/access.ts`:
- project membership; token proje sınırı;
- folder tree; effective permission;
- action guard'ları
için merkezi yüzeydir. `apps/server/src/core/security/token-scope.ts` HTTP yöntemi ve route semantiğine göre read/write enforcement yapar. Kurallar:
- browser session yazma yetkili kabul edilse bile domain access ayrıca kontrol edilir; API token `read`/`write` scope'una uyar;
- API token `projectIds` sınırını aşamaz; OAuth token granted scope'u aşamaz;
- sistem admin bypass'ı merkezi ve görünürdür; üye olmayan kullanıcıya kaynak varlığı sızdırmamak için gerektiğinde 404 dönülür;
- frontend'de buton gizlemek authorization değildir.
Her endpoint şu soruları cevaplar:
1. Çağıran kim?
2. Token türü ve scope'u ne?
3. Hangi projeye erişiyor?
4. Kaynak gerçekten o projeye mi ait?
5. Klasör/rol/iş akışı izni yeterli mi?
6. İşlem audit gerektiriyor mu?
7. Veri dışarı çıkıyor mu?

### 7.1 Google ile giriş

CDE oturumu. OpenCDE OAuth2 sunucusu (§11.2) değildir. Sözleşme ve hatalar:
[Google ile giriş](../features/GOOGLE_GIRIS.md). Yerel üç satır:
[Yerel Google ile giriş](../onboarding/GOOGLE_GIRIS.md).

- Üç env birden: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_CALLBACK_URL`. Biri boşsa `googleAuth` yoktur; düğme yok.
- `GET /auth/methods` `{ password: true, google: boolean }`. Web yalnız
  `google: true` iken **Google ile devam et** çizer.
- Google doğrulanmış e-posta verir. CDE `users.email` (küçük harf) ile
  bakar. Kayıt yoksa `auth.google` izinli alanı (`domainAllowlistEnabled`
  + `domains`) eşleşirse yönetici olmayan kullanıcı açılır. `disabled`
  veya alan uyuşmazsa `account_not_allowed`. Ayar: Yönetim → Kullanıcılar.
- Dış çağrı `outboundFetch(..., { connection: "google" })`, amaç
  `giris:google`. `state` httpOnly çerez; uyuşmazsa callback oturum açmaz.
- Callback tarayıcı origin'idir (`localhost:5173` / `sitekeep.ornek.com`),
  API portu değil. Sır source control'a girmez (§12).

## 8. Hata, audit, privacy ve outbound

### 8.1 Hata modeli
`apps/server/src/core/platform/http.ts` authoritative HTTP hata yüzeyidir. Beklenen hata `HttpError` ve stabil code ile ifade edilir. Zod hatası `validation` olarak 400 döner. Unique ihlali kontrollü 409'a çevrilir. Beklenmeyen hata:
- error ring'e kaydedilir; server loguna yazılır;
- istemciye yalnız `internal` ve güvenli mesaj döner.
Stack trace, SQL, filesystem yolu, token veya provider body istemciye dönmez. Hata yutulmaz:

```ts
// Kötü
catch { return null; }
```

### 8.2 Audit
`apps/server/src/core/platform/audit.ts` iş audit'inin ortak yüzeyidir. Audit:
- kullanıcı; proje;
- stabil action; target type/id;
- minimum güvenli metadata
içerir. Belge içeriği, secret ve token audit'e yazılmaz.

### 8.3 Privacy ve outbound
`apps/server/src/privacy/`:
- privacy ayarları; redaction;
- outbound kayıtları; security header'ları
için sahibidir. Dış HTTP veya AI çağrısı:
- outbound policy'den geçer; kullanıcı/proje/feature context'i taşır;
- timeout kullanır; hassas içeriği loglamaz;
- response'u güvenilir kabul etmez.
`buildApp` URL loglarında WOPI/OAuth token, code, verifier ve conversion ticket'larını redakte eder.

## 9. Storage, upload ve streaming
`apps/server/src/core/platform/storage.ts` storage sözleşmesi ve local adaptör sahibidir. Kurallar:
- kullanıcı dosya adı storage path olmaz; storage key server tarafından üretilir;
- path traversal engellenir; boyut ve dosya sayısı multipart limitleriyle sınırlanır;
- MIME ve uzantı tek başına güvenilir kabul edilmez; checksum ve versiyon metadata'sı korunur;
- büyük dosya belleğe tamamen alınmadan stream edilir; download response'unda güvenli content type/disposition kullanılır;
- geçici dosya `finally` ile temizlenir; archive extraction zip-slip ve decompression bomb riskini sınırlar.

## 10. Jobs ve worker'lar
`apps/server/src/jobs/queue.ts` kalıcı job queue sahibidir. Mevcut worker alanları:

```text
jobs/ifc-worker.ts
jobs/ifc-spatial-worker.ts
jobs/clash-worker.ts
jobs/ids-worker.ts
jobs/param-change-worker.ts
jobs/version-index.ts
```

Job payload:
- küçük; JSON serializable;
- ID ve sürüm referanslı; secret içermeyen;
- mümkünse versiyonlanabilir
olur. Worker:
- idempotent veya duplicate-safe olur; queued/running/done/failed durumlarını doğru yazar;
- timeout ve kaynak sınırı uygular; stale kaynak durumunu kontrol eder;
- kullanıcıya görünür kalıcı hata üretir; request/reply nesnesi almaz.
CPU ağırlıklı parser/dönüştürücü worker thread/process sınırında tutulabilir. Route uzun işi doğrudan çalıştırmaz; job enqueue eder ve uygun yerde 202 döner.
`backup` türü henüz kayıtlı değildir; sözleşmesi [Yedekleme](../onprem/yedekleme.md).
Zamanlayıcı Autodesk / hatırlatma ile aynı sınıfta kalır (ayrı Dkron yok).

## 11. Entegrasyon yüzeyleri

### 11.1 Autodesk
`apps/server/src/integrations/autodesk/`:
- OAuth/PKCE; provider client;
- route; projection;
- sync scheduler; provider adaptörleri
için sahibidir. Provider DTO doğrudan iç domain DTO'su yapılmaz. Token'lar encrypted-at-rest yaklaşımına uyar.
Bugün yalnız **kayıt** (sorun, inceleme, form). Klasör/dosya eşitleme §4.9
örnek ekrandır; Data Management henüz yok.

### 11.2 OpenCDE ve OAuth
`apps/server/src/opencde/` OpenCDE Documents/pages yüzeyidir. `apps/server/src/oauth/` OAuth2 server, foundation discovery, consent ve token lifecycle sahibidir. Bu yüzeylerin bir bölümü `/api/v1` dışında standart gereği yayınlanır. Standart path ve payload'lar uygulama içi kolaylık için keyfî değiştirilemez. Bu, kullanıcının Google ile CDE'ye girmesi (§7.1) değildir.

### 11.3 WOPI ve office
`apps/server/src/office/`:
- WOPI host; discovery/proof;
- editor/converter ayarları; office service
için sahibidir. WOPI token'ları query/log/redirection sınırlarında redakte edilir. Proof verification production'da güvenli default ile çalışır.

### 11.4 Hosted MCP
`apps/server/src/integrations/mcp/routes.ts` hosted MCP transport sahibidir. Araç tanımları `@sitekeep/cde-tools` üzerinden alınır. Hosted MCP local filesystem erişimini açmaz.

### 11.5 AI
`apps/server/src/ai/`:
- provider seçimi; prompt oluşturma;
- tool schema/routing; Ask bridge;
- task orchestration
için sahibidir. Kurallar:
- provider transport ile domain prompt ayrı tutulur; prompt içine secret konmaz;
- tool çağrısı backend authorization'ı atlamaz; Ask kendi DB yolunu açmaz; mevcut güvenli araç/REST yüzeyini kullanır;
- model çıktısı `unknown` kabul edilip doğrulanır; timeout ve output limit zorunludur;
- dış AI için privacy/outbound izni zorunludur; provider anahtarı loglanmaz veya response'a dönmez;
- model kararı tek başına yıkıcı işlem başlatmaz.

## 12. Config ve secret'lar
Process environment yalnız bootstrap ve ilgili adapter config sınırında okunmalıdır. Yeni domain service doğrudan `process.env` okumamalıdır. Config:
- başlangıçta parse edilir; boolean/string/number açık dönüştürülür;
- kritik eksikte fail-fast davranır; testte explicit fixture ile sağlanır.
Secret:
- source control'a girmez; `.env.example` yalnız isim ve güvenli örnek içerir;
- URL, error, audit ve loglarda redakte edilir; default production secret verilmez;
- encryption key DB/storage ile birlikte yedeklenir ama ayrı korunur; plain token yalnız oluşturma anında gösterilir.
Google girişi adları (değer yok): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_CALLBACK_URL`. Üçü bootstrap'te `googleAuthFromEnv` ile okunur.

## 13. Frontend sınırları

### 13.1 `app`
`apps/web/src/main.tsx`:
- React root; QueryProvider;
- BrowserRouter; AuthProvider;
- global CSS
composition sahibidir. `apps/web/src/app/App.tsx` auth bootstrap sonucu ile route yüzeyini bağlar. `apps/web/src/app/routes/AppRoutes.tsx` authoritative route ağacıdır. `app/layout` shell ve project shell'i sahiplenir. `app/context` auth, project ve embedded context'lerini sahiplenir. Feature iş mantığı `app` içine konmaz.

### 13.2 Feature
Bir feature şunları sahiplenebilir:

```text
features/<domain>/
├── pages/
├── components/
├── api.ts
├── hooks/
└── saf domain frontend yardımcıları
```

Her alt klasörü oluşturmak zorunlu değildir. Page:
- route parametresini okur; query/mutation hook'larını bağlar;
- loading/error/empty/success durumlarını düzenler; feature component'lerini compose eder.
Component:
- page import etmez; route ağacını bilmez;
- mümkünse props/callback ile davranır; ham endpoint string'i içermez.
Hook:
- tekrar kullanılan state/effect veya query davranışını kapsüller; render üretmez;
- authorization kararı vermez.
Feature API:
- domain endpoint'lerini adlandırır; request/response DTO'larını kullanır;
- transport ayrıntısını `shared/api/client.ts` üzerinden yürütür.

### 13.3 Shared
`shared/ui`:
- Dialog; LoadingIndicator;
- Icon; FilterBar;
- genel input/list/card primitive'leri
gibi domain bağımsız UI içindir. Domain etiketi veya iş akışı bileşeni yalnız iki yerde kullanılıyor diye shared yapılmaz. `shared/lib` saf, küçük ve domain bağımsız yardımcılar içindir. `utils.ts` çöplüğü oluşturulmaz.

### 13.4 Viewer ve PDF
IFC / 3B motor `@7dimensions-project/bim-viewer` paketindedir (§2.2.1). `apps/web`
sarıcı, proje bağlamı, model listesi ve CDE araçlarını sahiplenir. `viewers` CAD/office
ve genel viewer yaşam döngüsünü sahiplenir. `pdf` PDF.js ve PDF karşılaştırma
worker'larını sahiplenir. Kurallar:
- viewer route'ları lazy load edilir; Three.js, IFC, CAD, office ve PDF bağımlılıkları ana bundle'a zorla alınmaz;
- worker URL/kopyalama düzeni `apps/web/scripts/copy-worker.mjs` ile uyumlu kalır; unmount'ta renderer, scene, controls, worker, object URL ve event listener temizlenir;
- büyük model ve sayfalar progressive yüklenir; viewer hatası tüm uygulamayı çökertmez;
- motor davranışı (kesit, federasyon, Fragments) pakette değişir; CDE yalnız pinlenen sürümü yükseltir.

## 14. Frontend veri ve state
State sınıfları:
1. server state;
2. URL state;
3. form draft state;
4. geçici UI state.
Server state için TanStack Query varsayılandır. Global defaults `app/providers/QueryProvider.tsx` içindedir. Kurallar:
- aynı server verisi birden çok local state'e kopyalanmaz; query key proje ve resource ID'yi içerir;
- route değişiminde eski proje verisi gösterilmez; mutation sonrası hedefli invalidation yapılır;
- optimistic update yalnız rollback tanımlıysa yapılır; double submit engellenir;
- stale response yarışı AbortSignal veya query lifecycle ile önlenir; URL'de paylaşılması gereken filtre/sekme/ID local state'e saklanmaz;
- form draft gereksiz global context'e konmaz.
Her veri görünümü:
- ilk loading; background refresh;
- empty; error;
- unauthorized/not found; success
durumlarını ayırır.

## 15. Frontend transport ve domain API
`apps/web/src/shared/api/client.ts` yalnız:
- `/api/v1` prefix; credentials;
- JSON serialize/parse; `ApiError`;
- 401 olayı; AbortSignal
sahibidir. Component içinde ham `fetch` kullanılmaz. Feature domain API örneği:

```ts
// İyi: features/forms/api.ts
export const getForm = (projectId: string, formId: string, signal?: AbortSignal) =>
  get<FormDto>(`/projects/${projectId}/forms/${formId}`, { signal });
```

Kötü:

```ts
// Component içinde
fetch(`/api/v1/projects/${pid}/forms/${id}`);
```

Upload, download ve stream farklı response türleri olarak açık yönetilir. Backend error code korunur; UI mesajı status string eşleştirmesine indirgenmez.

## 16. Routing, layout ve context
Route tanımı `app/routes/AppRoutes.tsx` altında merkezidir. Navigation metadata `app/navigation/` altında tutulur. Layout:
- top-level shell; project shell;
- outlet; navigation;
- global notification
sorumluluğunu taşır. Context yalnız geniş alt ağacın gerçekten paylaştığı stabil değere ayrılır. Context'e:
- bütün server state; her dialog state'i;
- feature'a özel form draft'ı
konmaz. Route guard UX sağlar; backend access kontrolünün yerine geçmez. Legacy URL redirect yalnız `app/routes/LegacyProjectRedirect.tsx` gibi açık adaptörde tutulur.

## 17. React, UX ve effects
`useEffect` yalnız React dışı sistemle senkronizasyon içindir:
- event listener; timer;
- viewer; DOM API;
- subscription.
Render sırasında türetilebilen değer effect ile state'e kopyalanmaz. Effect:
- cleanup yapar; bağımlılıkları doğru belirtir;
- async yarışı iptal eder; lint suppression varsa nedenini açıklar.
Optimistic UX:
- kullanıcının niyetini hemen gösterebilir; geçici ID ve rollback tanımlar;
- conflict durumunu görünür yapar; server sonucunu authoritative kabul eder.
Error UI:
- kullanıcıya ne olduğunu söyler; güvenliyse retry sunar;
- teknik iç hata sızdırmaz.
Empty UI:
- gerçekten boş durum ile filtre sonucu boş durumunu ayırır; yetkili kullanıcıya uygun next action sunar.

## 18. CSS, tasarım, erişilebilirlik ve responsive
Global foundation:

```text
src/theme.css
src/styles.css
src/viewers/viewers.css
```

Kurallar:
- renk, spacing ve typography token'ları tekrar kullanılır; domain durumu yalnız renkle anlatılmaz;
- inline style yalnız gerçek dinamik geometri için kullanılır; yeni sayfa rastgele yeni görsel dil oluşturmaz;
- desktop ve dar ekran birlikte tasarlanır; geniş tablo için overflow/sticky/phone stratejisi tanımlanır;
- layout shift azaltılır.
Erişilebilirlik:
- her input label veya accessible name taşır; button davranışı `div` üzerine kurulmaz;
- klavye erişimi sağlanır; dialog focus trap ve focus return uygular;
- loading `role="status"` veya eşdeğer anlam taşır; form hatası alanla ilişkilendirilir;
- kontrast yeterlidir; canvas/viewer için metinsel alternatif veya açıklama değerlendirilir;
- reduced motion tercihi gereksiz animasyonda dikkate alınır.
Performans:
- route/viewer lazy loading; listelerde pagination/virtualization;
- aramada debounce; object URL/worker cleanup;
- ölçülmüş memoization; bundle büyümesini izleme
uygulanır.

## 19. Frontend import sözleşmesi
Web `moduleResolution: Bundler` kullanır. Yerel frontend importlarında mevcut convention gereği uzantı yazılmaz:

```ts
import { Dialog } from "../../../shared/ui/Dialog";
```

Shared package yalnız root public API'den alınır:

```ts
import type { UserDto } from "@sitekeep/shared";
```

Kurallar:
- component → page importu yasaktır; shared → feature importu yasaktır;
- feature → başka feature'ın derin component yolu kaçınılmalıdır; type için `import type` kullanılır;
- cycle oluşturulmaz; app composition feature'ı import edebilir;
- feature app layout'unu import etmez.

## 20. `packages/shared` kuralları
Tek public package entry:

```text
packages/shared/src/index.ts
```

Package `exports` yalnız `"."` yayınlar. Uygulamalar leaf deep import yapmaz. Paket içinde ise modüller doğrudan leaf import eder; root barrel'a geri dönmez:

```ts
// Paket içinde iyi
import type { PermissionLevel } from "../kernel/permissions.js";
// Paket içinde kötü
import type { PermissionLevel } from "../index.js";
```

Bu kural cycle riskini azaltır. Shared'a eklenebilir:
- iki veya daha çok workspace'in kullandığı DTO; stabil enum/union;
- ortak sabit; saf permission/naming/workflow kuralı;
- runtime-bağımsız parser/formatter.
Eklenmez:
- DB row; Drizzle;
- Fastify; React;
- filesystem; environment;
- fetch client; provider SDK;
- secret.
Yeni contract tarifi:
1. Doğru domain leaf dosyasını seç.
2. Saf tipi/kuralı oraya ekle.
3. Leaf içindeki importları leaf path ile yap.
4. Public olacaksa root `index.ts` export'una ekle.
5. Package testini ekle.
6. `shared` build et.
7. Tüketicileri root import'a geçir.
Cycle oluşursa:
- iki modülün ortak primitive'ini daha aşağıdaki domain dosyasına çıkar; type-only import kullan;
- root barrel'ı paket içinde kullanma; uygulamaya özel tipi shared'a taşıyarak cycle gizleme.

## 21. `packages/cde-tools` kuralları

### 21.1 Core
`core/types.ts`:
- `CdeCall`; `CdeToolDef`;
- `CdeToolsOptions`
sözleşmelerini sahiplenir. `CdeCall` yalnız REST çağrısıdır:

```ts
type CdeCall = <T = unknown>(
  method: string,
  url: string,
  body?: unknown,
) => Promise<T>;
```

DB, Drizzle, server service veya storage erişimi eklenmez. `core/define.ts` tool-adder tipini tanımlar. `core/register.ts` definition'ları MCP SDK'ya kaydeder, output limit ve audit callback uygular. `core/result.ts` HTTP sonucunu araç sonucuna dönüştürür.

### 21.2 Format
`format/` model bağlamına uygun, kısa ve stabil metin formatlarını sahiplenir. Domain kuralları format dosyalarına saklanmaz.

### 21.3 Tools ve modules
Genel tool grupları `tools/*.ts` altındadır. Yoğun domain grupları:

```text
tools/modules/documents.ts
tools/modules/forms.ts
tools/modules/schedule.ts
tools/modules/coordination.ts
tools/modules/reviews.ts
tools/modules/works.ts
tools/modules/works-write.ts
```

Yeni tool:
- Zod shape ile input doğrular; `CdeCall` ile mevcut REST endpoint'ini çağırır;
- küçük ve kararlı çıktı verir; doğru flag'leri taşır;
- package root registry'sine kaydedilir; test edilir.

### 21.4 Gating
Flag anlamları:
- `write`: state değiştirir; read-only bağlantıda kaydedilmez; `local`: local filesystem gerekir; hosted MCP'de kaydedilmez.
- `dev`: yalnız dev tools etkinse kaydedilir; `destructive`: silme/geri döndürülemez etkiyi MCP annotation'a taşır.
Kurallar:
- write tool kullanıcı onayı beklentisini description'da açık eder; destructive tool hem `write` hem `destructive` olarak işaretlenir;
- dev tool production varsayılanında kapalıdır; dev tool read-only bağlantıda açılmaz;
- local tool hosted MCP'de açılmaz; read-only bilgisi yalnız açıklama değildir, registration gating ile uygulanır.
Tool adı ve vocabulary mevcut `cde_*` dilini izler. REST kaynak adları ve `@sitekeep/shared` terimleriyle çelişen eş anlamlılar türetilmez.

## 22. TypeScript ve kod kalitesi
Kök config:
- `strict`; `noUncheckedIndexedAccess`;
- `forceConsistentCasingInFileNames`; NodeNext.
Web ayrıca bundler resolution ve isolated modules kullanır. Kurallar:
- güvenilmeyen veri `unknown` olur; `any` yalnız kaçınılmaz üçüncü taraf sınırında, dar alanda ve gerekçeli olabilir;
- assertion runtime validation yerine geçmez; non-null assertion yalnız kanıtlanmış invariant'ta kullanılır;
- public fonksiyon input/output'u açıktır; birimli sayı adı birim taşır: `timeoutMs`, `sizeBytes`;
- impossible state discriminated union ile modellenir; DB tipi ve DTO tipi ayrı düşünülür.
Fonksiyon:
- fiille adlandırılır; tek ana niyet taşır;
- uzun positional parametre yerine command/options object alır; input'u gizlice mutate etmez;
- guard clause ile okunur kalır; `process`, `handleData`, `doThing` gibi belirsiz isimlerden kaçınır.
Yorum:
- kodun ne yaptığını tekrar etmez; güvenlik, standart veya şaşırtıcı kararın nedenini açıklar;
- tarihçe anlatmaz; tarihçe Git'tedir; TODO issue/koşul taşır.
Duplication:
- aynı iş kuralıysa ortaklaştırılır; yalnız şeklen benziyor ama farklı sebeple değişiyorsa erken birleştirilmez;
- üç satırı azaltmak için belirsiz abstraction kurulmaz.
Dead code:
- yorum içine alınmış eski implementasyon tutulmaz; kullanılmayan export/import silinir;
- geçici debug log merge edilmez; compatibility shim'in kaldırma koşulu yazılır.

### 22.1 Barrel kuralları
Barrel yalnız kararlı public API içindir. Feature içi her şeyi export eden barrel oluşturulmaz. Barrel:
- cycle saklamaz; side effect taşımaz;
- internal sembolü yanlışlıkla public yapmaz.

### 22.2 Dosya boyutu
Keyfî sert satır limiti yoktur. Dosya boyutu sorumluluk sinyalidir.
- **800 satır üstü:** code review'da sorumluluk ayrımı açıkça incelenir; **1000 satır üstü:** yazılı gerekçe gerekir veya dosya anlamlı sınırdan bölünür.
Sırf limit için anlamsız mikro dosyalar oluşturulmaz. Route orchestrator, page composition ve generated dosya bağlamı dikkate alınır.

### 22.3 Generated dosyalar
Generated:
- lockfile; Drizzle metadata/snapshot;
- build output; worker kopyaları
elle “temizlenmez”. Kaynak generator veya schema değiştirilir. `dist/`, coverage ve local data source control'a eklenmez.

### 22.4 NodeNext importları
Server, MCP, shared ve cde-tools yerel ESM importları `.js` uzantısı kullanır:

```ts
import { projectAccess } from "../core/security/access.js";
```

Kaynak dosya `.ts` olsa da emitted ESM için `.js` zorunludur. Web yerel importlarında bundler convention gereği uzantı kullanılmaz.

## 23. API kuralları
Uygulama REST API'si varsayılan olarak `/api/v1` altındadır. İstisnalar yalnız protokol gereğidir:
- WOPI; OAuth2/Foundation;
- OpenCDE Documents; hosted MCP;
- statik web.
Kurallar:
- URL resource adı çoğul ve tutarlıdır; project-owned resource URL'de proje bağlamını taşır;
- GET yan etkisizdir; POST create/command;
- PATCH kısmi update; DELETE silme;
- create uygun yerde 201; async iş uygun yerde 202 + job bilgisi döner.

### 23.1 Boundary validation
Params, query ve body Zod ile boundary'de doğrulanır. UUID, enum, uzunluk, tarih, limit ve sort alanları allowlist olur. TypeScript tipi runtime validation değildir. File metadata da güvenilmeyen input'tur.

### 23.2 DTO uyumluluğu
- Response alanı kaldırmak breaking change'dir; Alan rename geçişsiz yapılmaz.
- Enum'a değer eklemek exhaustive frontend'i etkiler; Tarih JSON'da ISO string olur.
- Internal DB kolonları DTO'ya otomatik spread edilmez; Shared contract değişirse server, web ve tools birlikte değerlendirilir.

### 23.3 Pagination
Liste endpoint'i:
- bounded limit; stabil sort;
- cursor veya açık page metadata; filtre allowlist
taşır. Sınırsız tablo dump edilmez.

### 23.4 Idempotency
Retry edilebilecek create/command:
- idempotency key; unique business key;
- duplicate-safe state transition
yollarından biriyle korunur. GET retry-safe olmalıdır. Yıkıcı işlem körlemesine retry edilmez.

### 23.5 Dosya streaming
- büyük dosya buffer olarak response'a yığılmaz; content length biliniyorsa yazılır;
- range ihtiyacı viewer davranışına göre korunur; filename header'a güvenli encode edilir;
- aborted client stream'i kaynakları kapatır.

### 23.6 Error response
Kararlı şekil:

```json
{
  "error": "stable_code",
  "message": "Kullanıcıya güvenli mesaj.",
  "details": {}
}
```

`details` yalnız güvenli validation/domain ayrıntısıdır. Ham provider, SQL veya stack error dönmez.

## 24. Güvenlik ve gizlilik kontrol listesi
Her değişiklikte:
- [ ] Varsayılan deny uygulanıyor.
- [ ] Auth olmayan route açıkça public.
- [ ] Her project query `projectId` ile scoped.
- [ ] Client user/company/project ID'sine güvenilmiyor.
- [ ] Token read/write ve project scope korunuyor.
- [ ] OAuth scope korunuyor.
- [ ] Kaynak başka projeden ID ile çekilemiyor.
- [ ] Secret response/log/audit'e girmiyor.
- [ ] URL query secret'ları redakte ediliyor.
- [ ] AI/outbound privacy kontrolünden geçiyor.
- [ ] Dış URL'de SSRF/redirect/timeout değerlendirildi.
- [ ] Upload boyutu, sayı, path ve archive sınırları var.
- [ ] HTML/Markdown güvenli render ediliyor.
- [ ] GET state değiştirmiyor.
- [ ] Hassas write audit ediliyor.

## 25. Test mimarisi

### 25.1 Shared unit test
`packages/shared/test/`:
- naming; permission;
- workflow; contract;
- saf mapper/formatter; privacy;
- model query
testlerinin yeridir.

### 25.2 CDE tools test
`packages/cde-tools/test/cde-tools.test.ts`:
- tool inventory; registration;
- readOnly/local/dev/destructive gating; REST çağrı şekli;
- output formatting/error mapping
testlerini kapsar.

### 25.3 Server test
`apps/server/test/<kategori>/` Fastify + PGlite ağırlıklı integration test sahibidir. Feature değişikliğinde değerlendirilir:
- başarılı yol; Zod validation;
- unauthenticated; yanlış proje / yetkisiz;
- read-only token; önemli conflict/not-found;
- DB state; audit;
- job enqueue; secret redaction.
Test helper başka feature kategorisine rastgele taşınmaz. Ortak binary/XML fixture `apps/server/test/fixtures/` altında tutulur. Fixture:
- minimum; sentetik veya lisansı uygun;
- secret içermeyen; deterministik
olur.

### 25.4 Web test
`apps/web/test/<kategori>/`:
- route/navigation; saf feature davranışı;
- phone/responsive kararları; viewer geometri/yardımcıları;
- API option mapping
testlerini sahiplenir. Kritik UI akışı değişiyorsa loading/error/empty ve kullanıcı davranışı test edilir.

### 25.5 Kök E2E smoke test
`e2e/specs/`, production server/web derlemesine karşı Chromium ile kritik kullanıcı
yolculuklarını doğrular. Yeni ekran, yeni rota ve kullanıcıya görünen geliştirme
unit, masaüstü e2e ve mobil smoke olmadan kapanmaz. Kapsam [Testler](testler.md)
belgesindedir. E2E her saf kural permütasyonu için kullanılmaz; bu varyasyonlar
shared/server/web testlerinin sorumluluğudur.

Kurallar:
- prerequisite'ler izole API ile kurulabilir; test edilen davranış ve görünür sonuç UI üzerinden doğrulanır;
- canlı, paylaşılan, production veya müşteri verisi hiçbir zaman kullanılmaz;
- testler sıra bağımsız, minimum ve deterministik veri kurar;
- dış entegrasyonlar contract/mock ile doğrulanır veya açıkça ayrılmış özel integration ortamında çalışır;
- selector ve fixture ayrıntıları [E2E test rehberinde](../../e2e/README.md) tutulur.

### 25.6 Test veri güvenliği
Test:
- canlı production DB'ye bağlanmaz; production URL/token kullanmaz;
- gerçek müşteri verisi içermez; gerçek SMTP/AI/Autodesk/OpenCDE çağrısı yapmaz;
- her test kendi verisini kurar; test sırasına bağımlı olmaz;
- saat/rastgelelik gerekirse kontrol edilir.
907 test sayısı doğrulanmış bir dönemsel baseline olarak anılabilir. Bu sayı invariant veya kalite hedefi değildir. Yeni testler sayıyı değiştirebilir; önemli olan davranış kapsamı ve tüm suite'in geçmesidir.

### 25.7 Değişiklik başına zorunlu test
| Değişiklik | Minimum test |
|---|---|
| Saf shared kural | shared unit test |
| API endpoint | server integration test |
| Access değişikliği | allowed + denied + cross-project |
| Migration | yeni schema ile okuma/yazma ve upgrade varsayımı |
| Job | enqueue + success + failure/idempotency |
| MCP tool | registration/gating + REST call |
| Frontend saf logic | web unit test |
| Yeni route veya kullanıcıya görünen akış | unit + masaüstü e2e + `mobile-` spec + smoke rotası ([Testler](testler.md)) |

## 26. Komutlar ve Definition of Done
Kurulum:

```bash
node --version
export NODE_AUTH_TOKEN="<read:packages yetkili GitHub token>"
npm ci
```

Node çıktısı 22 veya üstü olmalıdır. `.npmrc`, özel
`@7dimensions-project/bim-viewer` paketini GitHub Packages üzerinden indirir
(§2.2.1); `NODE_AUTH_TOKEN` bu nedenle `read:packages` yetkili olmalı ve hiçbir
zaman dosyaya ya da commit'e gerçek değeriyle yazılmamalıdır.

Hedefli kontroller:

```bash
npm run typecheck
npm test -w @sitekeep/shared
npm test -w @sitekeep/cde-tools
npm test -w @sitekeep/server
npm test -w @sitekeep/web
npm run e2e -- e2e/specs/<alan>.spec.ts
```

Tam kapı:

```bash
npm run build
npm run typecheck
npm test
npm run e2e:install
npm run e2e
```

`npm run e2e:install` Chromium'u bir kez kurar; CI işletim sistemi bağımlılıklarını da
`npx playwright install --with-deps chromium` ile kurar.

Scenario gerektiğinde:

```bash
npm run scenarios -- <senaryo>
```

Definition of Done:
- [ ] Kod güncel domain/feature dizininde.
- [ ] Yasak bağımlılık yönü yok.
- [ ] Runtime boundary validation var.
- [ ] Proje ve token scope kontrol edildi.
- [ ] Transaction sınırı değerlendirildi.
- [ ] Error code ve güvenli mesaj tanımlı.
- [ ] Audit/privacy/outbound etkisi değerlendirildi.
- [ ] Upload/storage güvenliği değerlendirildi.
- [ ] Gerekli migration var.
- [ ] Gerekli unit/integration test var.
- [ ] Yeni ekran veya görünen akış için unit, masaüstü e2e ve mobil smoke var ([Testler](testler.md)).
- [ ] UI loading/error/empty durumu var.
- [ ] Accessibility ve responsive davranış kontrol edildi.
- [ ] Typecheck/test/build ve gerekiyorsa E2E uygun kapsamda geçti.
- [ ] Dokümanlar güncel.
- [ ] Dead code, debug log ve secret yok.

## 27. Adım adım tarifler

### 27.1 Yeni backend endpoint veya domain
1. Domain sahibini belirle.
2. Route'u `apps/server/src/<domain>/routes.ts` altında ekle.
3. Büyükse `routes/` alt parçaları ve ince orchestrator kullan.
4. Zod schema'yı domain schema dosyasına koy.
5. Access guard'ı mevcut merkezi helper'a bağla.
6. Use-case'i `service.ts` veya isimlendirilmiş domain dosyasına koy.
7. Tekrar yoksa repository oluşturma.
8. DB gerekiyorsa `src/db/schema-<domain>.ts` ve migration ekle.
9. Route'u `apps/server/src/app/build-app.ts` içinde kaydet.
10. `apps/server/test/<kategori>/` altında test ekle.
İyi:

```text
coordination/routes/issues.ts
coordination/clash-access.ts
coordination/service.ts
```

Kötü:

```text
src/routes/new-thing.ts
src/services/new-thing.ts
```

### 27.2 Yeni frontend page veya feature
1. Domaini `apps/web/src/features/<feature>/` altında seç.
2. Route entry page'i `pages/` altına koy.
3. UI parçalarını feature `components/` altına koy.
4. Domain API'yi feature `api.ts` içine koy.
5. Transport için `shared/api/client.ts` kullan.
6. Query key'e `projectId` ve resource ID ekle.
7. Route'u `app/routes/AppRoutes.tsx` içine ekle.
8. Navigation gerekiyorsa `app/navigation/` güncelle.
9. Loading/error/empty ve responsive durumu ekle.
10. `apps/web/test/<kategori>/` testi ekle.
11. Unit, masaüstü e2e, `mobile-<feature>.spec.ts` ve `mobile-smoke` rotasını [Testler](testler.md) kuralına göre yaz ve çalıştır.
İyi:

```text
features/reports/pages/Reports.tsx
features/reports/components/ReportFrame.tsx
```

Kötü:

```text
src/pages/Reports.tsx
src/components/ReportFrame.tsx
```

### 27.3 Yeni shared contract
1. Gerçekten iki workspace tarafından kullanıldığını doğrula.
2. `packages/shared/src/<domain>/<name>.ts` ekle veya güncelle.
3. Runtime bağımlılığı olmadığını doğrula.
4. Paket içi importları leaf path ile yap.
5. Public ise `packages/shared/src/index.ts` export'una ekle.
6. `packages/shared/test/` altında test ekle.
7. Shared build et.
8. Tüketicilerde yalnız `@sitekeep/shared` root import kullan.
İyi:

```ts
export type ReviewStatus = "draft" | "active" | "closed";
```

Kötü:

```ts
export type ReviewRow = typeof reviewTable.$inferSelect;
```

### 27.4 DB schema migration
1. Tablo sahibini belirle.
2. `apps/server/src/db/schema-<domain>.ts` güncelle.
3. Gerekirse `schema.ts` export'unu ekle.
4. Proje FK/index/unique davranışını tasarla.
5. `npm run db:generate -w @sitekeep/server` çalıştır.
6. Yeni `apps/server/drizzle/<nnnn>_*.sql` dosyasını incele.
7. Data migration/backfill'i bounded tasarla.
8. PGlite integration testi ekle.
9. PostgreSQL uyumluluğunu gözden geçir.
10. Breaking drop/rename'i aşamalı yap.
İyi: nullable ekle → backfill → constraint → eski alanı sonra kaldır. Kötü: dolu üretim tablosunda tek adımda rename/drop.

### 27.5 Yeni job
1. Job kind ve küçük payload sözleşmesini tanımla.
2. Queue dispatch'i `apps/server/src/jobs/queue.ts` ile bağla.
3. Handler/worker'ı `apps/server/src/jobs/<name>-worker.ts` altında ekle.
4. Payload'ı runtime doğrula.
5. Idempotency anahtarını belirle.
6. Timeout, retry ve kalıcı hata davranışını belirle.
7. Route/service yalnız enqueue etsin.
8. Success/failure/duplicate testi ekle.
9. Temp ve worker kaynak cleanup'ını doğrula.
İyi: `{ projectId, fileVersionId }`. Kötü: bütün binary dosyayı job JSON payload'ına koymak.

### 27.6 Yeni MCP tool
1. Mevcut `/api/v1` endpoint'ini seç; yoksa önce güvenli endpoint ekle.
2. Tool'u `packages/cde-tools/src/tools/` veya `tools/modules/` altına ekle.
3. Zod input shape tanımla.
4. Yalnız `CdeCall` kullan.
5. `write`, `local`, `dev`, `destructive` flag'lerini doğru seç.
6. Çıktıyı `format/` helper'ıyla bounded yap.
7. `packages/cde-tools/src/index.ts` registration'a ekle.
8. Gating ve REST call testi ekle.
9. Stdio ve hosted MCP farkını doğrula.
İyi: tool → REST → server access/audit. Kötü: tool → Drizzle → tablo.

### 27.7 Yeni integration
1. Provider sınırını `apps/server/src/integrations/<provider>/` altında aç.
2. Client, auth, mapper/adapters ve route sorumluluklarını ayır.
3. Config'i bootstrap/deps üzerinden geçir.
4. Secret redaction ve encrypted storage tasarla.
5. Timeout, retry ve rate limit belirle.
6. Provider response'unu Zod ile doğrula.
7. Privacy/outbound kaydını bağla.
8. Provider modelini iç DTO'ya map et.
9. Gerçek ağa çıkmayan integration testi ekle.
10. Scheduler varsa shutdown cleanup ekle.
İyi: `integrations/autodesk/client.ts` + `adapters.ts`. Kötü: route içinde token refresh + fetch + DB + mapping.

### 27.8 Report extension
1. Contract gerekiyorsa `packages/shared/src/reports/` güncelle.
2. Server dataset'i `apps/server/src/reports/datasets*.ts` içine ekle.
3. Template/render akışını `reports/templates*.ts` veya engine'e bağla.
4. Route'u `reports/routes.ts` üzerinden yayınla.
5. Proje scope ve privacy kontrolünü ekle.
6. UI'yi `apps/web/src/features/reports/` altında ekle.
7. Server `test/reports/` ve gerekirse web testi ekle.
Kötü: report component'inin SQL alan adlarını bilmesi.

### 27.9 Form extension
1. Shared contract'ı `packages/shared/src/forms/` altında değerlendir.
2. DB alanını `schema-forms.ts` ve migration'a ekle.
3. Service'i `apps/server/src/modules/forms/` altında güncelle.
4. İlgili route parçasını `modules/forms/routes/` altında değiştir.
5. PDF etkisini `pdf-*` akışlarında kontrol et.
6. UI'yi `apps/web/src/features/forms/` altında ekle.
7. `apps/server/test/forms/` ve web saf logic testini ekle.
Kötü: yeni form alanını yalnız frontend state'ine eklemek.

### 27.10 Workflow extension
1. Saf contract/state kuralını `packages/shared/src/workflow/` altında değerlendir.
2. Server lifecycle kararını `apps/server/src/workflow/` altında ekle.
3. Access'i `review-access.ts` benzeri açık helper'da tut.
4. Transaction'ı review lifecycle/finalization service'inde kur.
5. Route'u `workflow/routes/` parçasına ekle.
6. Reminder/notification etkisini değerlendir.
7. UI'yi ilgili `features/reviews` veya domain feature altında ekle.
8. `apps/server/test/workflow/` allowed/denied/transition testleri ekle.
Kötü: status string'ini route ve frontend'de ayrı kurallarla değiştirmek.

## 28. Mimari kararlar ve belge bakımı
Uzun ömürlü, geri çevirmesi pahalı karar için kısa ADR yazılmalıdır. ADR gerektiren örnekler:
- yeni workspace; microservice ayrımı;
- auth modelinin değişmesi; DB/storage/queue teknolojisi;
- API versionlama; shared public export stratejisi;
- viewer motoru değişimi.
ADR yeri oluşturulursa:

```text
docs/architecture/adr/
  0001-<karar>.md
```

ADR:
- bağlam; karar;
- alternatifler; olumlu/olumsuz sonuçlar;
- durum
içerir. Bu belge güncellenirken:
1. Path'ler diskten doğrulanır.
2. Package script'leri `package.json` ile karşılaştırılır.
3. Eski hedef/refactor dili kaldırılır.
4. Relative Markdown link'leri taranır.
5. Çelişen feature belgesi güncellenir veya açıkça ikincil ilan edilir.
6. Satır sayısı tek başına kalite ölçüsü yapılmaz.
İlgili mevcut belgeler:
- [Dokümantasyon dizini](../README.md)
- [Yedekleme](../onprem/yedekleme.md)
- [İzleme](../onprem/izleme.md)
- [Forma eşitleme](../features/FORMA_ESITLEME.md)
- [Gizlilik](../features/GIZLILIK.md)
- [Google ile giriş](../features/GOOGLE_GIRIS.md)
- [Yerel Google ile giriş](../onboarding/GOOGLE_GIRIS.md)
- [OpenCDE](../features/OPENCDE.md)
- [Geliştirici MCP](../onboarding/GELISTIRICI_MCP.md)
- [Görüntüleyiciler](../features/GORUNTULEYICILER.md)

## 29. development-workflow.md — Git süreci
Branch, commit, rebase, Pull Request, zorunlu review ve merge sürecinin bağlayıcı kaynağı:

Git komutları bu belgede tekrarlanmaz. Mimari açıdan:
- mimari değişiklik review edilebilir kapsamda olmalı; mekanik taşıma ile davranış değişikliği mümkünse ayrılmalı;
- migration, güvenlik ve uyumluluk etkisi PR açıklamasında yazılmalıdır.

## 30. Anti-pattern kontrol listesi
- [ ] Flat `src/routes`, `src/pages` veya `src/components` altında yeni kod.
- [ ] Component'in page import etmesi.
- [ ] Service'in route import etmesi.
- [ ] Shared'ın app import etmesi.
- [ ] CDE tool'un DB'ye erişmesi.
- [ ] Başka paketin `src/` yoluna deep import.
- [ ] Import cycle.
- [ ] God route: validation + SQL + domain + provider.
- [ ] God component: routing + fetch + viewer + bütün dialog'lar.
- [ ] Component içinde ham `fetch`.
- [ ] Her tablo için zorunlu repository.
- [ ] Project query'de eksik `projectId`.
- [ ] Client'tan gelen user/company ID'ye güvenmek.
- [ ] Authorization'ı yalnız buton gizleyerek yapmak.
- [ ] Transaction içinde dış HTTP/AI/SMTP.
- [ ] Request içinde uzun CPU işi.
- [ ] Sınırsız liste endpoint'i.
- [ ] Runtime validation yerine `as`.
- [ ] Kontrolsüz `any`.
- [ ] Hata yutmak.
- [ ] Ham internal error döndürmek.
- [ ] Token/secret/body loglamak.
- [ ] User filename'i filesystem path yapmak.
- [ ] Read-only MCP'de write tool kaydetmek.
- [ ] Hosted MCP'de local tool açmak.
- [ ] Server state'i birden çok local state'e kopyalamak.
- [ ] Cleanup'sız viewer/worker/object URL.
- [ ] Loading/error/empty durumunu atlamak.
- [ ] Yalnız renkle durum anlatmak.
- [ ] Root barrel'ı package içinde import etmek.
- [ ] Generated dosyayı elle kaynak gibi düzenlemek.
- [ ] 1000+ satır dosyayı gerekçesiz büyütmek.
- [ ] Testte production DB, token veya müşteri verisi kullanmak.
- [ ] Tarihsel migration planını yaşayan mimari kuralı gibi tutmak.

## 31. Son karar ilkesi
Yeni koddan önce şu sorular cevaplanmalıdır:
1. Hangi domain bu kodun sahibidir?
2. Hangi katmanda çalışmalıdır?
3. Hangi yönde import yapabilir?
4. Proje ve token izolasyonu nerede uygulanır?
5. Dış input nerede doğrulanır?
6. DB transaction gerekiyor mu?
7. İş job/worker'a ayrılmalı mı?
8. Veri dışarı çıkıyor mu?
9. Hangi test davranışı kanıtlar?
10. Bu belge veya feature belgesi güncellenmeli mi?
Cevap net değilse yeni klasör veya abstraction eklemeden önce sınır netleştirilir. En iyi mimari en çok katmanı olan değil:
- sahipliği görünür; yanlış bağımlılığı zor;
- güvenliği varsayılan; değişiklik etkisi sınırlı;
- test edilmesi kolay
olan mimaridir.
