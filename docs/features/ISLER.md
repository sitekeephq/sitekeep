# İşler (works): yazışma, gönderim formu ve "Bugün"

Tarih: 10.10.2026. Kapsam: [docs/product/KONSEPT.md](../product/KONSEPT.md) §1 "Tek kutu: İşler" ve docs/archive/YOL_HARITASI.md PKF/MBE öncelikleri #6 ve #7.

## Model

Yazı, gönderim formu (transmittal), bilgi talebi ve benzeri kayıtlar tek bir **İş** tablosunda tutulur. Tip bir şablondur. Kodla değil ayarla eklenir.

| Tablo | İçerik |
|---|---|
| `work_types` | Projeye özel tip. Alanlar: anahtar, ad, tür (`correspondence` / `transmittal` / `generic`), numara deseni, ortak sayaç grubu, alan listesi (JSON), durum listesi, varsayılan iş akışı şablonu, simge ve renk |
| `works` | Numara (proje + tip içinde tekil), başlık, durum, alan değerleri, gönderen firma, gereği (`to`) ve bilgi (`cc`) firmaları, sorumlu, termin, cevap gerekiyor, gönderim kaydı (`delivery`), sahip firma |
| `work_links` | İş → `file_version` / `review` / `issue` / `work` bağlantısı. Roller: `ilgi`, `ek`, `kaynak`, `kapak`. `meta.signed` imzalı PDF eki, `meta.reply` cevap bağlantısı |
| `work_events` | Zaman çizelgesi: oluşturma, güncelleme, durum, bağlantı, gönderim, alındı, cevap, kapak PDF, not |
| `work_counters` | Atomik sayaçlar. Kapsam = sayaç grubu (ya da tip) + desenin sıra no dışındaki kısmı |
| `work_receipts` | Alıcı firma başına alındı onayı |
| `workflow_template_work_options` | İnceleme şablonunun İş ayarları (otomatik gönderim formu). İş akışı tabloları değişmesin diye ayrı tabloda tutulur |

### Hazır tipler

Her projede ilk kullanımda oluşur:
- **Gelen Yazı** (`{Proje}-GLN-{YYYY}-{0000}`): dışarıdan gelen yazının kaydı. "Alındı" durumuyla başlar ve gönderilmez. Alanlar: gönderenin sayısı, yazı tarihi, konu, özet, proje kodu, yazı serisi, departman, şube.
- **Giden Yazı** (`{Proje}-{Gönderen}-{Alıcı}-{YYYY}-{0000}`). Durumlar: taslak → gönderildi → alındı → cevaplandı / kapandı; ayrıca arşivlendi ve iptal.
- Yazışmaların resmi yazı bilgisi (dil, muhatap, metin, çeviriler), PDF'i ve e-postası için bkz. [docs/features/YAZISMALAR.md](YAZISMALAR.md).
- Eski projelerdeki hazır tiplere yeni alan ve durumlar ilk kullanımda bir kez eklenir; kullanıcı düzenlemeleri korunur.
- **Gönderim Formu** (`{Proje}-GF-{Gönderen}-{YYYY}-{0000}`; 10.10.2026 öncesi açılan projelerde kayıtlı `{Proje}-TRM-…` deseni kalır). Sabit versiyonlu dosya seti, amaç (bilgi / onay / uygulama), alındı onayı.

### Numara

Desen alanları:
- `{Proje}`: proje kodu
- `{Tip}`: tip anahtarı
- `{Gönderen}`, `{Alıcı}`: firmanın kısa kodu (Yönetim → Firmalar, 2–8 harf/rakam). Kod yoksa firma adından üretilir (ASCII büyük harf, en çok 12 karakter: "Hilal Müşavirlik" → `HILLINTERNAT`). Gönderen firması olmayan kullanıcıda `{Gönderen}` proje kodu olur; alıcı yoksa `X`.
- Kodlar Türkçe kurallarla büyütülüp ASCII'ye indirilir: `{Tip}` "giden-yazi" → `GIDEN-YAZI` (İ/Ş/Ğ/Ü/Ö/Ç yerine I/S/G/U/O/C).
- `{YYYY}`, `{YY}`, `{MM}`: yıl ve ay
- `{0000}`: sıra no; sıfır sayısı hane sayısını verir

