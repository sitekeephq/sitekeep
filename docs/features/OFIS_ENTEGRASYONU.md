# Ofis entegrasyonu (tarayıcıda düzenleme ve PDF dönüştürme)

LibreOffice artık CDE imajında yok. Ofis dosyaları tarayıcı görüntüleyicilerinde açılır.
İki **isteğe bağlı** eklenti var. İkisini de sistem yöneticisi açar:

1. **Tarayıcıda düzenleme (WOPI).** Word, Excel, PowerPoint ve ODF dosyaları CDE içinde düzenlenir.
   Editör: **ONLYOFFICE Docs** ya da **Collabora Online**. İkisi de aynı WOPI kodunu kullanır.
2. **Ofis → PDF dönüştürme.** Ofis dosyasında PDF görünümü, işaretleme, görsel revizyon karşılaştırma ve toplu PDF için.
   Dönüştürücü: ONLYOFFICE, Collabora ya da **Gotenberg**. Son çare: sunucuda kuruluysa LibreOffice (soffice).

Ayarlar: **Yönetim → Office entegrasyonu**.

## Seçenekler

| | ONLYOFFICE Docs | Collabora Online (CODE) | Gotenberg |
|---|---|---|---|
| Lisans | AGPL-3.0 | MPL-2.0 | MIT |
| Tarayıcıda düzenleme | Var | Var | Yok |
| Ofis → PDF | Var (ConvertService) | Var (convert-to) | Var |
| Microsoft biçimlerine sadakat | En iyi (docx/xlsx/pptx) | İyi | İyi (LibreOffice) |
| ODF ve eski biçimler (doc/xls/ppt) | Görüntüler; düzenlemek için dönüştürme ister (desteklenmiyor) | Düzenler | Dönüştürür |
| Sınır | Ücretsiz sürüm: 20 eşzamanlı bağlantı (belgelenen) | Bağlantı sınırı yok; yükte uyarı gösterir | — |
| Docker imajı (arm64, indirme / disk) | `onlyoffice/documentserver` 1,4 GB / 5,0 GB | `collabora/code` 0,5 GB / 1,7 GB | `gotenberg/gotenberg:8` 0,7 GB / 2,5 GB |
| Boşta bellek | ≈ 1,0 GB | ≈ 0,55 GB | ≈ 40 MB |
| Kimlik doğrulama | JWT (gizli anahtar) + WOPI proof | WOPI proof (anahtarı siz eklersiniz), `aliasgroup` | İsteğe bağlı temel kimlik doğrulama |

Öneri:
- Ekip çoğunlukla Word/Excel ile çalışıyorsa **ONLYOFFICE**.
- ODF ve eski dosyalar çoksa ya da 20 bağlantı yetmiyorsa **Collabora**.
- Yalnız PDF görünümü ve işaretleme yetiyorsa **Gotenberg** (düzenleme olmaz).

Dönüştürücü "Otomatik" ise editörün sunucusu kullanılır. Editör yoksa sunucudaki soffice denenir. O da yoksa önizleme "araç yok" (`unavailable`) olur.

## Kurulum (docker compose profilleri)

Ana imaj aynı kalır. Editörler ayrı servistir ve profil ile açılır.

### ONLYOFFICE

`.env`:

```ini
CDE_OFFICE_EDITOR=onlyoffice
CDE_OFFICE_EDITOR_URL=http://onlyoffice
CDE_OFFICE_EDITOR_PUBLIC_URL=http://SUNUCU-ADI:8081
ONLYOFFICE_JWT_SECRET=uzun-rastgele-bir-anahtar
```

```sh
docker compose --profile onlyoffice up -d
```

- Compose, ONLYOFFICE'i `WOPI_ENABLED=true`, `JWT_ENABLED=true` ve aynı `JWT_SECRET` ile başlatır.
- `ALLOW_PRIVATE_IP_ADDRESS=true` gerekir: ONLYOFFICE dosyayı Docker ağındaki CDE'den (`http://app:8080`) indirir.
- `CDE_OFFICE_EDITOR_PUBLIC_URL` tarayıcının ONLYOFFICE'e ulaştığı adrestir. CDE, discovery'deki iç adresi bununla değiştirir.
- ONLYOFFICE'in örnek WOPI anahtarları her kurulumda aynıdır. Üretimde `wopi.privateKey`/`publicKey` için kendi anahtarınızı üretin.

