# Sadeleştirme planı

Tarih: 11.10.2026. Kullanıcı kararı: önce 1. aşama, sonra 2. ve 3. aşama.

## Sorun

- Altyapı sağlam: tek İş modeli, tek onay motoru, yetkiler, yapay zekâ araçları.
- Karmaşa ekranda. Forma'nın modül listesini menüye birebir taşıdık: sol menüde 17 kalem var.
- Kullanıcı önce "bu iş hangi modülde?" diye düşünmek zorunda kalıyor.
- Sorun, İnceleme ve Form da birinin bir şey yapmasını bekleyen kayıtlar. Yani hepsi "İş", ama ayrı modül gibi duruyorlar.
- İşler sayfasında dört sıra filtre var.

## İlke

- Hiçbir özellik silinmez. Her şey yalnız ihtiyaç olduğu yerde görünür.
- Kullanıcı modül aramaz. Ne yapmak istediğini yazar, sistem doğru yere götürür.
- Varsayılan en sade kurulumdur. Gelişmiş ayar gizlidir.

## Yeni menü (5 kalem)

| Menü | İçinde |
|---|---|
| Bugün | Bana düşenler, değişenler, riskler |
| İşler | Yazışma, Bilgi Talebi, Teknik Onay, Toplantı ve Eylem, Gönderim Formu, Sorun, İnceleme, Form; kayıtlı görünümler |
| Dokümanlar | Dosyalar; onay durumu, karşılaştırma, düzenleme, şartname analizi dosyanın ve klasörün içinde |
| Model | Görüntüleyici; Koordinasyon (çakışma, model setleri) ve İş Programı (Gantt, 4D) sekme olarak |
| Raporlar | Paneller; "Sor" cevabını panele sabitleme |

Menünün en üstünde "Sor…" kutusu, en altında Proje Ayarları durur. Konumlar, numara desenleri ve iş akışı tasarımı Proje Ayarları'na taşınır.

## Aşamalar

### 1. Aşama — görünen karmaşayı azalt

- 5 kalemlik menü. Eski adresler yeni yerlerine yönlenir.
- Projeye özel Bugün sayfası (proje ana sayfası).
- İşler tek merkez:
  - Yazışmalar, Bilgi Talepleri, Teknik Onaylar, Toplantılar, Gönderim Formları, Sorunlar, İncelemeler ve Formlar sayfanın içinde görünüm olarak durur.
  - Kullanıcı kendi filtrelerini "görünüm" olarak kaydedebilir.
- Proje başına modül anahtarları:
  - Kapalı modül menüde, görünümlerde ve "+ Yeni"de görünmez.
  - Kapalı modülün verisi silinmez.
- Tek "+ Yeni" düğmesi:
  - "Ne yapmak istiyorsunuz?" kutusu ve açık modüllerin kayıt tipleri.
  - Yazılan cümleden tip ve başlık önerilir. Bu adım yapay zekâsız, anahtar kelimeyle çalışır.
- Gelişmiş ayarlar (numara desenleri, öznitelikler, iş akışı tasarımı) "Gelişmiş" düğmesinin arkasında.

### 2. Aşama — yapay zekâ işi yapsın

- Bugün sayfasında yapay zekâ özeti: bana düşenler, son değişiklikler, riskler.
- PDF ya da e-posta bırakınca kayıt: yapay zekâ sayıyı, tarihi, konuyu, göndereni ve ilgi yazısını okur, kullanıcı onaylar.
- "+ Yeni" kutusunda yapay zekâ taslağı. Örnek: "Prota'ya B3 kazısı için bilgi talebi aç, son revizyonu ekle."
- Her listede doğal dille arama. Örnek: "termini geçen Prota yazıları".
- Toplantı notundan ya da ses kaydından eylem çıkarma.

### 3. Aşama — rol bazlı sade ekran

- Saha (telefon): Bugün, Form, Sorun, Fotoğraf; çevrimdışı.
- Doküman kontrol: Dokümanlar ve İşler.
- Proje müdürü: Bugün ve Raporlar.
- Rol paketleri hangi ekranın açılacağını belirler.

## Başarı ölçüsü

Üç kullanıcı tipi için en sık 5 işin tıklama sayısı, önce ve sonra ölçülür:

