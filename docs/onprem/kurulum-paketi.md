# Kurulum paketi (on-prem, Linux)

Satılan kurulum: müşteri BT'si tek bir paketi sunucusuna açar, `sudo ./install.sh` der, sonunda
tarayıcıdan CDE'ye girer. Kod, veritabanı, HTTPS ve gece yedeği otomatik kurulur; internet
gerekmez. Windows exe aynı içeriği sonra taşıyacak ([kapasite.md](kapasite.md) §10); lisans
ayrı iş (lisanslama.md).

Durum (02.11.2026): ilk sürüm **`v1.0.0-rc1`** (ön sürüm) CI'da üretildi ve
GitHub Release'e kondu:
`sitekeep-1.0.0-rc1-linux-amd64.tar.gz` (413 MB) + `.sha256`. Release iş akışı 29 dakika; amd64
duman testi (2 vCPU / 8 GB runner) kurulumdan kaldırmaya geçti. Duman testi daha önce
güncellemenin yeni imaja hiç geçmediği bir hatayı yakalamıştı (Compose kabuk ortamını `.env`'ye
tercih ediyordu); düzeltildi, test çalışan imajı da doğruluyor. Gerçek bir müşteri benzeri
sunucuda (Ubuntu VM) deneme sırada (§7).

---

## 0. Müşteriye teslim

**İki sürüm (12.11.2026, yayın planı B-3).** Aynı paket iki sürümde üretilir (`build-bundle.sh --edition`,
Release iş akışı ikisini de üretip dener):

| Paket | İçinde | Lisans |
|---|---|---|
| `sitekeep-community-…` | Yalnız çekirdek; Enterprise modül paketleri imaja girmez (paket üretimi kontrol eder) | Gerekmez; hiç kısıtlanmaz |
| `sitekeep-enterprise-…` | Çekirdek + yedi Enterprise modülü | Yönetim → Lisans'tan yüklenen lisans modülleri açar (lisanslama.md); lisanssız Community gibi çalışır |

Imaj sürümü `SITEKEEP_EDITION` ve derleme tarihi `SITEKEEP_BUILD_DATE` taşır (lisansın güncelleme sonu
kontrolü). Enterprise paketi müşteriye Odoo müşteri portalından indirme bağlantısıyla verilir (yayın planı
C-3); müşteri başına kayıt deposu erişimi gerekmez. Bizim canlı sunucumuz sürüm vermeden derlenir
(bütün modüller açık, lisans kontrolü yok).

**Ne verilir:** tek dosya `sitekeep-<sürüm-adı>-<sürüm>-linux-amd64.tar.gz` (`community` ya da `enterprise`, aşağıda) (≈ 400 MB) ve `.sha256`'sı;
indirme bağlantısıyla ya da internetsiz kurumda USB / dosya paylaşımıyla. Kaynak deposu
verilmez. Pakette yalnız kurulum betikleri, Türkçe README ve hazır imajlar (uygulama küçültülmüş,
PostgreSQL, Caddy) var.

**Paket nerede:** depoda değil (400 MB; `dist-bundle/` git dışı). Sürüm etiketiyle CI üretir ve
GitHub Release'e koyar (§8). Depo özel olduğu için o sayfa yalnız ekibimize açıktır; müşteriye
paket bugün elle iletilir, doğru kanal süreli indirme bağlantısı ve ileride ürün sitesidir (§8.3).

**Müşterinin BT'si ne yapar:**