### Collabora Online

`.env`:

```ini
CDE_OFFICE_EDITOR=collabora
CDE_OFFICE_EDITOR_URL=http://collabora:9980
COLLABORA_SERVER_NAME=SUNUCU-ADI:9980
COLLABORA_ADMIN_PASSWORD=degistirin
```

```sh
docker compose --profile collabora up -d
```

- `aliasgroup1` = CDE'nin Collabora'dan görünen adresi (`CDE_WOPI_BASE_URL`, varsayılan `http://app:8080`). Başka adrese izin verilmez.
- `server_name` = tarayıcının Collabora'ya ulaştığı ad ve port. Discovery adresleri bununla gelir.
- **`CDE_PUBLIC_HOST` şart:** CDE'nin tarayıcıdaki adı (ör. `cde.firma.com` ya da `SUNUCU-ADI:*`). Compose bunu
  `--o:net.frame_ancestors` olarak verir. Verilmezse Collabora yalnız `aliasgroup` adlarına çerçeve izni verir;
  tarayıcı editörü engeller (boş beyaz alan, konsolda `frame-ancestors` hatası). Collabora 26.04 bu ayarı "eskidi" diye
  uyarır ama uygular; yeni yol `net.content_security_policy` içine `frame-ancestors …;` yazmaktır.
- **Proof key:** `collabora/code` imajında anahtar yok; istekler imzasız gelir ve CDE imzayı doğrulayamaz
  ("Bağlantıyı test et" bunu gösterir). Anahtar üretip bağlayın:
  `ssh-keygen -t rsa -N "" -m PEM -f ./collabora/proof_key`, sonra compose'daki `volumes` satırlarını açın.
- HTTPS ters vekil arkasında: `COLLABORA_EXTRA_PARAMS=--o:ssl.enable=false --o:ssl.termination=true`.
- Ters vekil `/cool/` altında WebSocket'e izin vermeli.
- PDF dönüştürme (`/cool/convert-to`) yalnız izinli IP'lerden çalışır (`net.post_allow`). Varsayılan özel ağlar (10.x, 172.16–31.x, 192.168.x) Docker için yeterli.

### Gotenberg (yalnız PDF)

`.env`:

```ini
CDE_OFFICE_CONVERTER=gotenberg
CDE_OFFICE_CONVERTER_URL=http://gotenberg:3000
```

```sh
docker compose --profile gotenberg up -d
```

Gotenberg dışarı port açmaz; yalnız CDE ona ulaşır.

### Sonra

