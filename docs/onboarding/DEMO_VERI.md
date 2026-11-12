# Demo projeler: gerçek yapı + üretilmiş veri

Tarih: 10.10.2026 · Kapsam: yerel geliştirme sunucusu (`http://127.0.0.1:8787`) · Betik: `apps/server/scripts/import-demo.mjs`

Raporlama panolarını gerçekçi ölçekte veriyle denemek için üç demo proje kuruldu. **Yapı** kullanıcının
Forma projelerinden okundu, **kayıtların tamamı üretildi**. Hiçbir müşteri kaydı (dosya, yazı, review,
transmittal, issue, form) kopyalanmadı.

| Kod | Kaynak (Forma) | Klasör (Forma → demo) | Dosya (Forma → demo) | Ölçek |
|---|---|---|---|---|
| `PKF-DEMO` | PKF IBB-Raylı Sistem Daire Başkanlığı (M10) | 2.278 → 2.278 | 12.409 → 4.003 | 0,322 |
| `MBE-DEMO` | MBE METRO PROJESİ (M7) | 5.793 → 3.887 | 36.732 → 4.001 | 0,109 |
| `DNM-DEMO` | Dikimevi–Natoyolu Metro (A1 Ankaray uzatma) | 1.410 → 1.410 | 1.887 → 1.887 | 1,000 |
| `RLW-DEMO` | Railway_ISO19650 | kurulmadı | — | — |

Railway_ISO19650 projesinde 1.776 klasör var ama **dosya, naming standardı, review, issue yok** (boş şablon).
"İçeriği varsa" koşulu sağlanmadığı için demo kurulmadı.

## 1. Forma'dan ne alındı (yalnız yapı ve toplu sayılar)

Forma MCP ile **salt okuma** yapıldı; hiçbir oluşturma/güncelleme/silme/taşıma/yetki aracı çağrılmadı.

| Alındı | Ayrıntı |
|---|---|
| Klasör yolları ve klasör başına dosya **sayısı** | Yalnız klasör adları; dosya adı yok |
| Naming standardı tanımları | Alanlar, ayraç, değer listeleri (kod + açıklama), Number hane aralığı, metadata alanları |
| Öznitelik tanımları | Ad, tür, liste seçenekleri, bağlı oldukları klasörler |
| Review şablonu **yapısı** | Adım adları, süreler (gün), kural (hepsi/biri), atanan **firma/rol**, sonuç etiketleri, kopya hedefi; kişi adı yok |
| Firmalar ve rolleri | İdare / yüklenici / tasarımcı / danışman / alt yüklenici |
| Toplu sayılar | Review sayısı (durum ve aya göre), şablon başına review sayısı, kapalı review sonuç dağılımı (örneklem), transmittal toplamı, issue durum/tip/gecikme dağılımı, proje tarihleri |

**Alınmayanlar:** dosya adları, dosya öznitelik değerleri, tek tek review/transmittal/issue/form kayıtları,
yazı numaraları ve konuları, kişi adları ve e-postaları, dosya içerikleri. Kayıt döndüren araç çağrılarının
sonuçları yalnız bellekte sayıma çevrildi, hiçbir yere yazılmadı.

Kayıt adı taşıyan klasörler de alınmadı, yerine sayı konuldu ve demo'da **üretilmiş adlarla** açıldı:

- MBE `99-Tasarımcı Ortak Alan/999-Yazışmalar`: 862 alt klasör (her biri bir yazı numarası) → `Yazı DEMO-yyyy-nnnn`
- MBE `03-Hakediş Çalışmaları/02-Hakediş Dökümanları`: 36 alt klasör (IPC no + tarih) → `Hakediş Ekleri DEMO-nnnn`
- MBE `14-İMALATLAR_FOTO_2023` (6 tarih adlı klasör) ve küçük tarih/konu adlı çalışma klasörleri → sayıya çevrildi
- MBE `ZZ-Yüklenici Taslak Alan` içindeki **başka projelere ait** 63 klasör → `Diğer Proje Taslakları (anonim)/Diğer Proje Taslağı nnnn`

MBE ağacında ayrıca bazı derin, tekrar eden alt klasörler (hakediş dönemi altındaki şaft klasörleri, istasyon
sistem alt klasörleri, ihale projesi alt kırılımları) bir üst klasöre katlandı; **dosya sayıları korundu**
(5.793 → 3.887 klasör).

### Snapshot dosyaları

Yapı `data-import/<KOD>.json` dosyalarında durur (git dışında, `.gitignore`):

```
data-import/
  PKF-DEMO.json  MBE-DEMO.json  DNM-DEMO.json     yapı + toplu sayılar (kayıt yok)
  *.result.json                                    son içe aktarımın sonuçları
  builders/                                        snapshot'ları üreten betikler ve ağaç metinleri
```