Sayaç tek bir `INSERT … ON CONFLICT DO UPDATE … RETURNING` ile artırılır. Bu, PostgreSQL'de eşzamanlı isteklerde de atomiktir. Ayrıca `(project_id, type_id, number)` tekil indeksi vardır. Desen değişip eski bir numaraya denk gelinirse o numara atlanır.

### Bilgi talepleri, teknik onaylar ve toplantılar

Bu kayıtlar ayrı modüller değil, aynı İş modelinin hazır tipleridir:

| Tip | Varsayılan numara | Durumlar |
|---|---|---|
| Bilgi Talebi (RFI) | `{Gönderen}_{Alıcı}_{Disiplin}_BT_{000}` | taslak, açık, cevaplandı, kapalı, iptal |
| Teknik Onay Kalemi | `{Gönderen}_{Tür}_{Disiplin}_{0000}` | taslak, incelemede, onaylandı, notlu onaylandı, görüldü, revize et ve tekrar gönder, reddedildi, kapandı, iptal |
| Teknik Onay Paketi | `{Bölüm}-{00} {Disiplin}` | kalemlerden hesaplanan taslak, incelemede, revize bekliyor, kısmen onaylı, onaylandı veya reddedildi |
| Toplantı | `{Proje}-TPL-{YYYY}-{000}` | planlandı, tutanak hazırlanıyor, tutanak yayınlandı, iptal |
| Eylem | `{Proje}-EYL-{0000}` | açık, kapalı |

