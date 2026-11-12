# İzleme (Yönetim ekranı)

Lisanslı SiteKeep, müşteriye **otomatik yedek + Yönetim’de izleme ekranı** olarak
sunulur. Grafana, Prometheus veya sunucu SSH’si müşteriye verilmez. Ekran exe
ile gelir; yönetici tarayıcıdan bakar.

Yedek işinin zamanlaması ve geçmişi: [Yedekleme](yedekleme.md).
Bizim GCP envanteri: Canlı ortam. Sırlar yazılmaz.

`GET /api/v1/health` kamu için sığ kalır. `cde_dev_health` üretimde kapalıdır.

---

## Bugün (örnek ekran, 22.10.2026)

Ekibe göstermek için **Sistem Durumu** örneği duruyor. Grafana / SSH yok; kartlar
ve modal CDE’de. Motor (gerçek yedek işi, örnek saklama, kuyruk listesi) henüz
bağlı değil.

Yol: proje menüsü **Yönetim → Sistem Durumu** (`/projects/:id/sistem-durumu`,
yalnız `isAdmin`) ve **Yönetim (sistem) → Sistem Durumu**.

| Duruyor | Ne | Gerçek mi |
|---|---|---|
| `GET /api/v1/admin/status` | canlılık, disk `statfs`, bellek, `jobs` sayımı, kill switch | evet; üretimde `STATUS_DEMO=0` |
| `STATUS_DEMO=1` (geliştirme) | 16 GB / 500 GB, PostgreSQL 17, gece 02:00 yedek, kuyruk 3/1/47 | hayır; Mac diski gizlensin diye |
| Kartlar | Canlılık, Kaynaklar, İş Kuyruğu, Otomatik Yedek, Bakım, Son Hatalar, Dış Bağlantılar | evet (kabuk) |
| 24 saat çizgisi | işlemci, bellek, disk, bekleyen iş | hayır; sabit örnek seri |
| İşleri Gör | IFC → Fragments, önizleme, çakışma, gece yedeği | hayır; `jobs` tablosuna bağlı değil |
| Kopyaları Gör / Sil / Şimdi Yedekle | yedek listesi, son kopya kilitli | hayır; iş yazılmaz, dosya silinmez |
| Türevleri Temizle | önizleme + Fragments | hayır; onay kutusu var, silmez |
| Son Hatalar | maskeli satırlar | hayır; `error-ring` bağlanmadı |
| Onay modalı | Chrome `localhost says` yok | evet (`ConfirmDialog`) |

Kod: `apps/server/src/admin/status.ts`, `apps/web/src/features/admin/pages/AdminStatus.tsx`,
`apps/web/src/app/navigation.ts`. Geliştirmede `apps/server/.env.development` →
`STATUS_DEMO=1`.

---

## Gerçeğe geçmek (izleme)

Ürün sözleşmesi aşağıdaki §1–§6. Örnek kabuğu gerçek veriye bağlamak için:

1. **Üretimde `STATUS_DEMO=0`.** Disk, bellek, kuyruk sayımı o makinenin.
   Geliştirmede örnek overlay kalabilir.
2. **Örnek tablosu.** CPU / bellek / disk / kuyruk boyu, son N gün, küçük satırlar.
   24 saat (ve sonra 7 gün) çizgisi buradan. Proje dosyası değil.
3. **`GET /admin/status/jobs`.** `jobs` tablosu: tür (IFC → Fragments, önizleme,
   çakışma, yedek), hedef adı, durum, süre. Modal bu ucu okur. Başarısız işe
   yeniden kuyruk.
4. **Son hatalar.** Mevcut `error-ring` (sırlar maskeli). Ham pino / syslog yok.
5. **Lisans ve veritabanı.** Bitiş tarihi, `pgdata` boyutu, son migration.
6. **Dış bağlantı özeti.** Kill switch (var), son 24 saatte giden çağrı, Autodesk
   zamanlayıcı, ofis dönüştürücü ayakta mı.
7. **Uyarı.** Eşik (disk %80 / yedek 25 saat…) üst rengi boyar. İsteğe bağlı
   yönetici e-postası — danışmanlıkta kime.
8. **Bakım.** Türevleri gerçekten sil (önizleme, Fragments). Yüklenen dosya,
   veritabanı, Kurtarma Paketi dokunulmaz.

