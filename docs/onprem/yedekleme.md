# Yedekleme (lisanslı ürün)

SiteKeep lisanslı, müşteri sunucusuna **exe / kurulum paketi** ile gidecek. Yedek
o paketin parçasıdır. Müşteriden `docker compose exec` beklenmez. Bulut seçimi
serbesttir; teknik aynıdır.

Ekibe sunulan paket: **otomatik yedek + Yönetim’de izleme**. İzleme ekranı:
[İzleme](izleme.md).

Sırlar bu belgeye yazılmaz.

İlerideki ekran/restic ayrıntısı (arşiv, sözleşme değil):
Yedekleme ve Forma Eşitleme.
Bizim GCP envanteri: Canlı ortam.

---

## Bugün (örnek ekran, 22.10.2026)

Ekibe gösterilen şey **Yönetim → Sistem Durumu** üzerindeki yedek kartı ve
kopya listesi. Zamanlama “her gece 02:00”, “Şimdi Yedekle”, eski kopyayı sil —
hepsi kabuk. `backup` iş türü yok; dump / arşiv / hedef yazılmıyor.

| Duruyor | Ne | Gerçek mi |
|---|---|---|
| Sistem Durumu kartı | son yedek, sonraki gece, kopya sayısı | hayır; `STATUS_DEMO` tarihi |
| Kopyaları Gör | 7 gece, sürüm, boyut, süre; son kopya kilitli | hayır; bellek listesi |
| Şimdi Yedekle | kuyruğa düşmüş gibi | hayır; `jobs`’a satır yok |
| Eski kopyayı Sil | onay modalı | hayır; dosya yok |
| Türevleri Temizle | yedek değil; önizleme / Fragments | hayır; silmez |
| İç compose dump (§4) | bizim Docker için elle `pg_dump` | evet; müşteri yolu değil |

İzleme kabuğu: [İzleme](izleme.md) → Bugün.

---

## Gerçeğe geçmek (yedek)

Ürün sözleşmesi aşağıdaki §1–§3. Motoru bağlamak için:

1. **`jobs` türü `backup`.** Sıra: `pg_dump` (veya PGlite kopyası) → dosya
   arşivi → Kurtarma Paketi (anahtar, lisans). Biri eksikse iş başarısız.
   Türevler (önizleme, Fragments) isteğe bağlı; varsayılan dışarıda.
2. **Zamanlayıcı.** Autodesk / hatırlatma gibi periyodik tur. Cron: her gece
   02:00 (değişir). Vade geldiyse kuyruğa `backup` yaz. Ayrı Dkron kurulumu
   yok; müşteri ekranı yine CDE.
3. **Hedef.** İkinci disk, NAS, SFTP, S3 uyumlu (MinIO/AWS/R2), GCS, Azure.
   GCP zorunlu değil. Sırlar Gizlilik / ayarda; ekranda yok.
4. **Uçlar.** `POST /admin/backup/run` = Şimdi Yedekle. Kopya listesi (tarih,
   uygulama sürümü, boyut, süre, hedef adı). `DELETE` eski kopya; **son kopya
   silinmez.** Saklama (ör. 14 gün yerel, 90 gün dış).
5. **Durum rengi.** Son başarılı yedek 25 saati geçtiyse sarı, 48 saat veya
   son iş hataysa kırmızı. Sistem Durumu kartı bu ucu okur; `STATUS_DEMO`
   üretimde kapalı.
6. **Geri yükle.** Yeni makine: exe + Kurtarma Paketi + yedek. Tek dosya geri
   alma sonra. Yılda bir **deneme restore** kaydı (geri yüklenmeyen yedek,
   yedek değildir).
7. **Yönetim → Yedekleme** (ayrıntı). Hedef ekle, saklama, Kurtarma Paketi
   kimde. Sistem Durumu yalnız özetler.

Danışmanlık aynı kalır: hedef seçimi, 3-2-1, ilk restore’un başka makinede
görülmesi. Veri 7D’ye taşınmaz.

---

## 1. Ne satıyoruz

İki katman. Karışmaz.

| Katman | Kim | Ne |
|---|---|---|
| **Ürün** | lisansın içi | Zamanlanmış yedek (Dkron mantığı), hedef, uyarı, Kurtarma Paketi, geri yükle. Yönetim’den. |
| **Danışmanlık** | 7D ekibi, isteğe bağlı | Hedefi seçmek, 3-2-1, saklama süresi, yılda bir deneme restore, felaket tatbikatı. |

Danışmanlık “veriyi 7D’ye taşıyın” değildir. Lisans on-prem ise yedek **müşteri
tarafında** kalır. 7D, aynı yedek motorunu kendi kurulumunda da kullanır
(doğrulama / referans). Barındırdığımız SaaS ayrı sözleşmedir.

