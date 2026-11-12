# Modüller

SiteKeep çekirdeği (Community) ile ücretli modüller (Enterprise) arasındaki sınır. Ürün tarafı:
SiteKeep sürümler ve modüller. Bu belge kod tarafını,
yani bir modülün çekirdeğe nasıl bağlandığını anlatır.

Hedef, görüntüleyicide uyguladığımız düzenin aynısıdır: her modül kendi deposunda geliştirilir,
sürümlü paket olarak yayımlanır ve uygulamaya sabit sürümle girer
([bim-viewer](../architecture/structure.md#221-harici-özel-paket-7dimensions-projectbim-viewer)).

## Durum

| Modül | Depo | Paket | Bu depodaki sürüm | Durum |
|---|---|---|---|---|
| **Cost**: sözleşme, hakediş, metraj, 2B metraj, 5D, Poz Öner | [sitekeep-cost](https://github.com/7Dimensions-Project/sitekeep-cost) (kapalı) | `@7dimensions-project/sitekeep-ee-cost` | `0.6.1` | Ayrı depo, GitHub Packages. [Ayrıntı](cost.md) |
| **Field**: form şablonları, formlar, onay akışı, form PDF'leri | [sitekeep-field](https://github.com/7Dimensions-Project/sitekeep-field) (kapalı) | `@7dimensions-project/sitekeep-ee-field` | `0.3.2` | Ayrı depo, GitHub Packages. [Ayrıntı](field.md) |
| **Coordinate**: çakışma testleri, parametre değişikliği | [sitekeep-coordinate](https://github.com/7Dimensions-Project/sitekeep-coordinate) (kapalı) | `@7dimensions-project/sitekeep-ee-coordinate` | `0.3.0` | Ayrı depo, GitHub Packages. [Ayrıntı](coordinate.md) |
| **Planning**: İş Programı (P6, MS Project, Excel), sürümler, 4D | [sitekeep-planning](https://github.com/7Dimensions-Project/sitekeep-planning) (kapalı) | `@7dimensions-project/sitekeep-ee-planning` | `0.3.0` | Ayrı depo, GitHub Packages. [Ayrıntı](planning.md) |
| **AI**: sağlayıcılar, Projeye Sor, görev kuyruğu, MCP | [sitekeep-ai](https://github.com/7Dimensions-Project/sitekeep-ai) (kapalı) | `@7dimensions-project/sitekeep-ee-ai` | `0.4.0` | Ayrı depo, GitHub Packages. [Ayrıntı](ai.md) |
| **Manage**: RFI, teknik onay, toplantı, yazışma araçları, Bırak-kaydet | [sitekeep-manage](https://github.com/7Dimensions-Project/sitekeep-manage) (kapalı) | `@7dimensions-project/sitekeep-ee-manage` | `0.3.1` | Ayrı depo; İşler motoru çekirdekte. [Ayrıntı](manage.md) |
| **Connect**: Autodesk Forma / ACC eşitleme ve dosya içe aktarma, tarayıcıda Office düzenleme (WOPI) | [sitekeep-connect](https://github.com/7Dimensions-Project/sitekeep-connect) (kapalı) | `@7dimensions-project/sitekeep-ee-connect` | `0.3.2` | Ayrı depo; Office dönüştürme çekirdekte. [Ayrıntı](connect.md) |

| Paket | Nereden | Sürüm |
|---|---|---|
| `@7dimensions-project/sitekeep-sdk` | bu depo, `packages/sdk` | `0.12.0` |

Sürüm satırları `apps/server/package.json` ve `apps/web/package.json` ile aynı tutulur (`module-boundary.test.ts` sabit sürüm ister).

Adımlar (her biri ayrı PR, testler yeşil):

1. **SDK ve sınır:** modül çekirdeğe yalnız SDK üzerinden bağlanır, çekirdek modülü yalnız modül listesinden tanır. Davranış değişmez. (Cost: #24)
2. **Paket:** modül `packages/ee-<id>` olur: sunucu, web, şema, migration'lar. Çekirdek onu paket adıyla yükler; CI modülsüz (Community) derler ve test eder. (Cost: #26)
3. **Depo:** `7Dimensions-Project/sitekeep-<id>` (kapalı); paket GitHub Packages'a yayımlanır, bu depo onu sabit sürümle kullanır, `packages/ee-<id>` silinir.

## Parçalar

| Parça | Yer | Ne |
|---|---|---|
| SDK (çekirdek tarafı) | `apps/server/src/sdk/index.ts`, `apps/web/src/sdk/index.ts` | Modülün çekirdekten kullanabildiği tek yüzey |
| SDK paketi | `packages/sdk` → `@7dimensions-project/sitekeep-sdk/server`, `/web`, `/shared` | Modüllerin import ettiği tek ad. Çalışırken çekirdeğin bağladığı nesneyi iletir (`server.js`, `web.js`, `shared.js`, üretilir). Yayımlanan pakette çekirdeğin tip bildirimleri (`types/`, yalnız `.d.ts`) vardır |
| Bağlama | `apps/*/src/sdk/bind.ts` | SDK'yı ve `packages/shared`'ı `globalThis[Symbol.for("sitekeep.sdk.server" / ".web" / ".shared")]`'e koyar; modüllerden önce yüklenir |
| Modül listesi | `apps/server/src/app/modules.ts`, `apps/web/src/app/modules.ts` + `apps/web/sitekeep-modules.ts` | `SITEKEEP_MODULES`'teki modülleri paket adıyla yükler |
| Modül | `sitekeep-<id>` deposu → `node_modules/@7dimensions-project/sitekeep-ee-<id>` | `dist/server`, `dist/web/index.js`, `migrations/`, `locales/` (metinler, [i18n §9](../architecture/i18n.md)); `exports`: `./server`, `./web`, `./internal/*` (yalnız çekirdeğin testleri) |

Neden bu köprü: modül paketi çekirdeğin kaynağını bilmeden derlenebilmeli, ama çalışırken
çekirdekle aynı nesneleri (rapor kayıt defteri, yetenekler, React context'leri, i18n) paylaşmalı.
VS Code eklentilerinin `vscode` modülüyle aynı düzen.

## Hangi modüller kurulu

`SITEKEEP_MODULES` virgülle ayrılmış modül kimlikleri:

| Değer | Sonuç |
|---|---|
| tanımsız | Kurulu bütün modül paketleri (`node_modules/@7dimensions-project/sitekeep-ee-*`). Modüller `apps/server` ve `apps/web`'de **isteğe bağlı** bağımlılıktır (`optionalDependencies`): paketlere ulaşamayan bir kurulum (`npm ci` kimliksiz) onları atlar ve Community olarak açılır |
| `""` (boş) | Hiçbiri: **Community** |
| `cost` | Yalnız Cost |

Sunucu çalışırken okur. Web derlemesi kurulu modül paketlerini taşır (Vite; `SITEKEEP_MODULES` derlemede
verilirse yalnız onları); uygulama açılışta sunucuya hangilerini çalıştırdığını sorar (`GET /api/v1/app-info`,
girişten önce de açık) ve yalnız onların sayfa, menü, yetenek ve metinlerini açar (`app/modules.ts`). Böylece
tek bir Enterprise imajında hangi modüllerin açık olduğunu sunucu (ileride lisans) belirler. CI'daki `community` işi
kurulumdan sonra modül paketlerini siler ve `SITEKEEP_MODULES`'i tanımsız bırakır (modülsüz kurulumun
gerçek hali); sunucu + web testlerini koşar, modüle ait testler (`apps/*/test/modules/<id>`) o işte atlanır.
Modül iç koduna dayanan çekirdek testleri modülü yalnız kuruluysa yükler (`hasAi ? await import(...)`).

## Sınır kuralları

- Modül çekirdeği **yalnız** `@7dimensions-project/sitekeep-sdk/server`, `/web` ve `/shared` üzerinden kullanır; `@sitekeep/*` paketlerini doğrudan import etmez.
- Modül paketinin dışına göreli yolla çıkmaz, başka bir modülü import etmez. Birinin diğerinden istediği şey bir **yetenek** (capability) olarak sunulur ve isteğe bağlıdır.
- Çekirdek bir modülün kodunu **hiç** import etmez; modülleri paket adıyla `app/modules.ts` yükler.
- Testlerle korunur: modül tarafı modül deposunda (`scripts/check-boundary.mjs`); bu depoda `apps/server/test/architecture/module-boundary.test.ts` (çekirdek modül kodu import etmez, modüller sabit sürümlü paket), `sdk-shim.test.ts` (SDK paketi çekirdeğin SDK'sıyla ve `shared` ile aynı adları iletir).

## Modül sözleşmesi

Sunucu (`sdk/module.ts`), paketin `./server` girişinin varsayılan dışa aktarımı:

```ts
export default defineServerModule({
  id: "cost",
  migrations: path.join(packageRoot(), "migrations"), // kendi günlüğü: drizzle.__drizzle_migrations_cost
  locales: path.join(packageRoot(), "locales/server"), // sunucu metinleri, çekirdeğin ad alanlarına eklenir
  async routes(api, deps) { … },          // /api/v1 altındaki rotalar
  async reminders(db, now) { … },          // günlük hatırlatma turu, { dueSoon, overdue } döner
  taskSources: [paymentTasks],             // "Görevlerim" listesine katkı
  async rootRoutes(app, deps) { … },       // /api/v1 dışı, kendi kimlik doğrulamalı uç noktalar (AI: /mcp)
  devTools: { cde_dev_ai_eval: devAiEval }, // geliştirici araçları (CDE_DEV_TOOLS=1)
  async start({ db, jobs, log }) { … },     // açılışta arka plan işleri (Connect: eşitleme zamanlayıcısı); durdurma fonksiyonu döner
});
```

Rapor veri kümeleri modül yüklenirken `reportDatasets.register(...)` ile kaydedilir. İsteğe bağlı `tables`, modülün tablolarını yalnız geliştirici araçlarına açar (`moduleTable("field", "forms")`; demo veri, sıfırlama, betikler); özellik kodu yetenek kullanır. Veritabanı
açılırken önce çekirdeğin, sonra her kurulu modülün migration'ları çalışır (`db/index.ts`).

Web (`sdk/module.ts`), paketin `./web` girişinin varsayılan dışa aktarımı:

```ts
export default defineWebModule({
  id: "cost",
  projectRoutes: [{ path: "contracts", element: <ContractsPage /> }, …], // /projects/:pid/ altı
  projectNav: [{ group: "planning", to: "contracts", labelKey: "…", icon: "doc" }, …],
  capabilities: { cost: { CostDialog, cashflow, … }, "cost.takeoff": { get, add } },
});
```

Modül, çekirdeğin `LEGACY_URLS` tablosunda (`app/navigation/routes-table.ts`) kendi sayfaları için
`module: "<id>"` ile işaretlenir; modül kurulu değilse o adresler beklenmez.

## Yetenekler (capabilities)

Bir modülün başka bir modüle ya da çekirdeğe sunduğu isteğe bağlı hizmet. Kullanan taraf yetenek
yoksa özelliği gizler; sağlayıcı kurulu olmayabilir.

| Yetenek | Sağlayan | Kullanan | Yoksa |
|---|---|---|---|
| `manage.workExists` (sunucu) | Çekirdeğin İşler motoru (`works/capabilities.ts`) | Cost: zeyilnameye iş bağlama | İş bağlantısı reddedilir |
| `manage.workLabels` (sunucu) | Çekirdeğin İşler motoru | Coordinate: talebe bağlı işin etiketi | Etiket boş |
| `connect.ui` (web) | Connect | Dosya çekmecesi: Düzenle ve kilit; Yönetim → Forma Eşitleme | Görünmez |
| `manage.ui` (web) | Manage | İş detayı (paket, toplantı), kütükler, şartname içe aktarma, RFI taslağı, Bırak-kaydet | Görünmez; Manage anahtarları kapalı |
| `ai.provider` (sunucu) | AI | Model isteyen her özellik (çekirdeğin `ai/provider.ts` kapısı) | `403 ai_off`; özellikler kurallı sonuca düşer |
| `ai.tasks` (sunucu) | AI | Bugün: açık "Günün Özeti" görevi | Görev yok |
| `ai.ui` (web) | AI | Sor paneli, "Yapay Zekâya Gönder", Yönetim ve proje AI ayarları | Düğme ve sekmeler görünmez |
| `planning.schedules` (sunucu) | Planning | Cost: 5D'de programın faaliyetleri, veri tarihi, 4D bağları, planlamacı yetkisi; "Bugün" etiketleri | Maliyet faaliyetlere bağlanmaz, planlamacı = proje yöneticisi; etiket yok |
| `planning.fourD` (web) | Planning | Görüntüleyicinin 4D paneli (`?takvim=1`) | 4D düğmesi görünmez |
| `coordinate.modelSets` (sunucu) | Coordinate | Model seti düzenleme / silme | Kontrol yok (test yok) |
| `coordinate.linkTargets` (sunucu) | Coordinate | Sorun ↔ çakışma grubu bağı | 404 |
| `coordinate.paramChanges` (sunucu) | Coordinate | "Bugün" etiketleri | Satır yok |
| `coordinate.clashTests` (web) | Coordinate | Koordinasyon: Çakışma testleri sekmesi | Sekme görünmez |
| `coordinate.viewerClash` (web) | Coordinate | Görüntüleyicinin çakışma modu | `?clash=` yok sayılır |
| `coordinate.paramFile` (web) | Coordinate | Dosya çekmecesi parametre düğmesi / rozeti | Görünmez |
| `field.forms` (sunucu) | Field | "Bugün", hub etiketleri, konumlar, iki rapor veri kümesi | Form satırları ve sayıları boş |
| `field.externalForms` (sunucu) | Field | Forma Eşitleme: Autodesk formları | Formlar eşitlenmez |
| `field.newFormDialog` (web) | Field | İşler "+ Yeni" → Form | Seçenek görünmez |
| `cost` (web) | Cost | 4D paneli (maliyet renk modu, nakit akışı, eleman maliyeti), İş Programı "Maliyet" diyaloğu | Maliyet düğmeleri ve renk modu görünmez |
| `cost.takeoff` (web) | Cost | PDF görüntüleyici "2B Metraj", DWG ölçümünü metraja kaydetme | Düğme görünmez, ölçü yalnız ölçer |

Yeni yetenek: tipi `sdk/capabilities.ts`'e eklenir, sağlayan modül kaydeder, kullanan `capability(...)`
/ `webCapability(...)` ile ister.

## SDK'ya ekleme ve yayın

Modül çekirdekten yeni bir şeye ihtiyaç duyarsa `apps/*/src/sdk/index.ts`'e açık bir export eklenir
(yorumla hangi bölümde olduğu), sonra `npm run build -w @7dimensions-project/sitekeep-sdk` shim'leri
yeniden üretir (`sdk-shim.test.ts` unutulursa yakalar).

SDK semver ile sürümlenir: ekleme küçük sürüm, export kaldırmak ya da imza değiştirmek büyük sürüm. 0.x boyunca modüller `peerDependencies`'te `>=<kullandığı sürüm> <1.0.0` yazar (npm `^0.1.0`'ı `0.2.0` ile uyumsuz sayar).
Yayın: `packages/sdk/package.json` sürümü → PR → merge → `git tag -a sdk-vX.Y.Z -m "SDK X.Y.Z" && git push origin sdk-vX.Y.Z`
(`.github/workflows/sdk-release.yml`; `prepack` tip bildirimlerini üretir). Modül deposu yeni SDK'yı
`devDependencies`'e alır, gerekiyorsa `peerDependencies` aralığını günceller.

## Modül sürümü yükseltme

1. Modül deposunda PR → merge → sürüm → `vX.Y.Z` etiketi (CI yayımlar).
2. Burada: `npm install @7dimensions-project/sitekeep-ee-<id>@X.Y.Z --save-exact -w @sitekeep/server -w @sitekeep/web`, bu belgedeki sürüm satırı → PR → yeşil CI → merge.
3. Canlı: deploy (sunucudaki `.npm_token` okuma iznine sahip olmalı).

## GitHub Packages erişimi

Paketler kapalı. Bir deponun CI'ı (`GITHUB_TOKEN`) başka depodan yayımlanan paketi ancak paketin
ayarlarında izin verilirse okur: paket sayfası → **Package settings → Manage Actions access → Add
repository** (Read).

| Paket | Okuması gereken depolar |
|---|---|
| `bim-viewer` | `7d-cde` ve görüntüleyici tiplerini kullanan modül depoları (`sitekeep-coordinate`, `sitekeep-planning` …) |
| `sitekeep-sdk` | `sitekeep-cost`, `sitekeep-field`, `sitekeep-coordinate`, `sitekeep-planning`, `sitekeep-ai`, `sitekeep-manage`, `sitekeep-connect` (ve sonraki modül depoları) |
| `sitekeep-ee-cost` | `7d-cde` |
| `sitekeep-ee-field` | `7d-cde` |
| `sitekeep-ee-coordinate` | `7d-cde` |
| `sitekeep-ee-planning` | `7d-cde` |
| `sitekeep-ee-ai` | `7d-cde` |
| `sitekeep-ee-manage` | `7d-cde` |
| `sitekeep-ee-connect` | `7d-cde` |

Geliştirici makinesi ve canlı sunucu `read:packages` izinli kişisel token kullanır (`NODE_AUTH_TOKEN`, `.npmrc`).

## Yeni modül ayırmak (kontrol listesi)

1. Modülün çekirdekten aldıklarını çıkar; çekirdeğin ona doğrudan bağlandığı yerleri (rota, hatırlatma, görev, rapor, menü, başka sayfalardaki düğmeler) bul.
2. Gerekenleri SDK'ya ekle; çekirdekten modüle giden bağları sözleşme alanlarına ya da yeteneklere çevir.
3. Kodu `packages/ee-<id>`'ye taşı (`server/`, `web/`), şemasını ve migration'larını al (idempotent), `KNOWN_MODULES`'e ekle (sunucu, web, vitest); çekirdeğe yalnız `@7dimensions-project/sitekeep-sdk/*` ile eriş.
4. Testlerini `apps/*/test/modules/<id>`'ye al; karışık testlerde modül adımlarını kurulu olmasına bağla.
5. `npm test` ve `SITEKEEP_MODULES="" npm test`, e2e, Dockerfile.
6. `sitekeep-<id>` deposunu `sitekeep-cost`'u örnek alarak aç, paketi yayımla, burada `packages/ee-<id>`'yi sil ve sabit sürümü ekle; paket erişimlerini ver; bu belge ve modül sayfası.
