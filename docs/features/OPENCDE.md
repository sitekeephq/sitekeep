# SiteKeep — OpenCDE ve OAuth2

Bu belge OpenCDE uyumluluğunun canlı kısmını anlatır. Araştırma ve tam plan `docs/archive/research/OPENCDE_ARASTIRMA.md` içinde.

## 0. Durum

| Parça | Durum | Not |
|---|---|---|
| Foundation API 1.1 + yerleşik OAuth2 | ✓ Canlı | §1 |
| Documents API 1.0 | ✓ Canlı | §1, §3a. Doküman yükleme, seçme, indirme, versiyon sorgusu |
| BCF dosyası (.bcfzip 2.1 / 3.0) içe / dışa aktarma | ✓ Canlı | `docs/features/BCF.md`. Dosya alışverişi, API değil |
| BCF API 3.0 (canlı bağlantı, ör. Solibri BCF Live) | Bekliyor | §6. `CDE_OPENCDE_APIS=bcf` bayrağı kapalı kalmalı |

## 1. Neler canlı

**OpenCDE Foundation API 1.1** (kök adreste, `/api/v1` dışında):

| Uç | Ne yapar |
|---|---|
| `GET /foundation/versions` | Sunulan OpenCDE API'lerini listeler: `foundation 1.1` ve `documents 1.0`. |
| `GET /foundation/1.1/auth` | OAuth2 adreslerini verir. Akış yalnız `authorization_code_grant`. `http_basic_supported: false`. Dinamik istemci kaydı yok. |
| `GET /foundation/1.1/current-user` | Erişim anahtarının sahibini verir: `id` = e-posta, `name`. Anahtar yoksa `401`. |

- Yanıtlar JSON. Hatalar `{ "message": "…" }` biçiminde (spesifikasyondaki `error.json`).
- Mutlak adresler `CDE_PUBLIC_URL`'den üretilir. Değişken yoksa isteğin geldiği adres kullanılır.
- `api_base_url` her API için tam adrestir, ör. `https://cde.firma.local/foundation/1.1`.
- Tarayıcı istemcileri için CORS başlıkları var (`*`, çerez yok).
- Bilinmeyen sürüm (`/foundation/1.0/auth`) JSON `404` döner.
- Liste veriye dayalı (`apps/server/src/oauth/foundation.ts`, `OPENCDE_APIS`). Documents 1.0 her zaman duyurulur.
  BCF 3.0 kaydı hazır ama bayrak açılmadan duyurulmaz: `CDE_OPENCDE_APIS=bcf`. **BCF API canlıya çıkmadan bayrağı açmayın.**