Yedek işinin kendisi: [Yedekleme](yedekleme.md) → Gerçeğe geçmek.

---

## 1. Ne satıyoruz

| Katman | Kim | Ne |
|---|---|---|
| **Ürün** | lisansın içi | Yönetim → **Sistem Durumu**: canlılik, kaynak, kuyruk, yedek işleri, dış bağlantılar, uyarılar. |
| **Danışmanlık** | 7D, isteğe bağlı | Eşik, kime mail, ilk kurulumda “yeşil ekran”, yıllık gözden geçirme. |

İzleme verisi on-prem’de kalır. 7D’ye metrik gitmez. Barındırdığımız SaaS’ta
aynı ekran durur; arka planda Prometheus isteğe bağlıdır, müşteri onu görmez.

---

## 2. Kim görür

Yalnız **kurulum yöneticisi** (`isAdmin`). Proje üyesi, yüklenici, “Yönetim”
girmeyen kimse bu sekmeyi görmez.

Gizli tutulur: dosya içeriği, yazışma, IFC, kişisel ad/e-posta listesi, API
anahtarı, `CDE_SECRET_KEY`. Son hatalarda sırlar zaten maskelenir; ekranda da
öyledir.

Yol: **Yönetim → Sistem Durumu** (yeni sekme; Kullanıcılar, Yapay Zekâ, Office,
OAuth, Gizlilik yanında). `?tab=status`.

---

## 3. Ekranın düzeni

Üstte tek satır **durum**: Yeşil / Sarı / Kırmızı + “son kontrol: … önce”.

| Renk | Ne zaman |
|---|---|
| Yeşil | Uygulama ve veritabanı ayakta, son yedek zamanında, kuyruk eriyor, disk eşiğin altında |
| Sarı | Yedek gecikmiş, kuyruk birikiyor, disk %80, dış bağlantı kapalı (kill switch), dönüştürücü yok |
| Kırmızı | Veritabanı yok, yedek 2 günden eski veya son iş hata, disk %95, süreç yeni düştü |

Altında kartlar. Tıklanınca o kartın geçmişi / iş listesi açılır.

### 3.1 Canlılık

- Uygulama süreci: ayakta, uptime, sürüm, lisans bitişi.
- Veritabanı: bağlandı / bağlanamadı, Postgres 17, son migration (uygulanan / beklenen).
- HTTP: son dahili `/api/v1/health` (yük dengeleyici ve exe servis denetimi de bunu kullanır).

### 3.2 Kaynaklar (sunucu)

Kurulumun olduğu makine. Exe bunları okur; ayrı ajan şart değil.

| Ölçü | Ne için |
|---|---|
| CPU % | IFC dönüşümü ve kesit kasması buradan anlaşılır |
| Bellek (kullanılan / toplam) | 4 GB makinede kırmızı eşiği düşük tutulur |
| Disk (CDE data + yedek hedefi ayrı) | Dolunca yükleme ve yedek kırılır |
| Veritabanı boyutu | `pgdata` şişmesi |

Grafik: son 24 saat ve son 7 gün. Sayılar makine; proje içeriği değil.

### 3.3 İş kuyruğu

CDE’deki `jobs` tablosu (IFC → Fragments, önizleme, clash, yedek…).

- Bekleyen / çalışan / başarısız / son 24 saatte biten.
- Tür kırılımı (`ifc_to_frag`, `backup`, `preview`…).
- En uzun bekleyen iş, en son hata (mesaj maskeli).
- “Kuyruk eriyor mu”: bekleyen sayı son saatte artıyor mu azalıyor mu.

Tek iş satırına tıklayınca: tür, kuyruğa giriş, süre, sonuç. Dkron geçmişinin
CDE’deki karşılığı budur.

### 3.4 Otomatik yedek (aynı ekran)

[Yedekleme](yedekleme.md) işi burada görünür; ikinci bir panele gitmez.

- Son başarılı yedek: tarih, süre, boyut, hedef (NAS / SFTP / S3…, sır yok).
- Sonraki planlanan (cron: her gece 02:00).
- Son 14 iş: durum, yeniden deneme.
- “Şimdi yedekle” (kuyruğa `backup` işi).
- 2 günden eski veya son iş kırmızıysa üst durum kırmızı olur.
- Kopya listesi: tarih, uygulama sürümü, boyut, süre. Son kopya silinmez;
  eski kopyayı yalnız sistem yöneticisi siler (saklama politikası).