Müşteri yedeği 7D bulutuna almak isterse ayrı iş: KVKK, yurt dışı aktarım, Gizlilik
Merkezi’nde “Yedekleme” bağlantısı. Varsayılan yol bu değildir.

---

## 2. Exe ile giden kurulumda yedek

Kurulum paketi uygulamayı, veritabanını ve dosya dizinini ayağa kaldırır. Yedek
modülü aynı paketle gelir; ayrı script koleksiyonu değildir.

Yedeklenen üç parça (biri eksikse kurulum açılmaz):

| Parça | Ne |
|---|---|
| Veritabanı | projeler, kullanıcılar, kayıtlar, yetkiler |
| Dosya deposu | yüklenen IFC/PDF ve istenirse türevler |
| Kurtarma Paketi | lisans, şifreleme anahtarı, admin kurtarma. Yedek dosyasının yanında, kilitli |

**Sıra:** önce veritabanı, sonra dosyalar. Fazla (yetim) dosya zararsızdır.

Müşteriye gösterilen model **elle dump değil**, Dkron benzeri **zamanlanmış iş**:

- cron ifadesi (her gece 02:00, her Pazar…);
- “Şimdi çalıştır”;
- geçmiş (başladı / bitti / süre / boyut / hata);
- başarısız işte yeniden deneme;
- 2 günden eski veya kırık yedekte uyarı.

Teknik olarak evet: sunucuda otomatik yedek alınır. CDE’de zaten veritabanı kuyruğu
(`jobs`) ve zamanlayıcı var (Autodesk eşitleme, hatırlatmalar). `backup` bir iş
türü olur: önce `pg_dump`, sonra dosya arşivi, sonra hedefe yaz. Süreç ayakta
kaldıkça gece kendiliğinden çalışır; restart’ta kuyrukta kalan iş devam eder.

Ayrı bir Dkron kurulumu şart değil. Aynı davranış ürüne gömülür; exe ile gelir.
İsterseniz kendi barındırmamızda Dkron (veya host cron) da aynı işi tetikleyebilir —
müşteri ekranı yine CDE Yönetim’dir, harici cron paneli değil.

Ürünün yönetmesi gerekenler:

- Hedef: ikinci disk, NAS, SFTP, S3 uyumlu (MinIO/AWS/R2), GCS, Azure. GCP zorunlu değil.
- Zamanlama ve saklama (ör. 14 gün yerel, 90 gün dış).
- İş geçmişi, “Şimdi yedekle”, başarısız / 2 günden eski yedekte uyarı.
- Tek dosya geri alma; tam geri yükleme (yeni makineye exe + Kurtarma Paketi + yedek).
- Yılda en az bir **deneme restore** kaydı. Geri yüklenmeyen yedek, yedek değildir.

Türevler (önizleme, Fragments) isteğe bağlıdır; dışarıda bırakılırsa restore sonrası
yeniden üretim süresi müşteriye söylenir.

3-2-1: 3 kopya, 2 ortam, 1 kopya makinenin ve mümkünse binanın dışında. Aynı diskte
ikinci klasör yedek sayılmaz.

---

## 3. Danışmanlık (ekibe / müşteriye)

Ürün düğmeyi sağlar. Politika ve tatbikat 7D’den istenir:

1. Hedef seçimi (NAS mı, SFTP mi, şirket MinIO’su mı).
2. Saklama ve kimlerin Kurtarma Paketi’ni tutacağı.
3. İlk yedeğin **başka bir makinede** açıldığının birlikte görülmesi.
4. Yıllık tatbikat: yeni sunucu + exe + yedek → bir proje, bir dosya.

Bunu “yedekleme nasıl yapılır” eğitimi gibi değil, kurulumun parçası gibi satın.

---

## 4. İç kurulum (exe yokken)

Ürün motoru gelene kadar kendi compose kurulumumuzda aynı üç parça geçerlidir.
Bu bölüm müşteri teslimatı değildir; geliştirme ve mevcut Docker kurulumudur.

```bash
mkdir -p backups
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T db pg_dump -U cde cde | gzip > "backups/cde-$STAMP.sql.gz"
docker run --rm \
  -v "$(docker volume ls -q | grep cdedata):/data:ro" \
  -v "$PWD/backups:/out" \
  alpine tar czf "/out/cdedata-$STAMP.tgz" -C /data .
```

`.env` / anahtar ayrı ve şifreli. Bir kopya makinenin dışında. Deneme: boş
makinede yalnız `db` ayağa kalkar, dump yüklenir, `cdedata` açılır, sonra `up -d`.
Canlıda `docker compose down -v` yok.

---

## 5. Açılmayan yedek

| Belirti | Sık neden |
|---|---|
| Giriş yok / token çözülmüyor | Kurtarma Paketi (anahtar) yedektekiyle aynı değil |
| Proje var, dosya 404 | yalnız veritabanı alınmış |
| Lisans / exe açılmıyor | yedek, farklı ürüne veya eski major sürüme konmuş |