1. **Yönetim → Office entegrasyonu**'nu açın. Ortamdan gelen değerler görünür; buradan kaydettiğiniz değer önceliklidir.
2. **CDE'nin editörden görünen adresi**: editör konteyneri CDE'ye hangi adresle ulaşıyorsa (Docker'da `http://app:8080`).
   Boşsa tarayıcıdaki adres kullanılır.
3. **Bağlantıyı test et**: discovery, proof key, dönüştürücü durumu ve gerçek bir deneme dönüşümü (TXT → PDF).
4. Docker dışı kurulumda adresleri elle girin (ör. `https://office.firma.com`).

Docker imajında LibreOffice yok. LibreDWG (DWG → DXF) duruyor.

## Nasıl çalışır

- Dosya çekmecesinde **Düzenle** düğmesi çıkar. Koşullar: editör ayarlı, biçim editörün discovery'sinde düzenlenebilir, kullanıcı yeni versiyon yükleyebilir.
- Düğme `/p/:pid/edit/:fileId` sayfasını açar. Sayfa sunucudan bir WOPI oturumu ister ve editörü iframe'e form POST ile yükler (`access_token`, `access_token_ttl`).
- Editör dosyayı WOPI ile okur. Her kayıt (PutFile) **yeni bir CDE versiyonu** olur. Versiyon notu: "Tarayıcıda düzenlendi (ONLYOFFICE)".
- Yeni versiyon, yükleme ile **aynı servisten** geçer: klasör yetkisi, onay kapısı, isimlendirme standardı, zorunlu öznitelikler.
  Öznitelikler korunur. Önizleme, metin çıkarma (arama, "Sor", MCP) ve denetim kaydı yüklemedeki gibi çalışır.
- İçeriği değişmeyen kayıt yeni versiyon açmaz.
- Düzenleme sürerken dosya kilitlidir (WOPI LOCK, 30 dakika, editör yeniler). Çekmecede "**X düzenliyor**" görünür.
  Bu sürede yükleme ile yeni versiyon eklenemez. Proje yöneticisi takılı kalan kilidi kaldırabilir.
- Editör kapanınca çekmece yeni versiyonları kendiliğinden yükler.
- Collabora: dosya bu arada CDE'de değiştiyse kayıt 409 ile reddedilir; editör kullanıcıya sorar.
- Collabora otomatik kayıtları da versiyon olur ("otomatik kayıt" notuyla). Sıklık Collabora'da `per_document.autosave_duration_secs` ile ayarlanır.

### Onay ve review kuralları

- Onay kapılı klasörde (yalnız onaylanmış review ile dosya gelir) düzenleme kapalıdır; yükleme de kapalıdır.
  Açık bir editör oturumu da yazma hakkını kaybeder.
- Review'lar versiyona bağlıdır. Review'daki versiyon değişmez; düzenleme yeni versiyon (çalışma versiyonu) açar. Yükleme de böyle çalışır.
- Görüntüleme yetkisi olup yükleme yetkisi olmayan kullanıcı düzenleyemez. İndirme yetkisi yoksa editörde yazdırma, dışa aktarma ve kopyalama kapatılır.

## Güvenlik

### Erişim token'ları

- Her editör oturumu için 256 bit rastgele bir token üretilir. Veritabanında yalnız SHA-256'sı durur.
- Token bir kullanıcıya, bir dosyaya ve projesine bağlıdır. Başka dosyada geçmez (401).
- Ömür varsayılan 10 saat (yönetim sayfasından 1–24 saat). Süresi dolan token 401 alır.
- Her WOPI çağrısında kullanıcının **güncel** yetkisi yeniden hesaplanır. Projeden çıkarılan kullanıcı 404 alır. Yetkisi düşen yazamaz.
- WOPI uçları `/api/v1` dışındadır. Oturum çerezi ve API token'ı orada geçmez. Yalnız WOPI token'ı geçer.
- API token'ları (MCP, betikler) editör oturumu açamaz; yalnız tarayıcı oturumu açar.

### Proof key (X-WOPI-Proof)

- Editör her isteği kendi özel anahtarıyla imzalar. CDE imzayı discovery'deki açık anahtarla doğrular (RSA-SHA256).
- Geçerli: güncel anahtar, eski imza başlığı (`X-WOPI-ProofOld`) ya da eski anahtar. Anahtar dönünce discovery yeniden okunur.
- Zaman damgası 20 dakikadan eskiyse istek reddedilir (500, WOPI kuralı).
- İmza URL üzerinden atılır. Ters vekil adresi değiştiriyorsa "CDE'nin editörden görünen adresi"ni doğru girin.
- Doğrulama varsayılan açıktır. Yalnız sorun ararken kapatın (`CDE_WOPI_VERIFY_PROOF=0` ya da yönetim sayfası).

### Ağ

- Dosyalar yalnız yöneticinin girdiği adrese gönderilir. ONLYOFFICE sonuç adresi başka bir host gösterse de indirme ayarlı sunucudan yapılır.
- Yönlendirmeler (redirect) izlenmez.
- ONLYOFFICE dönüştürmesi için kaynak dosya `/wopi/convert/<bilet>` adresinden verilir. Bilet rastgele, tek dosyalık ve 10 dakikalıktır; dönüşüm bitince silinir.
- WOPI uçları (`/wopi/...`) editör sunucusuna açık olmalı. İnternete açmak gerekmez; güvenlik duvarında yalnız editör sunucusuna izin verin.
- ONLYOFFICE JWT anahtarı ve Gotenberg şifresi veritabanında AES-256-GCM ile şifreli durur (AI anahtarları gibi, `CDE_SECRET_KEY`).
- Editör iframe'i `sandbox` ile açılır. postMessage yalnız editörün adresinden kabul edilir.

## Uç noktalar

| Uç nokta | Ne yapar |
|---|---|
| `GET /api/v1/admin/office` | Ayarlar (gizli değerler yok) ve etkin durum. |
| `PUT /api/v1/admin/office` | Ayarları kaydeder. |
| `POST /api/v1/admin/office/test` | Bağlantı testi. |
| `GET /api/v1/projects/:pid/files/:id/office` | Düzenlenebilir mi, kim düzenliyor. |
| `POST /api/v1/projects/:pid/files/:id/office/session` | WOPI token'ı ve editör adresi (`mode`: `edit` / `view`). |
| `DELETE /api/v1/projects/:pid/files/:id/office/lock` | Takılı kilidi kaldırır (proje yöneticisi). |
| `GET /wopi/files/:id` | CheckFileInfo. |
| `GET /wopi/files/:id/contents` | GetFile (güncel versiyon). |
| `POST /wopi/files/:id/contents` | PutFile → yeni versiyon. |
| `POST /wopi/files/:id` | `X-WOPI-Override`: LOCK, UNLOCK, REFRESH_LOCK, GET_LOCK. PUT_RELATIVE, RENAME_FILE, DELETE → 501. |
| `GET /wopi/convert/:bilet/:ad` | ONLYOFFICE dönüştürme kaynağı. |

Veritabanı: `wopi_tokens`, `wopi_locks`. Göç: `apps/server/drizzle/0019_wopi.sql`.
Ayarlar `system_settings` içinde `office.integration` anahtarında durur.

## Ortam değişkenleri

Ortam değişkenleri yalnız varsayılandır. Yönetim sayfasında kaydedilen değer önceliklidir.

| Değişken | Anlamı |
|---|---|
| `CDE_OFFICE_EDITOR` | `onlyoffice` ya da `collabora` |
| `CDE_OFFICE_EDITOR_URL` | Editörün CDE sunucusundan adresi (ör. `http://onlyoffice`) |
| `CDE_OFFICE_EDITOR_PUBLIC_URL` | Editörün tarayıcıdan adresi (farklıysa) |
| `CDE_OFFICE_CONVERTER` | `auto`, `onlyoffice`, `collabora`, `gotenberg`, `local`, `none` |
| `CDE_OFFICE_CONVERTER_URL` | Dönüştürücü adresi (boşsa aynı türdeki editörün adresi) |
| `CDE_OFFICE_JWT_SECRET` | ONLYOFFICE JWT anahtarı (compose'da `ONLYOFFICE_JWT_SECRET`) |
| `CDE_GOTENBERG_AUTH` | Gotenberg temel kimlik doğrulama, `kullanıcı:şifre` |
| `CDE_WOPI_BASE_URL` | CDE'nin editörden görünen adresi (compose varsayılanı `http://app:8080`) |
| `CDE_WOPI_VERIFY_PROOF` | `0` ise proof doğrulaması kapalı |
| `CDE_CONVERT_TIMEOUT_MS` | Dönüşüm süre sınırı varsayılanı (180000) |

Compose profilleri için: `ONLYOFFICE_TAG`, `ONLYOFFICE_PORT` (8081), `COLLABORA_TAG`, `COLLABORA_PORT` (9980),
`COLLABORA_SERVER_NAME`, `COLLABORA_EXTRA_PARAMS`, `COLLABORA_ADMIN_USER`, `COLLABORA_ADMIN_PASSWORD`, `GOTENBERG_TAG`.
Üretimde imaj etiketlerini sabitleyin (`latest` yerine sürüm).

## Dönüştürücü sınırları

- Süre sınırı (varsayılan 180 sn), en büyük dosya (100 MB), aynı anda dönüşüm (2) ve tekrar deneme (2) ayarlanabilir.
- Ağ hatası, 429 ve 5xx tekrar denenir. 4xx ve zaman aşımı denenmez.
- Dönüştürücüye ulaşılamazsa önizleme `unavailable` olur; dosyanın hatası sayılmaz. **Tekrar dene** yeniden kuyruğa alır.

## Sınırlar

- Yeni dosya oluşturma ve "farklı kaydet" (PUT_RELATIVE) yok. Yeniden adlandırma editörden yapılmaz.
- ONLYOFFICE'te doc/xls/ppt düzenleme için "dönüştür ve düzenle" gerekir; desteklenmez (görüntülenir).
- "X düzenliyor" kilidi açan ilk kişiyi gösterir. Birlikte düzenleyen diğer kullanıcılar listelenmez.
- `npm test` gerçek editör çalıştırmaz: sahte (mock) sunucu ve gerçek sürümlerden alınmış discovery dosyalarıyla çalışır.
  Gerçek editörlerle elle yapılan deneme aşağıda.
- Collabora'nın kapanışta kaydı editöre bağlıdır. "Kapat", değişiklik varsa önce Collabora'dan kayıt ister (en çok 5 sn bekler).
- Dönüştürücüler sayıları ABD biçiminde yazar (1,234.50); Türkçe biçim (1.234,50) PDF'te çıkmaz.
- ONLYOFFICE 9.x PDF'leri de "düzenlenebilir" bildirir; CDE PDF'lerde Düzenle düğmesi göstermez (PDF'ler işaretleme ile çalışır).

## Gerçek test sonuçları (10.10.2026)

Ortam: Windows 11 arm64 geliştirme makinesi, Docker Engine 29.1.2 (linux/arm64, 12 çekirdek, 16 GB).
CDE geliştirme sunucusu `wopi.localhost:8797`; konteynerler CDE'ye `host.docker.internal:8797` ile ulaştı.
Sürümler: ONLYOFFICE Docs **9.4.0** (arm64), Collabora CODE **26.04.5.1** (arm64), Gotenberg **8.37.0** (arm64).
Üç imajın da arm64 sürümü var ve sorunsuz çalıştı.

### Ne çalıştı

| Kontrol | ONLYOFFICE 9.4 | Collabora 26.04 | Gotenberg 8.37 |
|---|---|---|---|
| Discovery | 29 biçim düzenlenebilir; proof key var | 40 biçim düzenlenebilir; **proof key yok** (anahtar bağlanınca var) | — |
| DOCX / XLSX / PPTX editörde açılıyor | Evet / Evet / Evet | Evet / Evet / Evet | — |
| Kaydet → yeni CDE versiyonu | Evet (DOCX, PPTX; not "Tarayıcıda düzenlendi (ONLYOFFICE)") | Evet (DOCX, XLSX) | — |
| X-WOPI-Proof doğrulaması | Geçti | Anahtar bağlanınca geçti | — |
| Kilit / "X düzenliyor" | Evet; kayıttan sonra kilit kalkıyor | Evet; kayıtla aynı anda kilit kalkıyor | — |
| Kilitliyken yükleme engeli | Evet | Evet | — |
| Onay kapılı klasör | Düzenle kapalı (403); salt okunur oturum açılıyor | Düzenle kapalı; "Salt okunur" açılıyor, kilit alınmıyor | — |
| İsimlendirme standardına uymayan ad | Düzenle kapalı (403) | Düzenle kapalı (403) | — |
| Arama metni yeni versiyondan | Evet (PPTX konuşmacı notu dahil) | Evet | — |
| Ofis → PDF önizleme | Evet (ConvertService, JWT) | Evet (convert-to) | Evet |
| Editörün kendi "Kapat" düğmesi | UI_Close geliyor, dosyaya dönülüyor | Denenmedi (CDE "Kapat" düğmesi denendi) | — |
| "Bağlantıyı test et" | Tümü yeşil | Proof key adımı kırmızı (anahtar yoksa) | Tümü yeşil |

### Bulunan ve düzeltilen hatalar

1. **Kayıt kapanıştan sonra geliyor.** ONLYOFFICE son kullanıcı ayrıldıktan ≈ 5–6 sn sonra kaydeder. Collabora kaydı
   kapanışla aynı anda yollar. Çekmece eski versiyonu gösteriyordu. Düzeltme: editör sayfası kapanınca çekmece yeni
   versiyonu bekler ("Editörün son kaydı bekleniyor…"), gelince listeyi yeniler. Kilit kalkmış ve 20 sn'de bir şey
   gelmemişse bekleme biter (değişiklik yapılmamış demektir); üst sınır 60 sn.
2. **Collabora UNLOCK'u PutFile'ın cevabını beklemeden yollar.** Sıra ters düşerse kayıt "kilitli değil" (409) ile
   kaybolabilirdi. Düzeltme: kilit UNLOCK'ta silinmez, süresi "şimdi" yapılır; aynı kilitle 60 sn içinde gelen kayıt
   kabul edilir (test: `wopi.test.ts`).
3. **Collabora çerçevesi tarayıcıda engellendi** (`frame-ancestors`). Düzeltme: compose'a `CDE_PUBLIC_HOST` →
   `net.frame_ancestors`; editör 25 sn içinde açılmazsa sayfada açıklayıcı uyarı.
4. **Collabora imajında proof key yok.** Belgelendi; compose'a anahtar bağlama satırları eklendi.
5. **ONLYOFFICE dönüştürme** artık eşzamanlı (`async: false`) istenir; yoklama döngüsü yalnız uzun dönüşümde çalışır.
6. Salt okunur oturumda başlık "Salt okunur: değişiklikler kaydedilmez." diyor.
7. Gerçek discovery dosyaları (ONLYOFFICE 9.4, Collabora 26.04) test fixture'ı oldu. ONLYOFFICE 9.x de Collabora gibi
   MIME türü adlı uygulamalar yayınlıyor; ayrıştırıcı ikisini de okuyor.

### Süreler (arm64, ısınmış)

Dönüştürücüye doğrudan istek (3 denemenin aralığı):

| Dosya | Gotenberg | Collabora | ONLYOFFICE |
|---|---|---|---|
| DOCX, 2 sayfa | 0,14–0,22 sn | 0,10–0,26 sn | 1,0 sn |
| DOCX, 23 sayfa | 0,28–0,30 sn | 0,24–0,37 sn | 2,0 sn |
| PPTX, 1 slayt | 0,23 sn (ilk: 0,79) | 0,25 sn | 1,0 sn |
| XLSX | 0,12 sn | 0,11 sn | 1,0 sn |
| 4 × 23 sayfa aynı anda | 1,2 sn | 0,3 sn | 5,0 sn |

- ONLYOFFICE ConvertService sonucu 1 sn adımlarla bildiriyor; süreler bu yüzden 1,0 / 2,0 sn çıkıyor. Aynı anda gelen
  dönüşümleri sıraya koyuyor.
- CDE'de "yükle → PDF hazır" süresi yukarıdakine ≈ 1 sn ekler (iş kuyruğu ve PDF metni okuma): Gotenberg ve Collabora
  ≈ 1,1–1,4 sn, ONLYOFFICE ≈ 1,9–2,9 sn.
- Konteynerin hazır olması: Gotenberg 1,5 sn, Collabora ≈ 8 sn, ONLYOFFICE ≈ 7 sn (healthcheck).
- Editör açılışı (sunucu tarafı, CheckFileInfo → kilit): Collabora ≈ 0,3 sn, ONLYOFFICE ≈ 1,3 sn.
- Kapat → yeni versiyon: Collabora < 1 sn, ONLYOFFICE ≈ 6 sn.

### Görünüm (dönüştürülen PDF'ler)

- Türkçe karakterler üç dönüştürücüde de doğru. Calibri yerine Carlito (ölçü uyumlu) kullanılıyor; sayfa sayıları
  aynı (2 ve 23 sayfa).
- DOCX: üçü neredeyse aynı. Collabora tablo başlığını Liberation Sans ile biraz daha kalın çiziyor.
- XLSX: formüller yeniden hesaplanıyor (toplam doğru). Sayılar ABD biçiminde (1,234.50). ₺ işareti doğru.
- PPTX: üçü aynı; ONLYOFFICE Arial, diğerleri Liberation Sans kullanıyor.

### 20 bağlantı sınırı (ONLYOFFICE)

- `http://127.0.0.1:8000/info/info.json` (yalnız konteyner içinden) açık bir editörle `quota.edit.connectionsCount = 1`
  gösterdi. Aynı anda üç dönüşüm yapılırken sayı 1'de kaldı: **dönüştürme istekleri bağlantı sayılmıyor.**
- 9.4.0 Community lisans bilgisi `hasLicense: false` ve `connections: 2147483647` gösteriyor. 20 sınırına bu testte
  ulaşılmadı (20 ayrı tarayıcı oturumu açılmadı); belgelenen sınır 20 eşzamanlı düzenleme bağlantısıdır.

### Denenmeyenler

- ONLYOFFICE'te XLSX kaydı, Collabora'da PPTX kaydı (açılış denendi). Tarayıcı otomasyonu iç içe çerçevede yazamadığı
  için ONLYOFFICE kaydı editör adresi ayrı sekmede açılarak yapıldı; çekmecenin kaydı beklemesi CDE sayfasından denendi.
- HTTPS ters vekil, 20'den fazla eşzamanlı ONLYOFFICE oturumu, büyük (100 MB+) dosyalar.