Eski projelerde kayıtlı `RFI` ve `AKS` desenleri korunur. Desenlerde `{Disiplin}`, `{Tür}`, `{Bölüm}` ve sayaç
kapsamına girmeyen `{Konu}` kullanılabilir; liste değerinin kodu alınır (“M - Mekanik” → `M`). Proje ayarından standart
desenler veya ZAVM desenleri (`{Proje}_{Gönderen}_{Disiplin}_RFI_{000}_{Konu}` ve
`{Proje}_{Tür}_{Disiplin}_{0000}_{Konu}` seçilebilir. Teknik onay türleri MOS, NUM, UCZ, YB, IP, ISG, TR, PMR, KS,
IKOF, BAS ve MKF'dir; BAS bilgi amaçlıdır ve sonucu “Görüldü”dür.

**Onay akışı:** `POST …/works/:wid/submit`, 0'dan başlayan bir `work_revisions` kaydı ve
`subject_type = "work_revision"` iş akışı örneği oluşturur. Tipin varsayılan şablonu kullanılır; `by_attribute`
atamaları iş alanından firmaya çözülür. Şablon yoksa gereği firmaları veya sorumlu kişi tek adımda cevaplar.
`POST …/respond` sonuç kodu, yorum ve RFI resmi cevap metnini kaydeder; kademe, ekip adına onay ve süre kuralları normal
incelemelerle aynıdır. Revize/red sonucu kademe devam etmiyorsa kayıt gönderene döner. Son durum şablonun
`settings.outcomeStatus` ayarından, RFI'deki `resmi_cevap` da resmi cevap metninden gelir. Teknik onayda
`POST …/revise` aynı kaydı Rev n+1 taslağına çevirir ve geçmişi korur; `POST …/cancel` iptal eder. Akış kişilerinin işi
görme yetkisi vardır; görevler `/my-tasks` ve Bugün ekranına, termin hatırlatmaları incelemelerle aynı şekilde düşer.
Şablonun otomatik gönderim formu ayarı revizyon eklerini gönderene veya ayarlı firmalara gönderebilir.

**Paketler:** `parent_work_id` kalemleri pakette toplar. `POST …/items` ekler, `DELETE …/items/:iid` çıkarır. Paketi
onaya göndermek taslak kalemleri gönderir; paket durumu kalem sonuçlarından hesaplanır.

**Toplantılar:** katılımcılar (üye veya dış kişi), gündem ve tutanak `works.data` içinde tutulur. Sorumlusu veya termini
olan tutanak maddesi Eylem alt işi olur. “Sonraki toplantıyı oluştur” açık eylemleri taşır.
`GET …/minutes.pdf` A4 tutanak üretir.

**Register ve içe aktarma:** `GET /projects/:pid/submittals/register[?format=xlsx]` ve
`GET /projects/:pid/rfis/log[?format=xlsx]` dışa aktarılabilir listeleri verir.
`POST /projects/:pid/submittals/import`, şartname listesini JSON/CSV/XLSX olarak önce `dryRun` ile önizler, sonra
oluşturur ve bölüm veya türe göre paketleyebilir. Satır biçimi `SubmittalRegisterItem`'dır.

**Yapay zekâ önerileri:** `POST /projects/:pid/ai/minutes-actions` tutanaktan eylem,
`POST /projects/:pid/ai/rfi-draft` RFI taslağı önerir. Sağlayıcı yoksa 503, yapay zekâ kapalıysa 403 döner. RFI taslağı seçili
dosyanın içeriğini değil yalnız adını ve özniteliklerini kullanır.

Bu tiplerin sınırları: teknik onay sonucu dosya versiyonunun inceleme rozetine yazılmaz; toplantı tutanağı PDF'i
klasöre otomatik kaydedilmez; teknik onay ve RFI listeleri bellekte süzülür.

### Kim görür

Kural `packages/shared/src/works.ts` → `canSeeWork` içindedir. Bir işi şunlar görür:
- proje yöneticileri (hepsini),
- işi oluşturan ve sorumlu kişi,
- sahip firmanın (oluşturanın firması) ve gönderen firmanın üyeleri,
- gereği ve bilgi firmalarının üyeleri. Bu firmalar işi **ancak taslak değilken** görür.

Düzenleme (alanlar, ekler, durum) yöneticilere, oluşturana, sorumluya ve sahip/gönderen firma üyelerine açıktır. Alıcılar "Alındı" verir ve "Cevap yaz" ile yeni bir yazı başlatır. Gönderilen işin alıcıları ve ekleri değişmez. İşi gören herkes eklerini iş üzerinden indirir; klasör yetkisi gerekmez (transmittal alıcısı gibi).

## Cevap zinciri

`POST /works/:id/reply` yeni bir taslak oluşturur:
- tipi: kaynak tipin `replyTypeKey` ayarı, yoksa "Giden yazı";
- gönderen: yazan firma;
- gereği: asıl yazının göndereni;
- bilgi: asıl yazının bilgi firmaları;
- `ilgi` bağlantısı: `meta.reply = true`;
- başlık `RE: <başlık>`; yazışmada dil, düzen, çeviri konuları (`RE: …`), proje kodu, departman ve muhatap da taşınır.

Cevap gönderilince asıl yazı "cevaplandı" olur. `GET /works/:id/thread`, `ilgi` bağlantılarını iki yönde izler ve zinciri tarih sırasıyla verir. Kullanıcının görmediği işler zincirde yer almaz.

## Gönderim formu kapak sayfası

Gönderim formu gönderilirken `pdf-lib` ile A4 bir kapak sayfası üretilir. İçeriği:
- numara, konu, tarih, amaç;
- gönderen, gereği ve bilgi firmaları;
- dosya tablosu: ad, versiyon, revizyon özniteliği;
- alındı kutusu.

Türkçe karakterler için Liberation Sans gömülür (`apps/server/assets/fonts`, `CDE_PDF_FONT_DIR` ile değiştirilebilir). Dosya, tipin `settings.coverFolderId` klasörüne yazılır. Bu ayar boşsa kök altındaki "Gönderim formları" klasörü kullanılır; klasör yoksa oluşturulur. Eski projelerde kökte "Transmittaller" klasörü varsa kapaklar oraya yazılmaya devam eder. Yazma sistem yetkisiyle yapılır ve bu yazmada isimlendirme standardı ile onay kapısı uygulanmaz. Kapak normal bir dosya versiyonudur ve işe `kapak` rolüyle bağlanır. `POST /works/:id/cover` kapağı yeniden üretir ve yeni versiyon olarak kaydeder.

## İnceleme → otomatik gönderim formu

`workflow/service.ts` içinde küçük bir olay kaydı vardır: `onWorkflowEvent` / `emitWorkflowEvent`. İnceleme tamamlanınca `reviews.ts` bir `completed` olayı yayar; bu, oradaki tek ekleme satırıdır. İşler modülü bu olayı dinler.

Şablonun `workflow_template_work_options.auto_transmittal` ayarı açıksa bir gönderim formu oluşur:
- dosyalar: onaylanan dosyalar (onaylı kopyaları varsa onlar), ya da ayara göre incelemedeki tüm dosyalar;
- kaynak: inceleme, `kaynak` bağlantısıyla;
- alıcılar: ayardaki firmalar; ayar boşsa incelemeyi başlatan firma;
- gönderen: incelemeyi tamamlayan kişinin firması.

`send` ayarı açıksa iş hemen CDE içinden gönderilir (kapak PDF'i ve bildirimlerle). Kapalıysa taslak olarak kalır. Bu ayarlar Proje ayarları → İş tipleri sekmesinden yapılır.

Dinleyici hata verirse hata loglanır. İnceleme yine tamamlanmış olur.

## KEP ve e-imza hazırlığı

Şu an dış sisteme hiçbir çağrı yapılmaz.

`apps/server/src/works/delivery.ts` içindeki `DeliveryChannel` arayüzü:

```ts
interface DeliveryChannel {
  id: string; label: string; description: string;
  manual: boolean;              // kullanıcı referansı ve durumu elle girer
  requiresSignedPdf: boolean;   // en az bir ek "imzalı PDF" işaretli olmalı
  send(req: DeliveryRequest): Promise<DeliveryResult>;      // { status, reference }
  refresh?(reference: string): Promise<DeliveryResult | null>; // sağlayıcıdan durum sorgusu
}
```

Kayıtlı kanallar:
- `cde`: CDE içi. Alıcılar bildirim alır.
- `elden`
- `eposta` (manuel)
- `kep` (manuel): KEP gönderim no elle girilir. Teslim durumu (`pending` / `sent` / `delivered` / `failed`) `PATCH /works/:id/delivery` ile güncellenir. Gönderim için en az bir PDF ekinin "imzalı" işaretli olması gerekir.

"İmzalı PDF" şimdilik yalnızca bir işarettir (`work_links.meta.signed`). İmza doğrulanmaz.

### Sonraki adım: gerçek KEP sağlayıcısı

1. `DeliveryChannel` arayüzünü sağlayıcının API'siyle uygulayan bir sınıf yazılır, ör. `KepProviderChannel`.
2. `send` şunları yapar: ekleri `storage` üzerinden okur, imzalı PDF'i ve üst yazıyı sağlayıcıya iletir, sağlayıcının verdiği gönderim no'yu döndürür.
3. `refresh` sağlayıcıdan teslim ve okundu delillerini çeker. Bir iş kuyruğu görevi (`jobs`) bunu belirli aralıklarla çağırır ve `delivery.status` alanını günceller.
4. Kimlik bilgileri `secrets.ts` ile şifreli saklanır, AI sağlayıcı anahtarları gibi.
5. Kanal `DELIVERY_CHANNELS` listesine eklenir. Rotalar ve arayüz değişmez.
6. E-imza (PAdES) doğrulaması ayrı bir adımdır. Ek yüklenince veya gönderimden önce imza doğrulanır ve sonuç `meta.signed` yerine doğrulanmış bir alana yazılır.

## API

Tüm yollar `/api/v1` altındadır.

| Yöntem ve yol | İş |
|---|---|
| `GET /projects/:pid/work-types[?all=1]` | Tipler (hazır tipler gerekirse oluşturulur) |
| `POST /projects/:pid/work-types`, `PUT …/:tid`, `DELETE …/:tid`, `POST …/:tid/restore` | Tip editörü (proje yöneticisi). Silme arşivler |
| `GET /projects/:pid/work-automation`, `PUT …/:tid` | İnceleme şablonu başına otomatik gönderim formu |
| `GET /delivery-channels` | Gönderim kanalları |
| `GET /projects/:pid/works?type=&status=&q=&open=1&due=overdue\|soon&mine=1&view=awaiting\|unmailed\|archived\|cancelled` | Liste (yalnızca görünür olanlar) |
| `POST /projects/:pid/works` | Oluştur (`typeKey` ya da `typeId`, alanlar, alıcılar, bağlantılar) |
| `GET` / `PATCH /projects/:pid/works/:wid` | Detay (bağlantılar, geri bağlantılar, zaman çizelgesi, yetki bayrakları) / güncelle |
| `POST …/:wid/comments` | Not |
| `POST …/:wid/links`, `PATCH …/links/:lid` (`signed`), `DELETE …/links/:lid` | Ek ve ilgi bağlantıları |
| `GET …/:wid/links/:lid/download[?inline=1]` | Sabit versiyonu iş üzerinden indir |
| `POST …/:wid/send` | Gönder (`channel`, `reference`, `note`) |
| `PATCH …/:wid/delivery` | Manuel teslim durumu ve gönderim no |
| `POST …/:wid/receive` | Firmam adına alındı |
| `POST …/:wid/reply` | Cevap taslağı |
| `POST …/:wid/cover` | Kapak PDF'ini yeniden üret |
| `GET …/:wid/thread` | Yazışma zinciri |
| `PUT …/:wid/letter`, `GET …/:wid/letter.pdf`, `GET …/:wid/letter.eml`, `POST …/:wid/letter/mail`, `POST …/:wid/letter/mail-sent`, `POST …/:wid/letter/translate` | Resmi yazı (bkz. [docs/features/YAZISMALAR.md](YAZISMALAR.md)) |
| `POST …/:wid/archive`, `POST …/:wid/cancel`, `POST …/:wid/reopen`, `DELETE …/:wid` | Arşivle, iptal et, taslağa al, sil (yalnızca taslak / iptal) |
| `GET /me/today` | "Bugün" kutusu: bana atananlar, cevap bekleyenler, alındı bekleyenler, termini yaklaşanlar ve geçenler, inceleme görevlerim (`/my-tasks`). Her grubun sayısıyla döner |

## Arayüz

- Proje sekmesi **İşler**: tip filtreleri, arama, durum ve termin filtresi, "Yeni iş" (önce tip seçilir, sonra tipin alanlarından form oluşur).
- İş detayı: alanlar, gönderim kutusu, alındı onayları, ekler (versiyon seçici, imzalı PDF işareti, indirme), ilgi bağlantıları (iş / sorun / inceleme), yazışma zinciri, zaman çizelgesi ve notlar. Eylemler: Gönder, Alındı, Cevap yaz, Düzenle, Kapak PDF yenile.
- Yazışmalarda "Yazı" bölümü: yazı bilgisi, PDF önizle, e-posta, arşivle / iptal / taslağa al / sil. Listede yazışma filtreleri ve gruplama.
- Üst menü **Bugün**: eski "Görevlerim" sayfasının yerini aldı. `/tasks` adresi `/today` adresine yönlenir.
- Proje ayarları → **İş tipleri**: tip editörü (alanlar, numara deseni, sayaç grubu) ve otomatik gönderim formu tablosu.

## Sınırlar

- "Bugün" ekranında takip edilen klasörlerdeki yeni versiyonlar yok, çünkü klasör takibi henüz yok (`newVersions: null`).
- İnceleme bağlantısında incelemenin görünürlüğü kontrol edilmez; yalnızca aynı projede olması yeterlidir. Bağlantı yalnızca inceleme numarasını ve adını gösterir.
- Liste ve "Bugün" görünürlüğü bellekte süzülür. Bu, on binlerce kayda kadar yeterlidir; PKF'de 2.581 yazı vardı.
- MCP / "Sor": `cde_works_list`, `cde_work_get`, `cde_work_thread` ve diğer İş araçları aynı görünürlük kurallarını kullanır.
- Forma'daki yazı özniteliklerinden (Sayı, İlgi, Gereği/Bilgi) içe aktarma ayrı bir iştir.
