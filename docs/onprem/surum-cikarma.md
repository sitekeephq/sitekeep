# Sürüm çıkarma (elle)

Bir SiteKeep sürümünü elle çıkarıp Odoo sitesine yüklemek. Otomatik yol (GitHub Actions, `v*` etiketi):
[kurulum-paketi.md](kurulum-paketi.md) §8; ikisi aynı paketi üretir.

## Ne üretilir

```text
~/SiteKeep-surumler/sitekeep-1.0.0/
├── sitekeep-community-1.0.0-linux-amd64.tar.gz (+ .sha256)    herkese açık indirme
├── sitekeep-enterprise-1.0.0-linux-amd64.tar.gz (+ .sha256)   yalnız müşteri portalında
├── sitekeep-1.0.0-sbom.cdx.json                               bağımlılık listesi (CycloneDX)
├── SURUM-NOTLARI.md                                           kurulum ve güncelleme komutları
└── SHA256SUMS
```

Modüller ayrı dosya değildir: Enterprise paketi yedi modülü de taşır, müşterinin hangilerini kullanacağını
satıştan sonra üretilen **lisans dosyası** belirler (lisanslama.md, baştaki bölüm).

## Adımlar

1. `main` güncel ve CI ya da yerel testler yeşil olsun (`git pull`).
2. Sürümü çıkarın (Node 22, Docker, `gh auth login` ya da `NODE_AUTH_TOKEN`):

   ```bash
   deploy/release.sh --version 1.0.0 --tag
   ```

   Sırasıyla: çalışma ağacı temiz mi → tip kontrolü ve birim testleri → Community paketi → Enterprise paketi
   (ikisi de imaj kaynak ve harita dosyası taşımıyor mu, Community'de kapalı modül var mı diye kontrol edilir)
   → SBOM, sürüm notları, `SHA256SUMS` → yerel `v1.0.0` etiketi. Süre: Linux amd64'te testlerle birlikte yaklaşık 40–60 dakika (CI'da tek paket 29 dakika sürmüştü).

   | Seçenek | Ne yapar |
   |---|---|
   | `--smoke` | Her paketi boş bir Linux sunucuya (Docker içinde Docker) kurup dener: kurulum, sürüm ve lisans kontrolü, HTTPS, giriş, yükleme, yedek / geri yükleme, güncelleme, geri dönüş, kaldırma. İlk sürümlerde önerilir. |
   | `--push-images` | İki imajı ghcr.io'ya da gönderir ([Docker Compose](docker-compose.md) kurulumları için; önce `docker login ghcr.io`). |
   | `--skip-tests` | Testleri atlar (az önce çalıştırdıysanız). |
   | `--out <klasör>` | Çıktı klasörü (varsayılan `~/SiteKeep-surumler`). |
   | `--platform` | Varsayılan `linux/amd64` (müşteri sunucuları). |

3. Odoo sitesine yükleyin: Community paketi ve `.sha256`'sı herkese açık indirme sayfasına, Enterprise paketi
   müşteri portalına (yalnız lisanslı müşteriler). Sürüm notları `SURUM-NOTLARI.md`'de.
4. Etiketi gönderin: `git push origin v1.0.0`.
5. Açık depoyu güncelleyin ve Community sürümünü orada da yayımlayın:

   ```bash
   tools/public-sync.sh "SiteKeep 1.0.0" --push        # iç dışa aktarma + tarama, tek commit, github.com/sitekeephq/sitekeep
   docker tag sitekeep:1.0.0 ghcr.io/sitekeephq/sitekeep:1.0.0 && docker push ghcr.io/sitekeephq/sitekeep:1.0.0
   gh release create v1.0.0 -R sitekeephq/sitekeep --title "SiteKeep Community 1.0.0" -F ~/SiteKeep-surumler/sitekeep-1.0.0/SURUM-NOTLARI.md \
     ~/SiteKeep-surumler/sitekeep-1.0.0/sitekeep-community-1.0.0-linux-amd64.tar.gz*
   ```

   Enterprise paketi açık depoya hiç konmaz. `tools/public-sync.sh` taramada iç bilgi izi bulursa durur
   (`tools/public-export.markers`, izin verilenler `tools/public-export.allow`).

**Nerede derlenir:** müşteri sunucuları amd64'tür. Apple silicon Mac amd64 imajını öykünerek (emulation) derler
ve DWG aracının derlenmesi uzun sürer (saat mertebesi). Hızlı yol bir Linux amd64 makinedir, örneğin geçici
bir Google Cloud makinesi:

```bash
gcloud compute instances create sitekeep-build --zone=us-central1-c --machine-type=e2-standard-8 \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud --boot-disk-size=100GB
# makinede: Docker, Node 22, gh; depoyu klonlayıp deploy/release.sh; paketleri indirip makineyi silin
gcloud compute instances delete sitekeep-build --zone=us-central1-c
```

## Satıştan sonra: lisans

Müşteri Yönetim → Lisans'taki kurulum kimliğini gönderir; lisansı üretip müşteriye iletin:

```bash
node tools/license/issue.mjs --key ~/.sitekeep/license-signing-2026-11.pem --kid 2026-11 \
  --customer "Poyraz İnşaat A.Ş." --customer-id odoo-1187 --installation inst_… \
  --modules cost,planning --seats 50 --from 2026-12-01 --until 2027-11-30 --out poyraz-2026.json
```

Müşteri dosyayı aynı ekrandan yükler; modüller açılır. Yenilemede aynı komut yeni tarihlerle çalıştırılır.