| Adım | Ne |
|---|---|
| 1. Sunucu | Linux (Ubuntu / Debian / RHEL) + Docker; Docker yoksa sihirbaz yolunu gösterir, internetliyse kurar |
| 2. Kurulum | dosyayı kopyalar, `tar -xzf`, `sha256sum -c SHA256SUMS`, `sudo ./install.sh`; sihirbaz adres, HTTPS türü ve ilk yönetici e-postasını sorar, birkaç dakikada biter |
| 3. Ağ | iç DNS'te `cde.sirket.local` → sunucu IP'si; güvenlik duvarında 443 |
| 4. Kullanım | çalışanlar tarayıcıdan `https://cde.sirket.local`; yönetici kullanıcıları ekrandan açar |
| 5. Sonrası | gece yedeği otomatik (sunucu dışına kopyalamak BT'nin işi); yeni sürümü paket olarak göndeririz, `sudo sitekeep upgrade <dizin>`, sağlıksızsa kendiliğinden geri döner |

Müşteri Node, PostgreSQL ya da kodla uğraşmaz. Sunucuda root olan biri imajı açıp küçültülmüş JS'i
görebilir; okunur kaynak görmez (§2).

---

## 1. Paket

```
sitekeep-<community|enterprise>-<sürüm>-linux-amd64.tar.gz
└─ sitekeep-<community|enterprise>-<sürüm>-linux-amd64/
   ├─ install.sh            kurulum sihirbazı (soru sorar veya --answers ile sorusuz)
   ├─ sitekeep                yönetim komutu (kurulumda /usr/local/bin/sitekeep olur)
   ├─ compose.yml           PostgreSQL + SiteKeep + Caddy
   ├─ cevap.env.example     sorusuz kurulum için örnek
   ├─ README.md             müşteri BT'si için kurulum ve yönetim
   ├─ VERSION, ARCH, SHA256SUMS
   └─ images/images.tar.gz  sitekeep:<sürüm>, postgres:17, caddy:2 (docker save)
```

Müşteri sunucusunda gereken yalnız **Docker Engine + Compose eklentisi**. Docker yoksa sihirbaz
kurulum yolunu gösterir; internetli sunucuda `CDE_INSTALL_DOCKER=1` ile kendisi kurar.

Derleme (bizde, `read:packages` token'ıyla; görüntüleyici paketi özel):

```bash
NODE_AUTH_TOKEN=… deploy/onprem/build-bundle.sh --version 1.0.0 --platform linux/amd64
```

Çıktı `dist-bundle/`. Betik imajda kaynak dosya (`.ts`, `.map`) bulursa durur. Sürüm paketleri
elle değil CI'da üretilir (§8); elle derleme yalnız deneme içindir.

## 2. Kodun korunması

İmajdaki sunucu kodu **küçültülmüş** gider (`tools/harden-dist.mjs`, Dockerfile içinde):
yorumlar, boşluklar, yerel adlar gider; `.map` ve `.d.ts` silinir; geliştirici demo/yük
betikleri (`seed-*`, `assign-ui-load`) imaja girmez. Web zaten küçültülmüş ve haritasız.
12 MB okunur kod → 3,4 MB tek satırlık dosyalar. Dosyalar yerinde kalır, çünkü IFC/çakışma
işçileri, migration'lar ve varlıklar yol ile yüklenir; e2e paketi (54 test) küçültülmüş
derlemeyle geçiyor.

Sınır: Node.js müşteri sunucusunda çalıştığı için kod şifrelenemez; küçültme okunabilirliği
kaldırır, gizlilik sağlamaz. Asıl koruma imzalı lisans ve sözleşmedir
(lisanslama.md §10). Daha güçlüsü (V8 bytecode) gerekirse ayrı karar.

## 3. Kurulum sihirbazı (`install.sh`)

1. **Ön kontrol:** root, Linux, mimari (paket amd64/arm64), Docker ve Compose, mevcut kurulum
   (varsa `sitekeep upgrade` önerir), kullanıcı sayısına göre işlemci / bellek / disk
   ([kapasite.md](kapasite.md) §4 kademeleri; eksikse uyarır, engellemez), 80/443 boş mu.
2. **Sorular:** sunucu adresi, HTTPS türü, ilk yönetici (şifre boşsa üretilir), dil, yedek saati
   ve sayısı. Cevap dosyasında / ortamda olan sorulmaz.
3. **İmajlar:** `docker load` (paketten; `pull_policy: never`, sunucu hiçbir şey indirmez).
4. **Yapılandırma:** `/opt/sitekeep/.env` (compose) ve `config/app.env` (uygulama), ikisi de 0600.
   Rastgele üretilir: veritabanı şifresi, `CDE_SECRET_KEY` (sırların şifreleme anahtarı),
   kurulum kimliği (`config/installation.id`, ileride lisans buna bağlanır). Caddyfile.
5. **Başlatma:** `docker compose up -d`, sağlık 3 dakika beklenir; ilk yönetici oluşunca
   `ADMIN_PASSWORD` dosyadan silinir. Vekil üzerinden HTTPS denenir.
6. **Gece yedeği:** systemd zamanlayıcısı (`sitekeep-backup.timer`), yoksa cron.

| HTTPS türü | Caddy | Not |
|---|---|---|
| `internal` (varsayılan) | `tls internal` | iç ağ; kök sertifika `config/sitekeep-kok-sertifika.crt`, istemcilere GPO ile |
| `files` | `tls /certs/cert.pem /certs/key.pem` | kurumun sertifikası |
| `auto` | Let's Encrypt | herkese açık alan adı, 80/443 dışarı açık |
| `off` | `:80` | yalnız HTTP, `SECURE_COOKIES=0` |

Uygulama yalnız iç Docker ağında dinler (port yayımlamaz); dışarıya yalnız Caddy açılır.
`CDE_TRUST_PROXY=1` ile istemci IP'si (giriş denemesi sınırı, günlükler) ve HTTPS bilgisi
vekilden okunur.

## 4. Yönetim komutu (`sitekeep`)

| Komut | Ne |
|---|---|
| `status` | servisler, sağlık, sürüm, kurulum kimliği, son yedek, disk |
| `logs [app\|db\|proxy]` | günlükler |
| `start` / `stop` / `restart` | |
| `backup` | `pg_dump -Fc` (+ `pg_restore --list` ile doğrulama), dosyalar (rsync varsa önceki yedeğe sabit bağla artımlı, yoksa tam kopya), ayarlar; saklama `CDE_BACKUP_KEEP` |
| `backups` | liste |
| `restore <yedek>` | önce şu anki durumu yedekler, veritabanını ve dosyaları geri yükler |
| `upgrade <paket dizini>` | yedek → imaj yükle → başlat (migration açılışta) → sağlık; 3 dk'da sağlıklı değilse eski sürüme ve güncelleme öncesi veritabanına döner |
| `uninstall [--purge]` | servisleri kaldırır; veri ve ayarlar kalır, `--purge` siler |

Yedek aynı diskte durur; müşteriye sunucu dışına kopyalaması README'de söylenir. Uzak hedefler
(SFTP / S3 / NAS) [yedekleme.md](yedekleme.md)'deki motorla gelecek.

## 5. Duman testi

```bash
deploy/onprem/smoke-test.sh dist-bundle/sitekeep-<community|enterprise>-<sürüm>-linux-<arch>.tar.gz
```

Boş bir Linux "sunucu" (docker:dind) açar ve müşteri BT'sinin yolunu yürür: sağlama toplamı →
sorusuz kurulum → HTTPS sağlık → sırların izinleri, kök sertifika, imajda kaynak olmaması →
giriş → proje + dosya yükleme → yedek → dosyayı silme → geri yükleme (dosya geri gelir) →
güncelleme (veri yerinde) → bozuk sürüme güncelleme kendiliğinden geri alınır → kaldırma (veri
kalır). dind Alpine'dir: systemd yok (zamanlayıcı cron'a düşer), rsync yok (yedek tam kopya).
Ubuntu / RHEL'deki gerçek sunucu denemesi ayrıca yapılır.

Sunucunun mimarisi paketten gelir. Apple silicon Mac'te amd64 paketi emülasyonla çalışır; orada
konteyner içinde konteyner (dind) başlamaz (`runc … broken pipe`), bu yüzden amd64 duman testi
yalnız CI'da (gerçek amd64) koşar. Mac'te arm64 paketiyle tam test, amd64 imajı için tek katman
açılış kontrolü (sağlık, giriş, `dwg2dxf`) yapılır.

## 6. S3 / MinIO

Şirket içi kurulumda gerekmez: dosyalar `CDE_DATA/app` altında, istenirse ayrı disk veya NAS
bağlanır. Nesne deposu sürücüsü müşteri isterse eklenir; kodda 14 yer dosyayı yerel yol olarak
okuyor (IFC, önizleme, çakışma, belge karşılaştırma işçileri), bunlar için geçici indirme katmanı
gerekir (KALANLAR.md §1).

## 7. Yapılacaklar

Öncelik sırasıyla. Linux paketi (`v1.0.0-rc1`) uçtan uca hazır; bunlar ilk müşteriden önce ve sonra.

| # | İş | Neden / kapsam | Durum |
|---|---|---|---|
| 1 | **Gerçek sunucu denemesi** | Testler simülasyonda (Mac'te dind, CI'da runner). Temiz Ubuntu 24.04 amd64 VM'de (canlıdan ayrı) bir kez gerçek kurulum: sihirbaz sorulu, `internal` ve `auto` HTTPS, systemd yedek zamanlayıcısı, rsync'li artımlı yedek, sunucu yeniden başlayınca servislerin kalkması, `upgrade` ile rc1 → rc2. İlk müşteriden önce şart. | VM bekliyor |
| 2 | **Lisans adımı** | `installation.id` hazır. Model: kalıcı + ürün sitesinden deneme (ör. 14 gün) ve haftalık / aylık abonelik, AEC Pilot'taki gibi Odoo planlarıyla (lisanslama.md §12a). Kod: sihirbazda anahtar / lisans dosyası adımı, Yönetim → Lisans, salt okunur durum (Faz 1–2, 5). | Worker / Odoo erişimi bekliyor |
| 3 | **Yedeğin sunucu dışına çıkması** | Yedek bugün aynı diskte; disk arızasına karşı korumak müşteri BT'sinde. `sitekeep backup` sonrası NAS / SFTP / S3 hedefine kopya, saklama ve deneme geri yüklemesi ([yedekleme.md](yedekleme.md)). | yok |
| 4 | **Müşteri indirme kanalı** | Bugün ekip GitHub Release'den indirip elle iletiyor. Sıradaki: GCS süreli bağlantı, sonra ürün sitesinde müşteri portalı (§8.3). | tasarım hazır |
| 5 | **Windows exe** | İkinci paket, aynı uygulama kodu. Release iş akışına `windows-latest` işi: taşınabilir Node, PostgreSQL / Caddy / LibreDWG Windows ikilileri, WinSW servisleri, Inno Setup sihirbazı, `sitekeep.exe` (Node SEA), sessiz kurulum duman testi, kod imzalama (Azure Artifact Signing). Mac'te üretilemez: Inno Setup Windows'a özgü, `@napi-rs/canvas` ve `@cursor/sdk` Windows ikilisi ister. ≈ 2–3 hafta ([kapasite.md](kapasite.md) §10). | yok |
| 6 | **Ofis düzenleme** (isteğe bağlı) | ONLYOFFICE / Collabora pakette yok; `compose.yml`'ye profil ve sihirbaza "ofis düzenleme" sorusu. | yok |
| 7 | **arm64 paketi** (isteğe bağlı) | ARM sunucu isteyen müşteri için; iş akışında ikinci platform. | yok |
| 8 | **Daha güçlü kod koruması** (isteğe bağlı) | Küçültme yeterli değilse V8 bytecode; Node sürümüne ve işçilere (worker) uyum işi (§2). | karar |
| 9 | **Sıfır dokunuşlu kurulum: eksik sihirbaz adımları** | Karar (09.11.2026): kurulumla ekip uğraşmaz, sihirbaz dışı istek ücretlidir (fiyat belgesi §3.3). Sihirbaza eklenecek: SMTP (test e-postasıyla), sunucu dışı yedek hedefi (deneme yazmayla; #3 ile), Enterprise'da SSO/LDAP (bağlantı denemesiyle), özet ve onay ekranı. Lisans adımı #2'de. | yok |
| 10 | **Kendi kendine duman testi ve kurulum raporu** | Kurulum sonunda müşteri sunucusunda kısa doğrulama (sağlık, giriş, dosya yükleme/indirme, IFC önizleme, yedek alma) ve PDF kurulum raporu; isteğe bağlı olarak 7Dimensions'a gönderim. | yok |
| 11 | **İlk açılış sihirbazı (web)** | Yöneticinin ilk girişinde: kurum bilgileri, kullanıcı daveti / CSV / LDAP içe aktarma, ilk proje şablonu (ISO 19650 UK NA, ÇŞB 2026, boş) ile proje kodu, görev ekipleri, klasör, isimlendirme ve onay akışının otomatik kurulması, kapasite hızlı kontrolü. | yok |
| 12 | **Barındırma için otomatik açma** | Ürün sitesindeki form → cevap dosyası → sunucu açma (Hetzner API) → `install.sh --answers` → ilk açılış verisi. Elle müdahale yok. | yok |

---|---|
| Müşteri indirme kanalı | GCS süreli bağlantı, sonra ürün sitesi (§8.3) |
| Gerçek sunucu denemesi | temiz Ubuntu 24.04 VM (amd64): sihirbaz, `auto` ve `internal` HTTPS, yedek zamanlayıcısı |
| Ofis (ONLYOFFICE / Collabora) | pakette yok; isteğe bağlı profil olarak eklenebilir |
| Uzak yedek hedefi | yedekleme motoruyla |
| Lisans | `installation.id` hazır; lisans dosyası adımı lisans işiyle |
| Windows exe | aynı içerik, [kapasite.md](kapasite.md) §10 |

---

## 8. Dağıtım

### 8.1 Sürüm çıkarma (bugün)

Elle (GitHub Actions'sız): [surum-cikarma.md](surum-cikarma.md), `deploy/release.sh`. Otomatik:

`.github/workflows/release.yml`. Sürüm `main`'den, yeşil CI'dan sonra etiketlenir:

```bash
git tag -a v1.0.0 -m "SiteKeep 1.0.0" && git push origin v1.0.0
```

İş akışı (12.11.2026, yayın planı B-5) iki iştir:

1. **`bundle`**, iki sürüm için sırayla (`community`, `enterprise`): `npm ci` → derleme, tip kontrolü, birim
   testleri → `build-bundle.sh --edition <sürüm> --platform linux/amd64` → `smoke-test.sh` (boş Linux sunucuda
   kurulumdan kaldırmaya; sürüm ve lisans kontrolü dahil, §5) → GitHub Release `v1.0.0`:
   `sitekeep-community-1.0.0-linux-amd64.tar.gz`, `sitekeep-enterprise-1.0.0-linux-amd64.tar.gz`, `.sha256`'ları
   ve `sitekeep-1.0.0-sbom.cdx.json` (bağımlılık listesi). Sayfa metni `deploy/onprem/release-notes.md`'den,
   ardından otomatik değişiklik listesi.
2. **`images`**, iki paket de duman testinden geçince: `ghcr.io/sitekeephq/sitekeep:1.0.0` ve
   `sitekeep-enterprise:1.0.0` (son sürümde `:latest` da) GitHub kayıt deposuna ([Docker Compose](docker-compose.md)).

Tire içeren sürüm (`1.0.0-rc1`) ön sürüm olarak işaretlenir ve `:latest` almaz. Duman testi geçmezse
release açılmaz, imaj yayımlanmaz.

Etiketsiz deneme: Actions → Release → *Run workflow* → sürüm (ör. `1.0.0-rc2`). Aynı derleme ve
test; release açılmaz, paket bir hafta iş akışı çıktısı (artifact) olarak durur.

Görüntüleyici paketi (`@7dimensions-project/bim-viewer`) aynı organizasyonda olduğu için iş akışı
`GITHUB_TOKEN` (`packages: read`) ile okur; ayrı sır gerekmez.

### 8.2 Ekip paketi nasıl alır

```bash
gh release download v1.0.0 -R sitekeephq/sitekeep -p 'sitekeep-*-1.0.0-linux-amd64.tar.gz*'
shasum -a 256 -c sitekeep-*-1.0.0-linux-amd64.tar.gz.sha256
```

Bugün müşteriye iletim elle: şirket Google Drive'ında yalnız müşterinin BT e-postasına paylaşım,
ya da internetsiz kurumda USB. SHA-256 değeri ayrıca (e-posta / teslim tutanağı) verilir; müşteri
`sha256sum -c` ile doğrular.

### 8.3 Doğru müşteri kanalı (sonra)

GitHub Release iç kanaldır: depo özel, müşteri hesabı yok, kimin hangi sürümü indirdiği kaydı yok.
Hedef iki adımda:

**1. GCS süreli bağlantı.** Altyapı küçük, satışa hazır:

| Parça | Ne |
|---|---|
| Bucket | özel `gs://sitekeep-releases` (herkese açık değil), sürüm başına `v1.0.0/` klasörü |
| CI | release iş akışı paketi bucket'a da yükler; kimlik GitHub OIDC → Workload Identity Federation (depoda anahtar dosyası durmaz) |
| Paylaşım | `deploy/onprem/share-release.sh v1.0.0 "Müşteri A.Ş."`: imzalı, 7 gün geçerli, tahmin edilemez bağlantı üretir ve kime verildiğini kayda yazar |
| Kayıt | sürüm × müşteri × tarih (lisans işiyle Odoo'ya bağlanır, lisanslama.md §6.2) |
| Maliyet | depolama sürüm başına ≈ 400 MB; indirme trafiği müşteri başına bir kez |

**2. Ürün sitesi.** SiteKeep için açılacak web sitesinde müşteri portalı: müşteri kendi hesabıyla
girer, lisansının kapsadığı sürümleri görür ve indirir (bağlantılar arka planda yine GCS'den
imzalanır). Sürüm notları, kurulum belgesi ve SHA-256 aynı sayfada. Destek süresi biten müşteri,
süresinden sonra çıkan sürümü görmez (lisanslama.md §5.4). Release iş akışı değişmez; yalnız
yayın adımı siteye de bildirir.