Snapshot içeriği: proje adı/kodu/tarihleri, firmalar ve rolleri, proje rolleri (ekipler), girintili klasör
ağacı (`Ad [dosya sayısı]`), ISO 19650 durum kuralları, taraf alanları (WIP), yükleyen firma kuralları,
firma bazlı yetki matrisi, naming standardı (+ alan → rol eşlemesi), öznitelik tanımları, review şablonları
(gerçek review sayısı ağırlık olarak), istatistikler (`stats`).

## 2. Ne üretildi

| Öğe | Nasıl |
|---|---|
| Firmalar | Gerçek firma adları (aynı ad varsa mevcut firma kullanılır; ör. İBB PKF ve MBE'de ortak) |
| Kullanıcılar | Firma başına bir demo kullanıcı (`idare@pkf.demo.localhost`, `tasarim@mbe.demo.localhost` …) ve review şablonlarının kullandığı her proje rolü için bir kullanıcı (`y-yapisal@pkf.demo.localhost` …). Ad: "PKF Yüklenici (demo)". Şifre: geliştirme ortamının `ADMIN_PASSWORD` değeri. Yüklenici kullanıcısı proje yöneticisi |
| Proje rolleri | Sunucuda rol desteği varsa (main dalı: var) rol/ekip olarak oluşturulur, rol kullanıcısı üye yapılır; review adımları role atanır |
| Klasörler | Snapshot ağacının tamamı; durum klasörleri `shared` / `published`, taraf alanları (96–99, ZZ) `wip` |
| Yetkiler | Firma bazlı: taraf WIP alanı yalnız o tarafa (düzenle/yönet); paylaşım ve yayın alanları herkese görüntüle+indir, idare/danışman +işaretle, teslim eden taraf düzenle |
| Naming | Standart oluşturulur, gerçek projedeki klasörlere bağlanır (aşağıdaki nota bakın) |
| Öznitelikler | Snapshot'taki tanımlar + her naming alanı için liste özniteliği + `Belge tarihi` (tarih, köke bağlı) |
| Review şablonları | Gerçek adım yapısı, süreler ve firma/rol atananlarıyla |
| Dosyalar | Klasör başına gerçek sayı × ölçek (rastgele yuvarlama). Naming klasörlerinde adlar standarttan üretilir (ALAN klasör yolundan, SİSTEM disiplinden, DOKÜMAN TİPİ "Modeller/Çizimler/Raporlar"dan, sıra numarası önek başına artan). Diğer klasörlerde açıklayıcı demo adları ("Giden Yazı DEMO-2024-0457.pdf"). İçerik: `SiteKeep demo verisi — üretilmiş` |
| Versiyonlar | %55 v1, %25 v2, %11 v3, %5 v4, %2,5 v5, %1,5 v6 |
| Öznitelik değerleri | Naming alanları addan; `Revizyon` P01, P02 … (yayın alanında C01 …; DNM'de 00, 01 …); `Belge tarihi` gerçek review'ların aylık dağılımına göre proje süresine yayılır, sonraki versiyonlar 7–60 gün sonra; yazışma künyesi (Sayı, İlgi, Gereği …) üretilmiş |
| Yükleyen | Klasörün sahibi/teslim eden tarafın demo kullanıcısı |
| Review'lar | Şablonlar gerçek kullanım sayılarıyla ağırlıklı seçilir; aynı klasörden 1–8 dosya; durum dağılımı gerçek (açık/kapalı/iptal) oranlarda; kapalılar atanan demo kullanıcılarıyla tüm adımlardan geçirilir, sonuç dağılımı gerçek örneklemden |
| Issue'lar | 100 (DNM 50); durum, tip, gecikme ve atanan firma dağılımı gerçek toplamlardan; gecikmişlerin termini geçmişte |

Review ve issue adları `DEMO-001 …` ile başlar, açıklamaları "SiteKeep demo verisi — üretilmiş" dir.

## 3. Proje bazında sonuçlar (10.10.2026 içe aktarımı)

| | PKF-DEMO | MBE-DEMO | DNM-DEMO |
|---|---|---|---|
| Firma / kullanıcı | 6 / 11 | 5 / 18 | 4 / 4 |
| Proje rolü (ekip) | 5 | 13 | 0 |
| Klasör | 2.278 | 3.887 | 1.410 |
| Dosya / versiyon | 4.003 / 7.222 | 4.001 / 7.137 | 1.887 / 3.324 |
| Öznitelik tanımı | 22 | 23 | 15 |
| Firma yetkisi (grant) | 30 | 26 | 19 |
| Review şablonu | 8 | 18 | 2 (varsayılan) |
| Review: tamamlandı | 82 | 97 | 40 |
| Review: devam ediyor | 67 | 43 | 36 |
| Review: iptal | 1 | 10 | 4 |
| Dosya sonucu (onay / notlu onay / red) | 264 / 49 / 9 | 164 / 14 / 70 | 73 / 45 / 63 |
| Issue: açık / devam / incelemede / kapalı | 64 / 0 / 27 / 9 | 70 / 0 / 7 / 23 | 24 / 15 / 2 / 9 |
| Issue: gecikmiş | 69 | 3 | 10 |
| Süre | 8 dk 14 sn | 13 dk 30 sn (devam çalıştırması) | 2 dk 45 sn |

Gerçek (Forma) karşılıkları: PKF 733 review (330 açık, 399 kapalı, 4 iptal), 17 issue (13 gecikmiş);
MBE 2.049 review (594 açık, 1.318 kapalı, 137 iptal), 249 issue (10 gecikmiş). Dikimevi'de review, issue
ve akış şablonu yok; DNM-DEMO'daki iki şablon (Tasarımcı → Yüklenici 7 gün; Yüklenici → Danışman 15 gün →
İdare 30 gün) ve dağılımlar **varsayımdır**.

## 4. Bilinen sınırlar

- **Naming:** Geliştirme sunucusu main dalının kodunu çalıştırıyor; bu daldaki naming iyileştirmeleri
  (ayraç içeren kodlar, değişken haneli Number, ada girmeyen alanlar) orada henüz yok. Betik bunu otomatik
  algılar ve **uyumlu bir alt küme** bağlar: `SKP1-A` gibi ALAN kodları çıkarılır, Number 3 hane sabit,
  Revizyon ve Pafta adı adın parçası değil, yalnız öznitelik. Üretilen adlar bu alt kümeye uyar.
  Dal birleştikten sonra betik tam tanımı bağlar (yeni kurulumda).
- **Gecikmiş review:** API review başlangıcını "şimdi" olarak kaydeder; geçmiş tarihli adım oluşturulamaz.
  Bu yüzden şu an gecikmiş review yok. Açık review'ların adım terminleri 2–30 gün içinde dolar
  (PKF'de 3, MBE'de 23, DNM'de 22 review 7 gün içinde gecikmiş olur). Zaman bazlı raporlar için dosyalarda
  `Belge tarihi` özniteliği kullanılabilir. Issue'larda termin serbest olduğu için gecikme dağılımı gerçektir.
- **Kopya hedefi, sonuç etiketleri, akışa bağlı öznitelikler:** Snapshot'ta durur (`copyTarget`,
  `outcomeLabels`), ama şablona yazılmaz; onaylanan dosyalar kopyalanmaz (dosya sayıları ölçekli kalsın diye).
- **Naming bağlama yeri:** PKF'de Forma standardı durum klasörlerinin alt seviyelerine bağlı; demo'da her
  durum kökünün bölge grubu klasörlerine (000-Genel, 001-Güzergah …) bağlandı. 7D'de bağlama alt klasörlere
  miras kaldığı için Forma'da standartsız kalan birkaç alt klasör (ör. DNM 02_HAT yaprakları) demo'da standartlı.
- **Yetkiler:** Forma'daki kişi bazlı yetkiler firma bazına indirildi; "görüntüle+indir+işaretle+yükle" gibi
  7D'de karşılığı olmayan birleşimler en yakın seviyeye (çoğunlukla düzenle veya görüntüle+indir+işaretle) çevrildi.
- **Öncelik:** Forma issue'larında öncelik alanı yok; PKF/MBE demo issue'ları "normal".

## 5. Yeniden çalıştırma

```bash
# geliştirme sunucusu 8787'de çalışırken, worktree kökünden:
node --env-file=C:/Users/hasan/7d-cde/apps/server/.env.development apps/server/scripts/import-demo.mjs

# seçenekler
--only PKF-DEMO        yalnız bir proje (tekrarlanabilir)
--cap 4000             proje başına en çok dosya (gerçek sayılar orantılı küçültülür)
--reviews 150          proje başına en çok review
--issues 100           proje başına issue
--concurrency 4        eşzamanlı istek
--suffix -2            kodlara ek (ikinci kopya: PKF-DEMO-2)
--resume               yarım kalan içe aktarımı tamamla (her şey adıyla bulunur, eksikler eklenir)
--dry-run              sunucuya gitmeden planı yazdır
```

Kodu var olan proje atlanır. Sunucu yeniden başlarsa (tsx watch) istekler `/health` dönene kadar bekler ve
tekrarlanır; süreç yine de durursa `--resume` ile devam edilir. Üretim deterministiktir (proje koduna bağlı
tohum), aynı snapshot aynı adları üretir.

Snapshot'ları yeniden üretmek için `data-import/builders/` altındaki betikler kullanılır
(`node build-pkf.mjs ../`). Forma'dan yeniden okumak gerekirse yalnız klasör ağacı (`forma_folder_tree`),
naming standardı, öznitelik tanımları, review şablonları ve toplu sayılar okunmalı; kayıt içerikleri
snapshot'a yazılmamalıdır.