- Saha mühendisi: form doldur, sorun aç, fotoğraf ekle, bana düşenlere bak, eylemi kapat.
- Doküman kontrol: dosya yükle, incelemeye gönder, gelen yazıyı kaydet, cevap yaz, gönderim formu oluştur.
- Proje müdürü: bugünkü durumu gör, geciken işleri gör, rapor aç, onay ver, toplantı tutanağına bak.

## Not

2. aşama yapay zekâya dayanır. Bu bilgisayarda yerel model cevapları dakikalar sürüyor. 2. aşamadan önce ekran kartlı makine kararı verilmelidir. 1. aşama yapay zekâ beklemeden sadeleştirir.

## 1. Aşama sonuçları

Tarih: 11.10.2026 · Dal: `feat/sade-1` · Göç: `0022_saved_views` (kayıtlı görünümler tablosu, `projects.settings`, `users.prefs`).

**Durum (22.10.2026):** 5 kalem menü `apps/web/src/app/navigation/nav.ts` (`NAV_ITEMS`) ve route testlerinde tanımlı.
`ProjectShell` hâlâ gruplu `PROJECT_NAV` (`apps/web/src/app/navigation.ts`) çiziyor. Route yönlendirmeleri ve İşler
merkezi çalışır; sol menü tam geçmemiştir.

### Ne değişti

- **Menü 5 kalem:** Bugün, İşler, Dokümanlar, Model, Raporlar. Üstte "Sor…", altta Proje Ayarları. Grup başlıkları kalktı; menü yine ikon şeridine daralır, telefonda çekmece olarak açılır. Dokümanlar son açılan klasöre, İşler son görünüme gider.
- **Bugün (proje ana sayfası):** Bana Düşenler (onayımı bekleyen adımlar, bana atanan işler, eylemlerim, cevap beklenen yazılar, alındı onayı bekleyenler, doldurulacak formlar, bana atanan sorunlar), Gecikenler, Yaklaşan Terminler (7 gün, toplantı günleri dahil) ve Son Değişiklikler (7 gün, gün ve kişi bazında gruplu, yalnız görülebilen kayıtlar). Her satır kayda gider. Yapay zekâ yok; 2. aşamanın özeti için sayfanın üstünde yer ayrıldı (`aiSummary`). Bütün projeleri gösteren genel Bugün (`/today`) duruyor.
- **İşler tek merkez:** görünüm listesi (masaüstünde dikey, telefonda seçim kutusu): Bana Düşenler, Tüm İşler, Yazışmalar, Bilgi Talepleri, Teknik Onaylar, Toplantılar, Gönderim Formları, Sorunlar, İncelemeler, Formlar ve kullanıcının kayıtlı görünümleri. Sorunlar, İncelemeler ve Formlar kendi sayfalarıyla merkezin içinde açılır; veritabanı tabloları birleşmedi. Dört filtre sırası tek satır oldu: arama, "Filtreler" penceresi (tip, durum, termin, hızlı filtre, gruplama, yalnız açık işler) ve kaldırılabilir filtre çipleri. Filtreler adres çubuğunda durur.
- **Kayıtlı görünümler:** "Görünümü Kaydet" görünümü, filtreleri, gruplamayı ve aramayı adıyla saklar (kullanıcı ve proje başına, sunucuda). Proje yöneticisi görünümü projeyle paylaşabilir. "Görünümleri Düzenle" ile ad değiştirme, sıralama, paylaşma ve silme.
- **Tek "+ Yeni":** İşler'in ve Bugün'ün üstünde. "Ne Yapmak İstiyorsunuz?" kutusu ve açık modüllerin kayıt tipleri. Yazılan cümleden tip, başlık, firma (gönderen ya da alıcı) ve form şablonu anahtar kelimeyle seçilir; kurallar `packages/shared/src/intent.ts`, testleri `packages/shared/test/intent.test.ts`. 2. aşamanın yapay zekâ taslağı için kanca: `apps/web/src/features/works/new-record.ts` → `draftFromSentence`.
- **Modüller:** Proje Ayarları → Modüller (proje yöneticisi). Kapalı modül menüde, İşler görünümlerinde, "+ Yeni"de, Model sekmelerinde, Sor asistanının araçlarında, rapor şablonlarında ve veri kümelerinde görünmez. Verisi silinmez; mevcut kayıtlar açılır, yeni kayıt Türkçe bir iletiyle reddedilir (`403 module_disabled`). Şablon varsayılanları: ISO 19650 Temel'de Doküman, İnceleme, Sorun, Yazışma ve Raporlar açık, gerisi kapalı; Metro İBB ve Veri Merkezi'nde hepsi açık. Mevcut projelerde hepsi açık.
- **Model:** Görüntüleyici, Koordinasyon (model setleri, çakışma, IDS) ve İş Programı (Gantt, 4D) sekmeleri; sayfalar aynı.
- **Dokümanlar:** araç çubuğunda "Şartnameden Teknik Onay Listesi"; aynı düğme Teknik Onaylar görünümünde de var. İncelemeler dosya panelinden ve İşler'den açılıyor.
- **Proje Ayarları:** sekmeler Üyeler, Roller, Modüller, Konumlar, Şablon, Yapay Zekâ. İsimlendirme standartları, iş akışları (inceleme zinciri tasarımı), iş tipleri (numara desenleri), öznitelikler, çöp kutusu, aktivite kaydı ve firmaya rol paketi (ayrıntılı yetkiler) "Gelişmiş Ayarları Göster" ile görünür; seçim kullanıcı başına sunucuda saklanır. Proje yöneticisi olmayan üye yalnız Konumlar'ı görür.