Ayrıntı (hedef ekleme, saklama, Kurtarma Paketi) **Yönetim → Yedekleme**
alt sayfasında; Sistem Durumu özetler.

### 3.5 Bakım (sunucuyu silmek değil)

Yeniden üretilebilir olanı silmek: önizleme, Fragments, eski bitmiş iş satırları,
saklama süresi dolmuş yedek. **Yüklenen dosya, veritabanı ve Kurtarma Paketi
buradan silinmez.** “Sunucuyu temizle” diye bir düğme yok.

### 3.6 Son hatalar

`error-ring` (sırlar maskeli). Ham syslog / pino dökümü değil. Kart tıklanınca
son satırlar. Proje dosyası ve yazışma açılmaz.

### 3.7 Dış bağlantılar ve ofis

Gizlilik Merkezi’nin özeti: kill switch açık mı, son 24 saatte engellenen /
izinli giden çağrı sayısı, Autodesk zamanlayıcı durdu mu, ofis dönüştürücü
(ONLYOFFICE / Collabora / Gotenberg) ayakta mı. İçerik yok; sayım ve durum var.

### 3.8 Uyarılar

| Uyarı | Sarı | Kırmızı |
|---|---|---|
| Yedek yok / eski | 25 saati geçti | 48 saati geçti veya son iş hata |
| Disk | %80 | %95 |
| Bellek | %85 (süreklilik) | süreç OOM / yeniden kalkış |
| Kuyruk | 15 dk’dır büyüyor | 2 saattir erimiyor, başarısız yığılıyor |
| Veritabanı | yavaş yanıt | bağlanılamıyor |
| Lisans | 30 gün kala | süresi doldu |

Uyarı: ekranda kart + yönetici e-postası (isteğe bağlı). Danışmanlıkta kime
gideceği kurulur.

---

## 4. Teknik (nasıl yapılır)

Ayrı Prometheus müşteriye zorunlu değil.

1. **Sağlık ucu** — mevcut `/api/v1/health` derinleşir (db ping, disk, son yedek)
   ama kamu yanıtı sığ kalır (`ok` / `degraded`). Ayrıntı yalnız admin API.
2. **Zamanlayıcı** — Autodesk / hatırlatma gibi periyodik tur: kaynak örneği al,
   yedek vadesi geldiyse `jobs`’a `backup` yaz.
3. **Saklama** — son N gün örnek (CPU, bellek, disk, kuyruk boyu) küçük bir
   tabloda. Proje dosyası değil.
4. **Admin API** — `GET /admin/status` kartlar; `GET /admin/status/jobs`;
   `POST /admin/backup/run`.
5. **Exe servisi** — Windows/Linux hizmeti düşerse ekran açılmaz; host
   denetimi (servis yeniden başlat) kurulumun parçasıdır.

İsteğe bağlı (bizim SaaS veya büyük müşteri): aynı sayıları Prometheus
`/metrics` olarak da dökmek. Ekran yine CDE’dir.

`cde_dev_health` üretimde kapalı kalır. Yönetici ekranı onun maskelenmiş,
müşteriye uygun halidir: tablo satır sayıları ve test projeleri yok.

---

## 5. Danışmanlık

1. Eşikler (4 GB VM ≠ 32 GB sunucu).
2. Uyarı maili / sohbet.
3. İlk gün: yeşil ekran + ilk gece yedeğinin ertesi gün kartta görünmesi.
4. Yılda bir: kırmızı senaryo tatbikatı (diski doldurmadan yedek hedefini
   kapatıp uyarının düştüğünü göstermek).

---

## 6. Bilinçli sınır

- Bu ekran APM değildir (kullanıcı tıklama haritası yok).
- k6 / stres testi ayrıdır; canlıya k6 yok. Müşteri sunucusundaki korumalı
  kapasite testi ve kullanıcı sayısı uyarıları: [Kapasite](kapasite.md).
- Şantiye tabletinde Yönetim açılmaz; izleme masaüstü yöneticisinindir.
