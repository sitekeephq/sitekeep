<p align="center"><img src="apps/web/public/brand/sitekeep-logo-horizontal.svg" alt="SiteKeep" width="320"></p>

# SiteKeep

**OpenCDE uyumlu, gizlilik öncelikli CDE platformu.**

| Sürüm | Ne |
|---|---|
| **SiteKeep Community** | Bu depodaki çekirdek: dokümanlar, klasör yetkileri, sürümler, isimlendirme, onay akışları, sorunlar ve BCF, model görüntüleyici, İşler (yazışma, transmittal), raporlar, OpenCDE. Modülsüz kurulum (`SITEKEEP_MODULES=""`). |
| **SiteKeep Enterprise** | Community + ücretli modüller: Cost, Field, Coordinate, Planning, AI, Manage, Connect ([modüller](docs/modules/README.md)). Herhangi bir modül kuruluysa uygulama kendini "SiteKeep Enterprise" olarak gösterir. |

Marka dosyaları ve kullanım kuralları: [docs/brand/README.md](docs/brand/README.md).

Yerel sunucuda (on-premise) çalışan, ISO 19650 uyumlu **Ortak Veri Ortamı**. Autodesk Forma'nın (eski ACC)
Docs ve Issues tarafının açık formatlı karşılığı; 3B/BIM tarafı [That Open Company](https://thatopen.com) üzerine kurulu.

- **Geliştirici başlangıcı:** [depo yapısı](docs/architecture/structure.md), [demo veri](docs/onboarding/DEMO_VERI.md) ve [MCP geliştirme rehberi](docs/onboarding/GELISTIRICI_MCP.md)
- Gizlilik: sunucu dışarıya kendiliğinden veri göndermez; her dış bağlantı Yönetim → Gizlilik Merkezi'nde görünür, kaydı tutulur ve tek düğmeyle kapatılır: [docs/features/GIZLILIK.md](docs/features/GIZLILIK.md)

## Neler var (faz 1)

| Alan | Özellik |
|---|---|
| Kullanıcılar | Yerel kullanıcılar, firmalar, sistem yöneticisi, proje yöneticisi, API erişim anahtarları |
| Projeler | ISO 19650 klasör şablonu (Çalışma / Paylaşılan / Yayınlanan / Arşivlenen; klasör adları 01-WIP … 04-ARCHIVED), üyeler |
| Klasörler | Ağaç, Forma ile aynı 6 yetki seviyesi (kişi / firma), aşağı miras, alt klasörde düşürme engeli |
| Dosyalar | Sürükle-bırak yükleme, versiyonlama (aynı ad = yeni versiyon), öznitelikler, indirme, SHA-256 |
| İsimlendirme | Proje bazlı naming standard; klasöre bağlanır, yüklemede zorunlu, ön kontrol ucu |
| Modeller | IFC → That Open Fragments dönüşümü sunucuda (worker thread), IFC özeti, birleşik model görüntüleyici, eleman seçimi ve özellikler |
| Sorunlar | 3B nokta işareti, BCF tarzı görünüm (kamera, modeller, seçili GlobalId'ler, görüntü), durum, öncelik, atama, termin, yorum |
| Denetim | Her yazma ve indirme işlemi aktivite kaydına düşer |
| Entegrasyon | REST API (`/api/v1`), sunucuda MCP ucu (`/mcp`) ve stdio MCP sunucusu (24 araç, Forma MCP ile aynı biçim), kapsamlı API erişim anahtarları, AECPilot teslimi için naming kontrol + yükleme uçları |
| Yapay zekâ | Yönetici kontrollü sağlayıcılar (Ollama/vLLM/LM Studio, DeepSeek, Claude), tam yerel mod, proje bazlı politika |
| Raporlar | Kişisel rapor panelleri: yapay zekâ ile, şablondan veya HTML ile; paylaşım, sürüm geçmişi, PDF çıktısı |
| Doküman zekâsı | PDF antetinden ad, öznitelik ve revizyon önerisi; revizyon tutarlılık uyarıları; şartnameden taslak teknik onay listesi (CSV/XLSX/JSON) |

## Hızlı başlangıç (Docker)

```bash
cp .env.example .env      # ADMIN_EMAIL, ADMIN_PASSWORD, POSTGRES_PASSWORD değerlerini değiştirin
docker compose up -d
```

Yayımlanan SiteKeep Community imajı çekilir (`ghcr.io/sitekeephq/sitekeep`); Enterprise, kaynaktan
derleme, güncelleme ve yedek: [docs/onprem/docker-compose.md](docs/onprem/docker-compose.md).

Uygulama `http://sunucu:8080` adresinde açılır. İlk açılışta `.env`'deki yönetici hesabı oluşturulur.
HTTPS için önüne bir ters proxy (nginx, Caddy, IIS ARR) koyup `SECURE_COOKIES=1` yapın.

Yedekleme: `pgdata` (veritabanı) ve `cdedata` (dosyalar) birimlerini birlikte yedekleyin, örn.
`docker compose exec db pg_dump -U cde cde > yedek.sql` ve `cdedata` biriminin kopyası.

### Docker'sız tek sunucu

`DATABASE_URL` verilmezse gömülü PostgreSQL (PGlite) `DATA_DIR/db` altında kullanılır; ek servis gerekmez.

```bash
npm ci && npm run build
DATA_DIR=/srv/cde ADMIN_EMAIL=... ADMIN_PASSWORD=... node apps/server/dist/index.js
```

## Geliştirme

```bash
npm ci
cp apps/server/.env.development.example apps/server/.env.development   # yönetici bilgilerini girin
npm run dev -w @sitekeep/server      # API  → http://127.0.0.1:8787
npm run dev -w @sitekeep/web         # Arayüz → http://localhost:5173 (API'ye proxy)
node --env-file=apps/server/.env.development apps/server/scripts/seed-demo.mjs   # örnek ZAVM projesi
node --env-file=apps/server/.env.development apps/server/scripts/import-demo.mjs # Forma yapılı demo projeler (docs/onboarding/DEMO_VERI.md)
npm test                           # paylaşılan çekirdek + API testleri
```

Chromium uçtan uca testleri üretim derlemesini kullanır:

```bash
npm run build
npm run e2e:install
npm run e2e
```

Ayrıntılar için [E2E test rehberine](e2e/README.md) bakın.

## Rapor panelleri

Her kullanıcı kendi panelini kurar: **Raporlar → Yapay zekâ ile oluştur** kutusuna ne görmek istediğini Türkçe yazar
("Firmalara göre açık issue sayısı, termini geçenler ayrı"), panel önizlenir, beğenilirse kaydedilir. Sonraki
değişiklikler de cümleyle yapılır ("grafiği aylık yap", "Hilal'i ayrı göster"). Yapay zekâ kapalıysa dört hazır şablon
(issue durumu, termin aşımları, haftalık yükleme aktivitesi, model eleman dağılımı) ve HTML düzenleyici kullanılır.

Nasıl çalışır:

- **Anlamsal veri katmanı** (`apps/server/src/reports/datasets.ts`): `files`, `versions`, `issues`, `activity`,
  `members`, `models` veri kümeleri, tipli alanlarla. Sorgular SQL değil, doğrulanmış bir JSON tanımıdır
  (filtre, gruplama, gün/hafta/ay kovası, count/sum/avg/min/max, sıralama, en çok 5000 satır).
- **Yetki:** sorgular her zaman **paneli açan kişinin** yetkisiyle çalışır. Klasörünü göremediğiniz dosya rapora da
  girmez; "sadece yükle" yetkisi yalnızca kendi dosyalarını gösterir; aktivite kaydı yalnızca proje yöneticilerine açıktır.
  Paylaşılan bir panel her izleyiciye kendi verisini gösterir.
- **Paylaşım:** yalnızca ben / firmam / proje yöneticileri / tüm proje. Paneli sahibi veya proje yöneticisi
  düzenler; her kayıt bir sürümdür, eski sürüm geri yüklenebilir.
- **Güvenli görüntüleme:** panel HTML'i `sandbox="allow-scripts allow-modals"` iframe'de, ağ erişimini tamamen kapatan
  bir CSP ile çalışır. Oturum, çerez ve API adresi iframe'e verilmez; veri `postMessage` ile gelir. Grafikler için
  gömülü küçük bir SVG kütüphanesi vardır (`CDE.bar`, `CDE.line`, `CDE.pie`, `CDE.kpi`, `CDE.table`).

Yapay zekâ (OpenAI uyumlu uç; Ollama, vLLM, LM Studio, llama.cpp):

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `AI_BASE_URL` | `http://127.0.0.1:11434/v1` | Biri tanımlıysa (veya `AI_ENABLED=1`) panel üretici açılır |
| `AI_MODEL` | `qwen3:8b` | Qwen3'te düşünme modu `/no_think` ile kapatılır |
| `AI_API_KEY` | — | Gerekirse Bearer anahtarı |
| `AI_TIMEOUT_MS` | `600000` | CPU'da yerel model yavaştır |
| `AI_ENABLED` | — | `0` üreticiyi kapatır |
| `REPORT_TZ` | `Europe/Istanbul` | Gün/hafta/ay kovalarının saat dilimi |

**Ollama bağlam uzunluğu:** panel üreticinin sistem istemi ~3.500 token, cevap (HTML) 1.500–3.000 token tutar.
Ollama varsayılan olarak 4.096 token bağlamla çalışır ve fazlasını sessizce keser; sunucuyu
`OLLAMA_CONTEXT_LENGTH=16384` ile başlatın (veya modeli `num_ctx 16384` ile bir Modelfile'dan oluşturun).

Yerel modeli denemek için (testlere dahil değil): `npm run build && AI_ENABLED=1 node apps/server/scripts/report-llm-smoke.mjs "istek" --out panel.html`.
İsteklerin metni denetim kaydına yazılmaz; yalnızca uzunluğu ve sonucu yazılır.

## Doküman zekâsı (antet ve şartname)

- **Antet okuma:** yüklenen her PDF'in ilk sayfasının metin katmanı arka planda (iş kuyruğu, worker thread) pdf.js ile
  okunur. Etiket/değer çiftleri ("Çizim No: …", altında değer olan CAD hücreleri), sağ alt köşedeki etiket kümesi ve
  revizyon tablosu bulunur; her alanın güveni gösterilir. Taranmış PDF'lerde (metin katmanı yok) OCR henüz yoktur.
- **Ad önerisi:** yalnız klasörün naming standard'ındaki izinli değerler kullanılır ve öneri `validateName`'den
  geçmezse ad önerilmez. Antette standarda uyan bir doküman kodu varsa olduğu gibi alınır; yoksa alanlar tek tek
  eşlenir (kod, Türkçe duyarlı açıklama, sayı, tek izinli değer, mevcut dosya adı, klasör adları). Yükleme penceresinde
  PDF'ler için "Antetten öneri" (dosya başına uygula / tümüne uygula) gösterilir; dosyalar saklanmadan
  `POST /projects/:pid/docintel/suggest` ile okunur (dosya başına 30 MB, en çok 20 dosya).
- **Revizyon:** antet → revizyon tablosu → dosya adı (P01, C02, Rev.B, R03, "Revizyon 2"). Aynı içerik yeniden
  yüklendiğinde, içerik değişip revizyon aynı kaldığında, revizyon geri gittiğinde veya antet/tablo/ad/öznitelik
  uyuşmadığında dosya panelinde uyarı çıkar.
- **Şartnameden submittal:** şartname PDF'i bölümlere ayrılır ("03 30 00", "Bölüm 5.2", "MADDE 12", "5.2.1 …"),
  "onaya sunulacaktır", "numune", "teknik föy", "atölye çizimi", "test raporu" gibi ifadeler taslak kalem olur
  (tip: MOS, NUM, UCZ, YB, IP, ISG, TR, PMR, KS, IKOF, BAS, MKF; disiplin önerisi). Liste düzenlenir ve CSV (Türkçe
  Excel için `;` ve BOM), XLSX veya JSON (`SubmittalRegisterItem`) olarak indirilir.
- **Yapay zekâ isteğe bağlıdır:** her şey modelsiz çalışır. Model (ör. Ollama `qwen3-8b-16k`, düşünme kapalı) yalnız
  istenince ve yalnız belirsiz alanlar / tipsiz kalemler için kısa JSON ile çağrılır; izinli olmayan değer içeren veya
  standarda uymayan cevap reddedilir.

## Mimari

```
packages/shared   yetki seviyeleri ve miras, naming standard doğrulayıcı, ortak tipler
packages/cde-tools  cde_* MCP araçları (stdio sunucusu ve sunucudaki /mcp ucu aynı seti kullanır)
apps/server       Fastify + Drizzle ORM (PostgreSQL / PGlite), yerel disk depolama, IFC dönüşüm kuyruğu
apps/web          React + That Open Components 3.x viewer
apps/mcp          CDE MCP sunucusu (stdio; yerel dosya yükleme/indirme araçlarıyla)
```

Yetki ve isimlendirme kuralları tek yerde (`packages/shared`) tanımlıdır; sunucu, arayüz ve MCP aynı kodu kullanır.

## MCP bağlantısı

CDE kendi MCP ucunu sunar: `https://cde.sirket.local/mcp` (Streamable HTTP, oturumsuz). Claude Code, Claude Desktop,
Cline, Open WebUI, LibreChat gibi her MCP istemcisi bağlanabilir; bu istemciler Claude'un yanında DeepSeek veya yerel
modellerle (Ollama) de çalışır. Bağlantı **Hesabım → API erişim anahtarları** bölümünden oluşturulan erişim anahtarı ile yapılır ve her araç
çağrısı kullanıcının kendi yetkisiyle çalışıp aktivite kaydına (`mcp.tool`) yazılır.

```bash
claude mcp add --transport http 7d-cde https://cde.sirket.local/mcp --header "Authorization: Bearer 7dcde_api_..."
```

Diğer istemcilerde "Streamable HTTP" türünde sunucu ekleyip aynı adresi ve `Authorization: Bearer <erişim anahtarı>` başlığını girin.

Araçlar (`packages/cde-tools`; stdio sunucusu, `/mcp` ucu ve "Sor" aynı tanımları kullanır; çıktılar kısa tutulur: seçili
alanlar, sınırlı listeler, YYYY-AA-GG tarihler):

| Alan | Okuma araçları | Yazma araçları (yalnız okuma + yazma erişim anahtarı) |
|---|---|---|
| Proje | `cde_projects_list`, `cde_members_list`, `cde_companies_list`, `cde_activity` | `cde_member_add` |
| Klasör / dosya | `cde_folder_contents`, `cde_folder_tree`, `cde_folder_permissions_get`, `cde_naming_standards_list`, `cde_naming_validate`, `cde_file_get`, `cde_models_list`, `cde_file_antet` (PDF antet alanları, revizyon uyarıları), `cde_spec_registers_list` | `cde_folder_create`, `cde_folder_update`, `cde_folder_permissions_set`, `cde_file_update` |
| Sorun | `cde_issues_list`, `cde_issue_get`, `cde_issue_comments_list`, `cde_bcf_export` | `cde_issue_create`, `cde_issue_update`, `cde_issue_comment_add`, `cde_bcf_import` |
| İşler (bilgi talebi, teknik onay, toplantı, eylem, yazışma) | `cde_work_types_list`, `cde_works_list` (kategori/tip/durum/açık/geciken/benim filtreleri; sıradaki taraf), `cde_work_get` (alanlar, bağlantılar, zaman çizelgesi, onay zinciri, tutanak), `cde_rfi_log`, `cde_submittal_register`, `cde_today` (projeler arası işlerim), `cde_project_today` (projenin Bugün sayfası ve Günün Özeti) | `cde_work_create` (tip anahtarıyla; alanları API doğrular), `cde_work_comment`, `cde_work_submit`, `cde_work_respond` (sonuç + yorum / resmi cevap, çağıranın adına), `cde_meeting_minutes_update` |
| İnceleme | `cde_reviews_list`, `cde_review_get` (dosya başına zincir durumu) | — |
| Form / lokasyon | `cde_form_templates_list`, `cde_forms_list`, `cde_form_get`, `cde_locations_tree` | `cde_form_create_draft` |
| İş programı | `cde_schedule_list`, `cde_schedule_activities` (geciken / kritik / yakın dönem), `cde_schedule_compare` (varsayılan: en yeni ↔ temel plan / önceki versiyon) | — |
| Koordinasyon | `cde_clash_tests_list`, `cde_clash_results` (duruma ve sınıf çiftine göre sayılar, en büyük gruplar) | — |

Yazma araçlarının açıklamaları istemciye "önce kullanıcıdan onay al" der; her çağrı (başarısızlar dahil) `mcp.tool` olarak
denetim kaydına yazılır. Yerel dosya araçları (`cde_file_upload`, `cde_file_download`) yalnız stdio sunucusundadır.
Yönetim → **Yapay zekâ ve MCP** ekranında hazır örnekler (Claude Desktop dahil) kopyalanabilir.

Geliştirici MCP'si (Claude Code / Desktop ile hızlı test, örnek veri, senaryolar, "Yapay Zekâya Gönder" kuyruğu):
[docs/onboarding/GELISTIRICI_MCP.md](docs/onboarding/GELISTIRICI_MCP.md). Senaryoları MCP'siz çalıştırmak için `npm run scenarios`.

Token'lar:

- **Salt okuma** (varsayılan) yalnız okur; **okuma + yazma** token'ı sistem yöneticisi izin verirse oluşturulabilir
  (AECPilot "Teslim et" yazma token'ı ister).
- İsteğe bağlı olarak belirli projelerle sınırlanır (diğer projeler 404 döner) ve 30/90/365 gün ya da süresiz geçerli olur.
- Token ile token, şifre veya yönetim ayarı değiştirilemez; bunlar tarayıcı oturumu ister.

Yönetici ayarları (`integrations.mcp`): MCP ucu açık/kapalı, yazma token'larına izin, token oluşturabilecekler
(herkes / proje yöneticileri / yalnız sistem yöneticileri), en uzun token süresi.

### Yerel stdio sunucusu

Yerel dosyaları yükleyip indiren araçlar (`cde_file_upload`, `cde_file_download`) yalnız kullanıcının bilgisayarında çalışan
stdio sunucusundadır:

```json
{
  "mcpServers": {
    "7d-cde": {
      "command": "node",
      "args": ["C:/yol/7d-cde/apps/mcp/dist/index.js"],
      "env": { "CDE_URL": "https://cde.sirket.local", "CDE_TOKEN": "7dcde_api_..." }
    }
  }
}
```

`CDE_READ_ONLY=1` yazma araçlarını kapatır.

## Yapay zekâ modları

Sistem yöneticisi Yönetim → **Yapay zekâ ve MCP** ekranında modu ve sağlayıcıları belirler:

| Mod | Ne olur |
|---|---|
| **Kapalı** | Hiçbir sağlayıcı çağrılmaz. |
| **Tam yerel** (varsayılan) | Yalnız ağ içindeki sağlayıcılar çağrılır: localhost, 127/8, ::1, 10/8, 172.16/12, 192.168/16, `*.local`, `*.internal`, `*.lan`, tek etiketli adlar (ör. docker'daki `ollama`). Veri ağdan çıkmaz; internetsiz kurulumlar için. |
| **Dış sağlayıcılara izin ver** | Claude ve DeepSeek gibi bulut sağlayıcılar, yalnız proje yöneticisinin izin verdiği projelerde kullanılır. |

Sağlayıcı türleri: **OpenAI uyumlu** (OpenRouter `https://openrouter.ai/api/v1`, Ollama `http://127.0.0.1:11434/v1`, vLLM, LM Studio, DeepSeek `https://api.deepseek.com/v1`)
ve **Anthropic** (Claude, `https://api.anthropic.com`). Proje ayarları → Yapay zekâ sekmesinde proje yöneticisi projeyi
kapatabilir ve sağlayıcı seçebilir; proje hiçbir zaman sistem modunu aşamaz.

OpenRouter, Yönetim → Yapay zekâ ve MCP ekranındaki hazır ayardan eklenir. Model kimlikleri sağlayıcı/model biçimindedir
(ör. `openai/gpt-4.1-mini`); anahtar yalnız sunucuda şifreli saklanır. Projeye Sor araç çağrıları kullandığı için
seçilen OpenRouter modelinin tool/function calling desteklemesi gerekir.

API anahtarları veritabanında AES-256-GCM ile şifreli tutulur. Anahtar `CDE_SECRET_KEY` (32 bayt, hex veya base64) ile
verilir; verilmezse ilk açılışta `DATA_DIR/secret.key` oluşturulur — veritabanıyla birlikte yedekleyin.

Not: MCP ile bağlanan istemciler araç sonuçlarını kendi modellerine gönderir. Tamamen yerel kurulumda MCP'yi yerel modelle
çalışan istemcilerle kullanın veya kapatın.

### "Sor" asistanı

Proje başlığındaki **Sor** kutusu (veya Ctrl+K) Türkçe soruları projenin yapay zekâ sağlayıcısıyla cevaplar. Asistan
yalnız okuma araçlarını (MCP ile aynı `cde_*` okuma araçları + dosya arama ve proje özeti) **kullanıcının kendi
yetkisiyle**, salt okuma ve tek proje kapsamında çalıştırır; cevapta dosya / klasör / sorun / inceleme / model / iş (bilgi
talebi, teknik onay, toplantı) / form bağlantıları verir. Cevaplarda arayüzün Türkçe terimlerini kullanır
([docs/product/TERIMLER.md](docs/product/TERIMLER.md)). Yazma araçları asistana hiç sunulmaz.

Küçük yerel modeller için istem kısa tutulur: Türkçe anahtar kelime yönlendiricisi (`routeTools`) soruya göre yalnız ilgili
araç grubunu sunar ("bilgi talebi/RFI", "teknik onay/şartname", "toplantı/tutanak/eylem", "iş/görev/termin", "form/blok/kat",
"iş programı/takvim/gecikme/kritik/temel plan", "çakışma", "dosya/klasör/pafta/antet", "model/IFC", "sorun", "inceleme/onay",
"üye/firma"); `cde_project_overview` ve dosya arama her zaman sunulur, eşleşme yoksa genel bir set kullanılır (en fazla 10
araç, kısa açıklamalar). Model sunulmayan bir okuma aracını adıyla isterse yine çalışır. Proje özeti iş tiplerine göre
açık / geciken sayıları, açık formları, en yeni iş programının bitişini, geciken faaliyetlerini ve temel plana göre kaymasını,
açık çakışma sayısını da verir; sayım soruları böylece çoğu zaman tek turda cevaplanır. Model id yerine etiket (W3), iş
numarası, form numarası, lokasyon / şablon / clash testi adı verebilir.
Sistem modu ve proje politikası uygulanır (kapalıysa 403), her soru `ai.ask` olarak denetim kaydına yazılır (soru uzunluğu,
araçlar, model, süre, okunan kayıtlar — soru ve cevap metni yazılmaz). Kullanıcı başına soru sınırı Yönetim → Yapay zekâ
ve MCP ekranından ayarlanır.

- `POST /api/v1/projects/{pid}/ask` `{ "question": "...", "conversationId"?: "..." }` → 202 iş; `?wait=1` bitene kadar bekler
- `GET /api/v1/projects/{pid}/ask/{jobId}` → ilerleme adımları, kısmi cevap, sonuç; `POST …/{jobId}/cancel`
- Yerel modelle elle deneme: `node --env-file=apps/server/.env.development apps/server/scripts/ask-smoke.mjs "Soru"`
  (`OLLAMA_MODEL`, `AS_USER`, `PORT` ile). CPU'da (qwen3 8B) bir cevap ısınmış modelde ~20–35 sn, ilk soruda 70–100 sn sürer.

## Teslim API'si (AECPilot vb.)

Tüm çağrılar `Authorization: Bearer <API token>` ile yapılır.

1. `POST /api/v1/projects/{pid}/naming/validate` `{ "folderId": "...", "names": ["ZAVM-PAS-...-0001.ifc"] }` — ad kontrolü
2. `POST /api/v1/projects/{pid}/folders/{fid}/files` (multipart) — alanlar: `comment`, `attributes` (JSON), ardından `file` parçaları.
   Aynı ad yeni versiyon olur; IFC'ler viewer için otomatik dönüştürülür. Yanıt dosya başına sonuç döner.

## Lisanslar

That Open Components / Fragments: MIT · web-ifc: MPL-2.0 · diğer bağımlılıklar `package-lock.json` içinde.
