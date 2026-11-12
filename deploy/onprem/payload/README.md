# SiteKeep — Kurulum (Linux)

Bu paket SiteKeep'i şirket sunucusuna kurar. İçinde gereken her şey var (uygulama, PostgreSQL,
HTTPS vekili); kurulum sırasında internet gerekmez.

## Gerekenler

- 64 bit Linux (Ubuntu 22.04/24.04, Debian 12, RHEL/Rocky/Alma 9 önerilir)
- Docker Engine 24+ ve Compose eklentisi (`docker compose`)
- Yönetici (root / sudo) yetkisi
- Donanım, kullanıcı sayısına göre:

| Kullanıcı | vCPU | RAM | Veri diski |
|---|---|---|---|
| ≤ 10 | 2 | 8 GB | 100 GB |
| ≤ 50 | 4 | 16 GB | 500 GB |
| ≤ 200 | 8 | 32 GB | 1–2 TB |
| ≤ 500 | 16 | 64 GB | 2–4 TB |

Disk, kullanıcı sayısıyla değil yüklenen model ve çizim hacmiyle büyür
(yaklaşık: yüklenen dosyalar × 1,6).

## Kurulum

```bash
tar -xzf sitekeep-<sürüm>-linux-amd64.tar.gz
cd sitekeep-<sürüm>-linux-amd64
sha256sum -c SHA256SUMS        # paket bütünlüğü
sudo ./install.sh
```

Sihirbaz sırasıyla sorar: tahmini kullanıcı sayısı, sunucu adresi, HTTPS türü, ilk yöneticinin
e-postası ve şifresi, dil, gece yedeğinin saati. Sonunda adresi ve (üretildiyse) yönetici
şifresini bir kez gösterir.

Sorusuz kurulum: `cp cevap.env.example cevap.env`, düzenleyin, `sudo ./install.sh --answers cevap.env`.

### HTTPS türleri

| Tür | Ne zaman |
|---|---|
| `internal` (varsayılan) | iç ağ. Sertifikayı kurulum üretir; `/opt/sitekeep/config/sitekeep-kok-sertifika.crt` kök sertifikasını istemcilere (GPO ile) dağıtın, tarayıcı uyarısı kalkar. |
| `files` | kurumun kendi sertifikası (PEM; zincir dahil sertifika + özel anahtar). |
| `auto` | herkese açık alan adı ve internet: Let's Encrypt sertifikası otomatik alınır ve yenilenir (80 ve 443 dışarıdan açık olmalı). |
| `off` | yalnız HTTP. Önerilmez. |

## Nerede ne var

| Yol | İçerik |
|---|---|
| `/opt/sitekeep/` | yönetim dosyaları (`compose.yml`, `.env`, `bin/sitekeep`) |
| `/opt/sitekeep/config/app.env` | uygulama ayarları; sırlar içerir, yalnız root okur |
| `/var/lib/sitekeep/pgdata` | veritabanı |
| `/var/lib/sitekeep/app` | yüklenen dosyalar ve model türevleri |
| `/var/lib/sitekeep/backups` | yedekler |

Veri dizini ayrı bir diske konabilir: kurulumdan önce `CDE_DATA=/data/sitekeep` verin.

## Yönetim

```bash
sitekeep status                    # servisler, sağlık, son yedek, disk
sitekeep logs app                  # günlükler
sudo sitekeep backup               # şimdi yedekle
sitekeep backups                   # yedek listesi
sudo sitekeep restore 20270115-023000
sudo sitekeep upgrade /yol/sitekeep-<yeni sürüm>-linux-amd64
sudo sitekeep stop | start | restart
sudo sitekeep uninstall            # veriler kalır; --purge ile silinir
```

**Yedek** her gece kurulumda seçilen saatte alınır: veritabanı (doğrulanmış döküm), dosyalar
(önceki yedeğe göre artımlı) ve ayarlar. Son 14 yedek saklanır. Yedek dizinini düzenli olarak
**sunucu dışına** (NAS, yedek sunucusu) kopyalayın; aynı diskteki yedek disk arızasına karşı korumaz.

**Güncelleme** önce yedek alır, yeni sürümü başlatır; 3 dakikada sağlıklı açılmazsa eski sürüme
ve güncelleme öncesi veritabanına kendiliğinden döner.

## Sorun giderme

| Belirti | Bakın |
|---|---|
| Kurulum "Port 443 kullanımda" diyor | aynı sunucuda başka web sunucusu var; `CDE_HTTPS_PORT=8443` gibi başka port verin |
| Tarayıcı sertifika uyarısı | `internal` türünde kök sertifikayı istemcilere dağıtın |
| Sayfa açılmıyor | `sitekeep status`, `sitekeep logs proxy`, güvenlik duvarında 443 |
| Destek için | `sitekeep status` çıktısı ve `sitekeep logs app` son satırları |
