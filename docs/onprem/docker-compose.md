# Docker Compose ile kurulum

SiteKeep'i Docker olan herhangi bir sunucuya `docker compose` ile kurmak. İnternetsiz kurumlar ve tek dosyalık
kurulum sihirbazı için: [kurulum paketi](kurulum-paketi.md). İkisi aynı imajı kullanır.

| Ne | Nasıl |
|---|---|
| **SiteKeep Community** | Varsayılan imaj `ghcr.io/sitekeephq/sitekeep`. Lisans gerekmez, kısıtlanmaz (AGPL-3.0). |
| **SiteKeep Enterprise** | `SITEKEEP_IMAGE=ghcr.io/sitekeephq/sitekeep-enterprise`. İmaja erişim lisansla verilir; modülleri Yönetim → Lisans'tan yüklenen lisans açar (lisanslama.md). |

İmajlar her sürümde yayın akışıyla yayımlanır ([kurulum-paketi.md](kurulum-paketi.md) §8, yayın planı B-5).
Depo açılana kadar Community imajı da kapalıdır; o zamana kadar [kaynaktan derleyin](#kaynaktan-derleme).

## Kurulum

Gerekenler: Docker 24+ ve Compose v2; donanım kullanıcı sayısına göre ([kapasite.md](kapasite.md) §4: deneme kademesi 2 çekirdek, 8 GB; 50 kullanıcıya kadar 4 çekirdek, 16 GB).

```bash
git clone https://github.com/sitekeephq/sitekeep.git && cd sitekeep   # ya da yalnız docker-compose.yml + .env.example
cp .env.example .env        # ADMIN_EMAIL, ADMIN_PASSWORD, POSTGRES_PASSWORD'ü değiştirin
docker compose up -d
```

Uygulama `http://sunucu:8080` adresinde açılır (`CDE_PORT`). İlk açılışta `.env`'deki yönetici hesabı oluşur.
Veriler iki birimdedir: `pgdata` (veritabanı) ve `cdedata` (dosyalar ve model türevleri).

### HTTPS

Önüne bir ters vekil koyun (Caddy, nginx, IIS ARR), `.env`'de `SECURE_COOKIES=1` ve `CDE_TRUST_PROXY=1` yapın.
Kurulum paketi Caddy'yi kendisi kurar.

### Ofis servisleri (isteğe bağlı)

Tarayıcıda düzenleme ve ofis → PDF için profiller: `docker compose --profile onlyoffice up -d`
(ya da `collabora`, `gotenberg`); `.env`'deki ilgili blok ([Ofis Entegrasyonu](../features/OFIS_ENTEGRASYONU.md)).

## Enterprise

```bash
# .env
SITEKEEP_IMAGE=ghcr.io/sitekeephq/sitekeep-enterprise
SITEKEEP_VERSION=1.0.0
```

```bash
docker login ghcr.io          # 7Dimensions'ın verdiği okuma erişimiyle
docker compose up -d
```

Lisanssız Enterprise imajı Community gibi çalışır. Yönetim → Lisans'ta kurulum kimliğini alıp lisans isteyin,
gelen `license.json`'u aynı ekrandan yükleyin; modüller yeniden başlatmadan açılır (sayfayı yenileyin;
arka plan işleri bir sonraki yeniden başlatmada başlar).

## Güncelleme

```bash
# .env: SITEKEEP_VERSION=1.1.0
docker compose pull && docker compose up -d
```

Veritabanı göçleri açılışta kendiliğinden çalışır. Güncellemeden önce yedek alın.

## Yedek

```bash
docker compose exec db pg_dump -U cde cde | gzip > yedek-$(date +%F).sql.gz
docker run --rm -v sitekeep_cdedata:/data -v "$PWD":/yedek alpine tar -czf /yedek/dosyalar-$(date +%F).tar.gz -C /data .
```

Birim adı Compose proje adıyla başlar (klasör adı; `docker volume ls`). Veritabanı ve dosyalar birlikte
anlamlıdır. Kurulum paketi gece yedeğini ve geri yüklemeyi kendisi yapar ([yedekleme.md](yedekleme.md)).

## Kaynaktan derleme

```bash
# .env
SITEKEEP_EDITION=community          # ya da enterprise
NODE_AUTH_TOKEN=…                   # read:packages (kapalı paketler: görüntüleyici ve SDK npmjs.com'a çıkana kadar; Enterprise modülleri her zaman)
```

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

`WITH_LIBREDWG=0` DWG önizleme aracının derlenmesini atlar (daha hızlı; DWG önizlemesi olmaz).
Sürüm boş bırakılırsa bütün modüller lisans kontrolü olmadan açılır (yalnız bizim kurulumlarımız).