**OpenCDE Documents API 1.0** (`api_base_url` = `<kök>/documents/1.0`, spesifikasyon:
https://github.com/buildingSMART/documents-API). Alan adları `swagger.yaml` ile birebir aynı.

| Uç (base'e göre) | Spesifikasyondaki karşılığı | Ne yapar |
|---|---|---|
| `POST /upload-documents` | `/upload-documents` | `callback`, `files[]` (`file_name`, `session_file_id`, isteğe bağlı `document_id`) alır; `upload_ui_url`, `expires_in`, `max_size_in_bytes` döner. |
| `POST /upload-sessions/{id}` | `upload_documents_url` | Dosya boyutlarını alır; `documents_to_upload[]` (`upload_file_parts`, `upload_completion`, `upload_cancellation`) döner. |
| `PUT` (ya da `POST`) `/upload-sessions/{id}/files/{fid}/parts/{n}` | `upload_file_parts[].url` | Bir parça. 16 MB'lik parçalar, `content_range_start/end` dahil sınırlar, herhangi bir sırayla. |
| `POST /upload-sessions/{id}/files/{fid}/completion` | `upload_completion` | Parçaları birleştirir, normal yükleme servisiyle kaydeder, `DocumentVersion` döner. Tekrar çağrılırsa aynı sonucu verir. |
| `POST /upload-sessions/{id}/files/{fid}/cancellation` | `upload_cancellation` | Parçaları siler, `204`. |
| `POST /select-documents` | `/select-documents` | `callback`, isteğe bağlı `server_context`, `supported_file_extensions`; `select_documents_url`, `expires_in` döner. |
| `GET /selections/{id}` | `selected_documents_url` | `server_context` ve seçilen `documents[]` (`DocumentVersion`). |
| `GET /documents/{document_id}/versions` | `document_versions` | Bütün versiyonlar, yeniden eskiye. |
| `GET /documents/{document_id}/versions/{n}` | `document_version` | Tek versiyon. |
| `GET /documents/{document_id}/versions/{n}/metadata` | `document_version_metadata` | `metadata[]` (`name`, `value[]`, `data_type`): proje, klasör, versiyon, yükleyen, tarih, boyut, SHA-256, açıklama, öznitelikler. |
| `GET /documents/{document_id}/versions/{n}/download` | `document_version_download` | Dosyanın kendisi (`200`, yönlendirme yok). İndirme yetkisi gerekir. |
| `POST /document-versions` | `/document-versions` | `document_ids[]` → en son versiyonlar. `ETag` + `If-None-Match` → `304`. |

- `document_id` = CDE'deki dosya kimliği, `version_index` = versiyon numarası, `version_number` = `v3`,
  `title` = uzantısız dosya adı (doküman kodu), `document_details` = dosyanın CDE'deki sayfası.
- `server_context` opak bir değerdir: son çalışılan proje ve klasör. İstemci sonraki oturumda geri gönderirse sayfa orada açılır.
  Kullanıcının artık göremediği bir proje ise yok sayılır.
- `include_authorization: true`: parçalar aynı sunucuya gider, Bearer anahtarı gerekir. Dış depolama yok, hiçbir dış çağrı yapılmaz.
- `multipart_form_data` gönderilmez (parça gövdesi düz ikilidir). `additional_headers` yalnız `Content-Length` içerir.
- Hatalar `{ "error", "message" }`. Süresi dolan oturum `410`, başkasının oturumu `404`, eksik izin `403`, Bearer yoksa `401`.
- CORS: her uçta `*` (çerez kabul edilmez; tarayıcı oturumuyla bu uçlar çağrılamaz).

**CDE sayfaları** (uygulamanın tarayıcıda açtığı adresler, `apps/web/src/features/integrations/pages/OpenCdeDocuments.tsx`):

- `/opencde/upload?key=…` → **Dış Uygulamadan Yükleme**: isteyen uygulama (OAuth uygulama adı), gelen dosyalar, proje ve
  yalnız yazma yetkisi olan klasörler, dosya başına "CDE'deki Adı" (isimlendirme standardına göre anında denetlenir),
  **Revizyon**, **Durum / Uygunluk** (S0–S4, A, B), **Açıklama**, klasöre bağlı proje öznitelikleri. **İptal** ya da
  **Yüklemeyi Başlat**. Sunucu her şeyi yeniden denetler; hata dosya satırında gösterilir.
- `/opencde/select?key=…` → **Dış Uygulama İçin Belge Seç**: proje, klasör ağacı, ada göre arama, çoklu seçim, istenen
  uzantılar (ör. yalnız `.ifc`) için filtre. **İptal** ya da **Seçimi Gönder**.
- Giriş yapılmamışsa önce giriş sayfası gelir, sonra aynı sayfa açılır.
- Revizyon ve Durum / Uygunluk dosyanın `Revizyon` ve `Uygunluk` özniteliklerine yazılır. Projede bu adlarla öznitelik
  tanımlıysa sabit alan gizlenir ve projenin tanımı (liste, zorunluluk) kullanılır. Açıklama versiyon açıklamasıdır.

**Yerleşik OAuth2 yetkilendirme sunucusu:**

| Uç | Ne yapar |
|---|---|
| `GET /oauth2/authorize` | Yetkilendirme kodu akışı. PKCE (S256). Oturum yoksa giriş sayfası, sonra onay sayfası. |
| `POST /oauth2/token` | `authorization_code` ve `refresh_token`. Refresh token her kullanımda yenilenir. |
| `POST /oauth2/revoke` | RFC 7009 iptali. Refresh token verilirse bütün aile iptal edilir. |

- Implicit akış, şifreyle giriş (ROPC) ve client credentials **yok**.
- Parametreler form gövdesinde ya da query string'de olabilir (bSI örneği query kullanıyor).
- `redirect_uri` ve `redirect_url` adlarının ikisi de kabul edilir.
- Token isteğinde `redirect_uri` isteğe bağlı (bSI örneği göndermiyor). Gönderilirse birebir eşleşmeli.
- İstemci kimliği: HTTP Basic ya da `client_secret_post`. İkisi birlikte kullanılamaz.
- PKCE açık istemcilerde zorunlu, gizli istemcilerde isteğe bağlı. Yalnız `S256`.
- PKCE kullanmayan gizli istemci `state` göndermek zorunda.
- Yetkilendirme kodu tek kullanımlık, en çok 60 saniye geçerli. İstemciye, yönlendirme adresine ve PKCE değerine bağlı.
- Erişim anahtarı (access token) 1 saat, refresh token 30 gün geçerli.
- Yanıt: `access_token`, `token_type: "Bearer"`, `expires_in`, `refresh_token`, `scope`.

**Web arayüzü:**

- Onay sayfası `/oauth/consent`: "<Uygulama> hesabınıza erişmek istiyor", izinler, **Onayla** / **Reddet**.
  Başka bir sitenin çerçevesi içinde açılmaz.
- Onay kullanıcı + uygulama başına hatırlanır. Aynı izinler için sayfa bir daha gösterilmez (`prompt=consent` hariç).
- **Hesabım → Bağlı Uygulamalar**: uygulama, izinler, son kullanım, **Erişimi Kaldır**.
- **Yönetim → OAuth Uygulamaları**: kayıt, düzenleme, devre dışı bırakma, gizli anahtar yenileme, silme, bağlantı bilgileri.

## 2. İzinler (scope)

| Scope | Anlamı |
|---|---|
| `read` | Mevcut `/api/v1`, salt okuma (API erişim anahtarındaki "Salt Okuma" ile aynı). |
| `write` | Mevcut `/api/v1`, okuma + yazma. |
| `bcf` | OpenCDE BCF API (geldiğinde). |
| `documents` | OpenCDE Documents API'nin tamamı: yükleme (yeni doküman, yeni versiyon), belge seçme, versiyonlar, metadata, indirme, versiyon sorgusu. Onay sayfasında "OpenCDE Dokümanları". AEC Pilot bunu ister. |
| `documents:read` | Yalnız seçme, versiyonlar, metadata, indirme, versiyon sorgusu; yükleme `403`. Onay sayfasında "OpenCDE Doküman Okuma". Salt okuyan araçlar (görüntüleyiciler) için. |

- İstemci `scope` göndermezse kayıtlı bütün izinleri ister.
- Yalnız `bcf`/`documents`/`documents:read` alan bir anahtar `/api/v1`'e erişemez (`403`). `current-user` çalışır.
- `read`/`write` Documents API'ye erişim vermez. Kişisel API erişim anahtarları (Hesabım) Documents API'yi de kullanabilir:
  "Salt Okuma" seçer ve indirir, "Okuma + Yazma" yükler de. Anahtar her zaman kullanıcının kendi klasör yetkileriyle çalışır.
- Bilinmeyen scope adları (ör. `openid`) yok sayılır. Kayıtlı olmayan bilinen bir scope `invalid_scope` döner.

## 3. Uygulama nasıl kaydedilir (Solibri örneği)

1. **Yönetim → OAuth Uygulamaları → + Uygulama**.
2. Ad: `Solibri Office`. Açıklama onay sayfasında görünür.
3. Tür: masaüstü uygulaması için **Açık İstemci** (PKCE zorunlu). Solibri gizli anahtar isterse **Gizli İstemci** seçin.
4. Yönlendirme adresi: Solibri'nin verdiği adres. Masaüstü uygulamaları genelde `http://127.0.0.1/…` ya da
   `http://localhost/…` kullanır. Bu adresler her portla eşleşir (RFC 8252). Diğer adresler birebir eşleşmeli ve https olmalı.
5. İzinler: `BCF Sorunları` + `Okuma` (gerekirse `Yazma`).
6. **Kaydet**. Gizli istemcide gizli anahtar **bir kez** gösterilir. Kopyalayın.
7. Satırdaki **Bağlantı Bilgileri** düğmesi Solibri'nin özel bağlantı (private connection) formunun istediklerini gösterir:
   sunucu adresi (Foundation URL), yetkilendirme adresi, token adresi, `client_id`, yönlendirme adresi. Hepsi kopyalanabilir.
8. Solibri'de sunucu adresi olarak kök adresi girin (ör. `https://cde.firma.local`). Gerisini `/foundation/versions` ve
   `/foundation/1.1/auth` üzerinden bulur.

Not: Solibri BCF Live için BCF API 3.0 gerekir. Bu sürümde Foundation, OAuth ve Documents API var; BCF yalnız
.bcfzip dosyası olarak alınıp verilir (`docs/features/BCF.md`, bkz. §6).

## 3a. AEC Pilot ve diğer araçlardan yükleme

AEC Pilot'un (Revit / Civil 3D) **CDE'ye Gönder** düğmesi ve benzeri masaüstü araçlar için tarif. `<kök>` = kullanıcının
girdiği sunucu adresi (ör. `https://cde.firma.local`).

**Bir kez (yönetici):** Yönetim → OAuth Uygulamaları → **AEC Pilot Ekle** (tek tık). Hazır kayıt: Ad `AEC Pilot`, tür
**Açık İstemci** (PKCE, gizli anahtar yok), yönlendirme adresi `http://127.0.0.1/aecpilot/opencde/oauth` (her port, yol
birebir), izin **OpenCDE Dokümanları** (`documents`). Açılan Bağlantı Bilgileri'nden `cde-…` istemci kimliğini kopyalayıp
AEC Pilot'a yapıştırın (dinamik istemci kaydı yok). Elle kayıt da aynı değerlerle yapılabilir.

**Bağlanma (kullanıcı başına bir kez, sonra refresh token):**

1. `GET <kök>/foundation/versions` → `documents 1.0` kaydının `api_base_url`'i (= `<docs>`, ör. `<kök>/documents/1.0`).
2. `GET <kök>/foundation/1.1/auth` → `oauth2_auth_url`, `oauth2_token_url`.
3. Araç boş bir yerel port açar (ör. `http://127.0.0.1:53682/aecpilot/opencde/oauth`), tarayıcıda `oauth2_auth_url` +
   `response_type=code`, `client_id`, `redirect_uri`, `scope=documents`, `state`, `code_challenge` (S256).
4. Kullanıcı giriş yapar, **Onayla**. Tarayıcı `redirect_uri?code=…&state=…` adresine döner.
5. `POST oauth2_token_url` (`grant_type=authorization_code`, `code`, `client_id`, `redirect_uri`, `code_verifier`) →
   `access_token` (1 saat), `refresh_token` (30 gün, her kullanımda yenilenir; yenisini saklayın).

**Yükleme (her "CDE'ye Gönder"):**

1. IFC dışa aktarımını başlatın (bitmesini beklemek gerekmez).
2. Bir yerel port açın; `POST <docs>/upload-documents` (Bearer):
   `{"callback":{"url":"http://127.0.0.1:<port>/<rastgele>/","expires_in":3600},"server_context":"<önceki değer ya da yok>","files":[{"file_name":"model.ifc","session_file_id":"<guid>"}]}`.
   Aynı dokümanın yeni versiyonu ise dosyaya `"document_id":"<önceki yanıttaki document_id>"` ekleyin.
3. Yanıttaki `upload_ui_url`'i varsayılan tarayıcıda açın (`expires_in` saniye içinde; varsayılan 10 dakika, tek kullanımlık).
4. Kullanıcı sayfada klasörü, adı, revizyonu, durumu seçer ve **Yüklemeyi Başlat**'a basar. Tarayıcı
   `http://127.0.0.1:<port>/<rastgele>/?upload_documents_url=…` (URL kodlu) adresine gelir. **İptal** edilirse `?user_cancelled_upload=true` gelir.
   Tarayıcıya kısa bir "Tamam, CAD'e dönebilirsiniz" sayfası döndürün.
5. `POST <upload_documents_url>` (Bearer) `{"files":[{"session_file_id":"<guid>","size_in_bytes":<boyut>}]}` →
   `server_context` ve `documents_to_upload[].upload_file_parts`.
6. Her parça için: `http_method` ile `url`'e, dosyanın `content_range_start`–`content_range_end` (dahil) baytları,
   `include_authorization: true` olduğu için Bearer ile. Parçalar paralel ya da herhangi bir sırada gönderilebilir.
7. `POST <upload_completion.url>` (gövdesiz, Bearer) → `DocumentVersion`. `document_id`'yi ve adım 5'teki `server_context`'i
   saklayın: bir sonraki gönderim yeni versiyon olur ve sayfa aynı klasörde açılır.
8. Vazgeçilirse `POST <upload_cancellation.url>` → `204`.

**Seçme / indirme:** `POST <docs>/select-documents` `{"callback":{…},"supported_file_extensions":[".ifc"]}` →
`select_documents_url`'i tarayıcıda açın → `?selected_documents_url=…` (ya da `?user_cancelled_selection=true`) →
`GET` (Bearer) → `documents[].links.document_version_download.url`'den indirin. Güncellik için
`POST <docs>/document-versions` `{"document_ids":[…]}` ve `If-None-Match`.

**Callback kuralları:** `callback.url` uygulamanın kayıtlı yönlendirme adresiyle birebir eşleşmeli. Kayıtlı bir loopback
adresi (`http://127.0.0.1/…`, `http://localhost/…`) olan masaüstü uygulamaları herhangi bir loopback port ve yolu
kullanabilir (RFC 8252). https bir web uygulaması yalnız kayıtlı adresine döner. Başka hiçbir adrese yönlendirilmez;
`#`, kullanıcı adı ya da şifre içeren adresler reddedilir. Kişisel API anahtarlarıyla yalnız loopback.

**Süreler ve sınırlar:** sayfa bağlantısı en çok 10 dakika içinde açılmalı ve yalnız ilk açan tarayıcı oturumunda çalışır
(başka kullanıcı ya da başka tarayıcı `403`). Sayfa gönderildikten sonra talimatlar, parçalar ve tamamlama 24 saat geçerli.
`callback.expires_in` en çok 24 saat sayılır; süresi geçince sayfa gönderilemez (`410`). Tek dosya en çok
`max_size_in_bytes` (sunucunun yükleme sınırı, varsayılan 20 GB), oturum başına en çok 50 dosya, seçimde en çok 200 doküman.

**Ne olur:** tamamlama normal yüklemenin servisini (`addVersion` + `afterVersionAdded`) kullanır: klasör yetkisi, inceleme
kapısı, isimlendirme standardı, zorunlu öznitelikler, aynı adda dosya varsa yeni versiyon, IFC → Fragments, önizleme ve
arama metni işleri, denetim kaydı (`file.uploaded` / `file.version_added`, `via: "opencde-documents"`). Yetkiler sayfa
gönderildikten sonra değiştiyse tamamlama reddedilir.

**Denetim kaydı:** `opencde.upload_started`, `opencde.upload_prepared`, `opencde.upload_instructions`,
`opencde.upload_completed`, `opencde.upload_cancelled`, `opencde.select_started`, `opencde.documents_selected`,
`opencde.selection_read`, `opencde.select_cancelled`, indirmeler `file.downloaded` (`via: "opencde-documents"`).

**Sözleşme testi:** `apps/server/test/opencde-documents.test.ts` → "meets the AEC Pilot Send to CDE contract" AEC Pilot'un
istek sırasını birebir tekrarlar (keşif, hazır OAuth kaydı, upload-documents, sayfa, rastgele yollu callback, talimatlar,
iki parça, ek başlıklar, `multipart_form_data` varsa prefix/suffix çerçeveleme, tamamlama, iki iptal yolu, hata biçimi).
SiteKeep `multipart_form_data` göndermez; istemcinin çerçeveleme adımı boş kalır.

**Spesifikasyondan dışarıda kalanlar:** dış depolama ve `multipart_form_data` (gerek yok, her şey yerel), uzun tamamlama
isteklerinde boşluk karakteriyle bağlantı canlı tutma (tamamlama yerel birleştirme, kısa sürer), indirmede `303`
yönlendirme (doğrudan `200`), seçim sayfasında eski bir versiyonu seçme (her zaman son versiyon seçilir; eski
versiyonlara `document_versions` ile ulaşılır).

## 4. Güvenlik notları

- Kodlar, erişim anahtarları, refresh token'lar ve gizli anahtarlar yalnız SHA-256 özetiyle saklanır.
- OAuth erişim anahtarları `tokens` tablosunda `kind = "oauth"` olarak durur. API erişim anahtarlarıyla **aynı** Bearer
  doğrulamasından ve aynı proje/klasör yetki kontrollerinden geçer. Uygulama kullanıcının yetkisinden fazlasını göremez.
- OAuth anahtarı tarayıcı oturumu isteyen işleri yapamaz: anahtar yönetimi, şifre, yönetim değişiklikleri, onay verme,
  bağlı uygulama kaldırma, tarayıcıda ofis düzenleme. MCP uç noktası yalnız kişisel API erişim anahtarlarını kabul eder.
- Kod yalnız tarayıcı oturumuyla verilir. Bearer anahtarı ile `/oauth2/authorize` çağrısı giriş sayfasına gider.
- Kayıtlı olmayan yönlendirme adresine asla yönlendirilmez. Bilinmeyen istemci ve yanlış adres hataları kullanıcıya sayfa olarak gösterilir.
- Giriş sonrası dönüş adresi (`/login?next=`) yalnız aynı sunucudaki `/oauth2/authorize` olabilir.
- Kod ikinci kez kullanılırsa o koddan çıkan bütün anahtarlar iptal edilir.
- Eski bir refresh token yeniden gelirse bütün aile (erişim + refresh) iptal edilir ve denetim kaydına yazılır.
- Uygulama devre dışı bırakılınca anahtarları hemen çalışmaz olur. Yeniden etkinleştirince geri gelir.
  Silinince onaylar ve anahtarlar da silinir.
- `/oauth2/token` ve `/oauth2/revoke` hatalı istekleri IP başına sınırlanır: 10 dakikada 20 hata, sonra `429` + `Retry-After`.
  Sayaç bellek içinde, sunucu süreci başına tutulur. Ters vekil (nginx, IIS) arkasında bütün istekler vekilin IP'sinden
  gelir; o durumda sınır herkes için ortak işler. Gerekirse Fastify `trustProxy` ayarı ayrıca açılmalı.
- Denetim kaydı: `oauth.authorize`, `oauth.consent_granted`, `oauth.consent_denied`, `oauth.token_issued`,
  `oauth.token_refreshed`, `oauth.token_failed`, `oauth.code_reused`, `oauth.refresh_reused`, `oauth.revoked`,
  `oauth.client_*`. Ayrıntılarda gizli değer yok.
- Günlüklerde `code`, `access_token`, `refresh_token`, `client_secret`, `code_verifier`, `token` sorgu parametreleri ve
  `7dcde_…` anahtarları `***` ile gizlenir (`redactUrl`, `redactSecrets`).
- Üretimde **HTTPS ve `CDE_PUBLIC_URL` şart**. Foundation en az TLS 1.2 ister. Müşterinin iç CA sertifikası
  Solibri'nin çalıştığı Windows makinelerinde güvenilir olmalı.

## 5. İleride SSO (Keycloak / Entra ID)

- `/foundation/1.1/auth` yanıtındaki adresler yapılandırılabilir: `CDE_OAUTH_AUTH_URL`, `CDE_OAUTH_TOKEN_URL`.
- Bugün bu değişkenler yalnız duyurulan adresi değiştirir. Dış kimlik sağlayıcının verdiği anahtarlar (JWT) henüz
  **doğrulanmaz**. Bu yüzden şimdilik boş bırakın.
- Gerekecek iş: JWKS ile JWT doğrulama, `sub`/`email` → 7D kullanıcısı eşlemesi, scope eşlemesi, yerleşik sunucuyu kapatma bayrağı.

## 6. Sonraki adımlar

1. **BCF API 3.0** (araştırma §7.1 adım B): projeler, topic, yorum, viewpoint. Görüntüleyici dalı birleştikten sonra.
   Bitince `CDE_OPENCDE_APIS=bcf` ve Solibri özel bağlantı başvurusu.
2. ~~Documents API 1.0~~ ✓ (bkz. §1, §3a).
3. Dinamik istemci kaydı (`oauth2_dynamic_client_reg_url`): gerekirse, Faz 3.
4. Hız sınırı için ortak depo (birden çok sunucu süreci olursa).

## 7. Duman testi (elle)

`apps/server/scripts/opencde-smoke.mjs` çalışan **yerel** geliştirme sunucusunda bütün akışı dener:
versions → auth → giriş → geçici açık istemci → authorize (PKCE) → onay → kod → token → current-user ve `/api/v1`
→ refresh rotation → yeniden kullanım tespiti → Documents API (yabancı callback reddi, yükleme ve seçme sayfaları açılıp
iptal edilir; dosya yazılmaz) → Erişimi Kaldır → istemciyi silme.

```bash
cd apps/server
node --env-file=.env.development scripts/opencde-smoke.mjs
```

- Ortam: `PORT` (varsayılan 8787) ya da `CDE_SMOKE_BASE`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
- Yalnız `127.0.0.1` / `localhost` adreslerinde çalışır. Başka adres verilirse durur.
- Anahtarları tam yazdırmaz. Geçici istemciyi sonunda siler.
- Geliştirmede Vite (`:5173`) `/foundation`, `/oauth2` ve `/documents` isteklerini sunucuya aktarır. Solibri ve AEC Pilot
  ile denemede bu adresi kullanın (sayfa bağlantıları da bu adresle üretilir).

## 8. Kod haritası

| Dosya | İçerik |
|---|---|
| `apps/server/src/oauth/foundation.ts` | Foundation uçları, `OPENCDE_APIS` listesi |
| `apps/server/src/oauth/routes.ts` | `/oauth2/authorize`, `/oauth2/token`, `/oauth2/revoke` |
| `apps/server/src/oauth/authorize.ts` | Yetkilendirme isteği doğrulaması |
| `apps/server/src/oauth/service.ts` | Kod, anahtar, aile, iptal |
| `apps/server/src/oauth/redirect.ts` | Yönlendirme adresi kuralları (loopback) |
| `apps/server/src/oauth/api-routes.ts` | Onay sayfası, Bağlı Uygulamalar, yönetim uçları |
| `apps/server/src/db/schema-oauth.ts` | Tablolar (göç `0026_opencde_auth`) |
| `packages/shared/src/oauth.ts` | Scope'lar, Türkçe etiketler, DTO'lar |
| `apps/web/src/features/integrations/pages/OAuthConsent.tsx`, `apps/web/src/features/admin/pages/AdminOAuth.tsx` | Onay sayfası, yönetim sekmesi |
| `apps/server/src/opencde/documents.ts` | Documents API 1.0 uçları (`/documents/1.0/…`) |
| `apps/server/src/opencde/pages.ts` | CDE sayfalarının API'si (`/api/v1/opencde/sessions/…`), yalnız tarayıcı oturumu |
| `apps/server/src/opencde/common.ts` | Erişim ve callback kuralları, `server_context`, `DocumentVersion` |
| `apps/server/src/db/schema-opencde-docs.ts` | Oturumlar, dosyalar, parçalar (göç `0030_opencde_docs`) |
| `packages/shared/src/opencde-documents.ts` | Scope → erişim, sınırlar, sayfa DTO'ları, Uygunluk kodları |
| `apps/web/src/features/integrations/pages/OpenCdeDocuments.tsx` | Dış Uygulamadan Yükleme, Dış Uygulama İçin Belge Seç |