### Eski adresler

Bütün eski adresler çalışır. Bildirim, e-posta ve MCP bağlantıları (`/works/:id`, `/reviews/:id`, `/forms/:id`, `/issues/:id`, `/files/…?file=…`, `/viewer?v=…`, `/reports/:id`) değişmedi. Tablo ve testleri: `apps/web/src/app/navigation/routes-table.ts`, `apps/web/test/app/routes.test.ts`.

| Eski adres | Şimdi |
|---|---|
| `/p/:pid` | Bugün (önce Dokümanlar'a yönleniyordu) |
| `/works`, `/works?bolum=…`, `/works/:id` | İşler → ilgili görünüm (Bana Düşenler: `?bolum=bana`) |
| `/issues`, `/issues/:id` | İşler → Sorunlar (sayfa merkezin içinde) |
| `/reviews`, `/reviews/:id` | İşler → İncelemeler |
| `/forms`, `/forms/:id` | İşler → Formlar; PDF form şablonu düzenleyicisi tam ekran kaldı |
| `/viewer`, `/coordination/*`, `/schedule` | Model → Görüntüleyici / Koordinasyon / İş Programı sekmeleri |
| `/coordination` | `/coordination/sets`'e yönlenir |
| `/spec`, `/spec/:id` | Dokümanlar içinde (menüde Dokümanlar seçili) |
| `/locations` | `/settings?sekme=konumlar`'a yönlenir |
| `/works?bolum=bilinmeyen` | `/works`'e yönlenir |

### Tıklama sayıları

Ölçüm: 11.10.2026, yerel sunucuda ZAVM demo projesi (`seed-demo.mjs` ve üretilmiş kayıtlar), kullanıcı Elif Aydın (yüklenici, proje yöneticisi), masaüstü 1280 piksel. "Önce" `mvp-v1` (225200e), "sonra" `feat/sade-1`; ikisi de tarayıcıda gezilerek sayıldı.

Kurallar: başlangıç projeye girilen ilk ekrandır (önce Dokümanlar, sonra Bugün). Her tıklama ve Enter 1 sayılır; açılır listeden seçim 2 (aç, seç); dosya penceresinde seçim 1. Yazı yazmak ve form alanlarını doldurmak sayılmaz.

| Kullanıcı | İş | Önce | Sonra | Sonra nasıl |
|---|---|---|---|---|
| Saha mühendisi | Form doldur | 6 | 4 | + Yeni → "beton döküm formu" yaz, Enter (şablon seçili gelir) → Oluştur → Gönder. Yazmadan: 6 |
| Saha mühendisi | Sorun aç | 5 (açık bir IFC modeli gerekir) | 3 | + Yeni → "B3 perdede çatlak sorunu" yaz, Enter → Kaydet. Model gerekmez |
| Saha mühendisi | Fotoğraf ekle (açık forma) | 4 | 3 | Bugün → Doldurulacak Formlar'daki form → Fotoğraf Ekle → dosya |
| Saha mühendisi | Bana düşenlere bak | 1 (genel Bugün; sorun ve formlar yoktu) | 0 | Proje ana sayfası |
| Saha mühendisi | Eylemi kapat | 4 | 3 | Bugün → eylem → Durum: Kapandı |
| Doküman kontrol | Dosya yükle | 5 | 4 | Dokümanlar (son klasör) → Yükle → dosya → Yükle. Projede ilk kez: 6 |
| Doküman kontrol | İncelemeye gönder | 5 | 4 | Dokümanlar (son klasör) → dosyayı işaretle → İnceleme Başlat → Başlat. İlk kez: 6 |
| Doküman kontrol | Gelen yazıyı kaydet | 6 | 3 | + Yeni → "Hill'den gelen yazı: …" yaz, Enter (gönderen ve başlık dolu) → Kaydet. Yazmadan: 5 |
| Doküman kontrol | Cevap yaz | 3 | 2 | Bugün → Cevap Beklenen Yazılar'daki yazı → Cevap Yaz |
| Doküman kontrol | Gönderim formu oluştur | 5 | 3 | + Yeni → "CNS'ye gönderim formu" yaz, Enter (alıcı seçili) → Kaydet. Yazmadan: 4 |
| Proje müdürü | Bugünkü durumu gör | 1 | 0 | Proje ana sayfası |
| Proje müdürü | Geciken işleri gör | 3 (proje geneli; yalnız kendi işleri: 1) | 0 | Bugün → Gecikenler |
| Proje müdürü | Rapor aç | 2 | 2 | Raporlar → panel |
| Proje müdürü | Onay ver | 5 | 4 | Bugün → Onayımı Bekleyenler'deki adım → Tümüne Uygula: Onaylandı → Adımı Gönder |
| Proje müdürü | Toplantı tutanağına bak | 2 | 1 | Bugün → Son Değişiklikler'deki toplantı (son 7 günde değiştiyse). Değilse 3: İşler → Toplantılar → toplantı (İşler son görünümü hatırladığında 2) |
| **Toplam** | | **57** | **36** | En kötü durumda (projede ilk ziyaret, cümle yazmadan) 47 |

## 2a. Aşama — Günün Özeti

Tarih: 11.10.2026 · Dal: `feat/sade2-bugun` · Göç: `0024_today_summaries` (kullanıcı + proje başına son yapay zekâ özeti).

- **Yer:** proje Bugün sayfasının üstünde "Günün Özeti" kartı, 3–6 madde. Maddelerdeki kayıt numaraları kayda bağlanır.
- **Otomatik özet:** yapay zekâsız, Bugün verisinden kalıp cümlelerle (bana düşenler, bugün dolan terminler, gecikenler, cevap bekleyen yazılar ve gönderen firma, son değişiklik, "En acil: …"). Sayfa açılınca hemen görünür. Kod: `apps/server/src/today/text.ts`.
- **Yapay zekâ özeti:** modele yalnız sayılar ve en fazla 15 kısa satır gider (numara, başlık, tip, termin, neden burada, kim bekliyor; son 3 değişiklik). Doküman ve açıklama gitmez. Girdide olmayan kayıt numarası ya da sayı geçen madde atılır (model/ai.ts'teki korumanın aynısı). Hazır olunca otomatik özetin yerini alır: "Yapay Zekâ Özeti · hh:mm".
- **Önbellek:** kullanıcı + proje + damga (kompakt girdinin özeti). Damga değişince yeniden yazılır, en sık 15 dakikada bir; "Yenile" 15 dakikayı beklemez ama veri değişmediyse modeli çağırmaz. Dünün özeti gösterilmez. Kod: `apps/server/src/today/service.ts`.
- **Sağlayıcı yoksa:** "Yapay Zekâya Gönder" (görev türü `today_summary`); bağlı istemcinin cevabı aynı doğrulamadan geçer ve isteyenin özeti olarak saklanır. Uydurma numaralı cevap hata listesiyle geri döner.
- **Yapay zekâ kapalıysa:** yalnız otomatik özet.
- **Kart:** "Yenile", "Gizle"/"Göster" (kullanıcı başına `users.prefs.todaySummaryCollapsed`). Model yazarken ya da görev beklerken sayfa 5 saniyede bir özeti sorar.
- **Uç noktalar:** `GET /projects/:pid/today` (`summary` alanı; `?ai=0` çalıştırma başlatmaz), `GET /projects/:pid/today/summary`, `POST /projects/:pid/today/summary` (`{force?}`, `?wait=1`).
- **MCP / Sor:** `cde_project_today` (Bugün verisi + özet).
