# Yazışmalar (resmi yazı)

Tarih: 10.10.2026. Kaynak: Odoo 19 modülü `sevend_yazismalar`. Bu belge, modülün tasarımının SiteKeep'e nasıl taşındığını anlatır.

Ayrı bir modül yazılmadı. Yazışma zaten **İşler**'in bir türüdür (`correspondence`, bkz. [docs/features/ISLER.md](ISLER.md)). Odoo'daki eksik parçalar İşler'e eklendi. Amaç sadelik: yeni tablo yok, yazı bilgisi `works.data.letter` alanında (jsonb) tutulur ve sunucuda zod ile doğrulanır.

## Odoo alanı → SiteKeep

| Odoo (`sevend.correspondence`) | SiteKeep | Not |
|---|---|---|
| `name` (GEL-/GID- sırası) | `works.number` | Gelen ve giden yazının ayrı sayacı vardı. Desen tipte ayarlanır, ör. `GEL-{YYYY}-{00000}`, `GID-{YYYY}-{00000}` |
| `type` (incoming / outgoing) | iş tipi: "Gelen yazı" (`settings.incoming`) / "Giden yazı" | |
| `company_id` | proje + sahip firma | Görünürlük `canSeeWork` kuralı |
| `partner_id` | gönderen firma (gelen) / ilk gereği firması (giden) | |
| `recipient_name`, `recipient_address`, `recipient_email` | `letter.recipient` {name, address, email} | Karşı firmadan doldurulur, elle değişir |
| `cc_list` | `letter.ccEmails` | Dizi; adresler doğrulanır |
| `language`, `secondary_language` | `letter.language`, `letter.secondaryLanguage` | tr, en, fr, it, es, de. İkinci dil farklı olmalı |
| `bilingual_layout` | `letter.layout` | `columns` (yan yana) / `stacked` (alt alta) |
| `subject` | `works.title` | Türkçe konu |
| `content`, `content_2` | `letter.body`, `letter.body2` | HTML yerine düz metin + hafif işaret (aşağıda) |
| `translation_ids` | `letter.translations[lang]` | subject, body, body2, signerTitle, referenceText |
| `full_name`, `job_title` | `letter.signer` {name, title} | Ünvan çevrilebilir |
| `reference_ids` / `referenced_by_ids` | `work_links` (`role = ilgi`) / geri bağlantılar | Kendine ilgi yasak |
| `reference_text` | `letter.referenceText` | |
| `thread_count`, `action_view_thread` | `letter.threadCount`, `GET …/thread` | |
| `project_code`, `series`, `department`, `branch` | alanlar: `proje_kodu`, `seri`, `departman`, `sube` | `{Seri}` numara deseninde de kullanılabilir |
| `document_number` | gelen yazıda `sayi` alanı | Giden yazıda `belge_no` alanı (varsayılan olarak var); PDF'te Belge No olarak basılır |
| `date` | `tarih` alanı; yoksa gönderim / oluşturma tarihi | |
| `state` | durum: taslak, gönderildi, alındı, cevaplandı, kapandı, **arşivlendi**, **iptal** | |
| `is_mail_sent` | `letter.mailSentAt` | Zaman damgası |
| Resmi Yazı (PDF) raporu | `works/letter-pdf.ts` (pdf-lib) | |
| `mail_template_correspondence` | `.eml` taslağı ve isteğe bağlı SMTP | |

## Yeni olanlar

### Yazı bilgisi
- Yazışma işinin detayında **Yazı** bölümü var: dil, ikinci dil, düzen, muhatap, CC, imza, içerik, içerik 2, ilgi metni.
- "Firmadan doldur" muhatabı karşı firmadan alır. Firmalara adres ve e-posta eklendi (Yönetim → Firmalar, migration `0016_yazismalar`).
- Yeni yazıda muhatap boşsa sunucu karşı firmayla doldurur.
- Metin işareti: boş satır yeni paragraf, `- ` ile başlayan satır madde, `**kalın**` kalın yazı.
- Türkçe metin ana metindir. Boş bırakılan çeviri alanında Türkçe metin basılır.
- Yazı metni taslakta değişir. Gelen yazı kaydında arşiv/iptale kadar değişir.

### Gönderim kuralı
- Yazı Türkçe dışında bir dilde basılacaksa gönderimden önce o dilin konusu zorunludur. Türkçe içerik doluysa çevirisi de zorunludur. Hata mesajı Odoo'dakiyle aynıdır.
- Giden yazı gönderilince resmi yazı PDF'i üretilir. "Yazılar" klasörüne (tipte `coverFolderId` varsa oraya) yeni dosya veya yeni versiyon olarak yazılır. İşe `kapak` rolüyle bağlanır. Arayüzde "Resmi yazı (PDF)" diye görünür.
- Cevap yazısı gönderilince ilgi tutulan gelen yazı "cevaplandı" olur. Cevap taslağı açmak durumu değiştirmez.

### Cevap yaz
- Başlık `RE: <başlık>` olur (iki kez eklenmez).
- Dil, ikinci dil ve düzen kopyalanır. Çeviri konuları `RE: …` olarak kopyalanır.
- `proje_kodu`, `departman` ve `konu` alanları kopyalanır.
- Muhatap asıl yazının gönderen firmasıdır.

### Resmi yazı PDF'i
- Üst bilgi: gönderen firma, proje.
- Sol blok: Sayı / Tarih / Konu. Başlıklar her dilde birleşir ("Sayı / Ref"). Tarih her dilin biçimindedir (Türkçe `05.03.2026`, diğerleri `5 March 2026`).
- Sağ blok: Proje (`proje_kodu`), Belge No (varsa).
- Ortada büyük harfle muhatap ve adresi.
- Her dil için: İLGİ listesi (a), b), c)…), ilgi metni, içerik, imza.
- İLGİ satırı: gelen yazı için karşı tarafın sayısı ve "yazınız" / "Your letter"; bizim yazımız için numarası ve "yazımız" / "Our letter". Sıra yazı tarihine göredir.
- Çift dil: "Yan yana" iki sütun ve ara çizgi; "Alt alta" diller arasında yatay çizgi.
- İçerik 2 yeni sayfada başlar. Metin satırlara bölünür, gerekirse sayfalara yayılır. Her sayfanın altında numara ve sayfa no var.
- `GET …/letter.pdf` önizlemedir, kaydedilmez.

### E-posta
- **E-posta hazırla (.eml):** RFC 5322, UTF-8, multipart/mixed. To = muhatap e-postası, Cc = CC listesi, Konu = `<numara> - <konu(lar)>`. Metin her yazı dili için ayrı blok (Odoo şablonundaki metinler), aralarında çizgi; sonunda imza ve firma. Resmi yazı PDF'i ektedir. Dosya kullanıcının e-posta programında açılır.
- **E-posta gönder:** yalnızca `CDE_SMTP_URL` ve `CDE_SMTP_FROM` tanımlıysa görünür (nodemailer). Testlerde gerçek gönderim yapılmaz.
- **Gönderildi işaretle:** .eml kullanıcının programından gönderildiyse elle işaretlenir.
- SMTP gönderimi veya işaret `letter.mailSentAt` alanını doldurur ve zaman çizelgesine yazılır.

### Durumlar
- **Arşivle:** gönderildi, alındı, cevaplandı veya kapandı durumundan.
- **İptal et:** arşivlenmemiş ve iptal edilmemiş her yazı (cevaplanmış olan dahil).
- **Taslağa al:** yalnızca iptal edilmiş yazı.
- **Sil:** yalnızca taslak veya iptal. Taslağı oluşturan veya proje yöneticisi siler; iptal edilmişi proje yöneticisi siler. Diğer yazılar arşivlenir.
- Arşiv ve iptal durum listesinden seçilemez; düğmeler kuralları uygular. Her işlem zaman çizelgesine yazılır.
- Mevcut projelerin hazır tipleri ilk kullanımda bir kez güncellenir: eksik alanlar ve durumlar eklenir. Kullanıcının değiştirdiği etiketlere dokunulmaz. Sonradan silinen alan geri gelmez (`settings.seededKeys`).

### Liste
- Hızlı filtreler: **Cevap bekleyen**, **E-posta gönderilmemiş**, **Arşiv**, **İptal** (`?view=awaiting|unmailed|archived|cancelled`).
- Gruplama: tip, durum, karşı firma, ay (tarayıcıda).

### Yazışma zinciri
- `GET …/thread`: ilgi bağlantılarıyla iki yönde ulaşılan tüm işler, tarih sırasıyla. İşin kendisi de listededir (Odoo'daki zincir görünümü gibi). Kullanıcının görmediği işler çıkarılır.
- Detayda `letter.threadCount` işin kendisi hariç sayıdır. Arayüzde "Yazışma zinciri (n)" ve "Bu yazıyı ilgi tutanlar".

### Yapay zekâ ile çeviri
- `POST …/letter/translate` {language}: konu, içerik, içerik 2 ve ünvan için öneri döndürür. Kaydetmez; kullanıcı formda kontrol edip kaydeder.
- Yönetici yapay zekâ politikası uygulanır (kapalı / tam yerel / dış sağlayıcıya izin). Kapalıysa 403 `ai_off`, sağlayıcı yoksa 503.

### MCP ve "Sor"
- `cde_work_get` çıktısında `letter`: diller, muhatap, e-posta durumu, zincir sayısı.
- Yeni okuma aracı `cde_work_thread` (projectId, workId).

## API (yeni)

Tüm yollar `/api/v1/projects/:pid/works/:wid` altındadır.

| Yöntem ve yol | İş |
|---|---|
| `PUT …/letter` | Yazı bilgisini kaydet (kısmi; çeviri dil başına birleşir, `null` dili siler) |
| `GET …/letter.pdf[?inline=1]` | Resmi yazı önizlemesi |
| `GET …/letter.eml` | E-posta taslağı |
| `POST …/letter/mail` | SMTP ile gönder (yalnızca SMTP tanımlıysa) |
| `POST …/letter/mail-sent` | E-posta gönderildi olarak işaretle |
| `POST …/letter/translate` | Çeviri önerisi |
| `POST …/archive`, `POST …/cancel`, `POST …/reopen` | Arşivle, iptal et, taslağa al |
| `DELETE …` | Taslak / iptal işi sil |

`POST /projects/:pid/works` artık `letter` alanını da alır. `GET /projects/:pid/works` `view` süzgecini alır. Firmalar (`POST`/`PATCH /companies`) `address` ve `email` alır.

## Taşınmayanlar ve nedeni

- **Sharepoint link, `pdf_url`, `visual`:** CDE'nin kendi dosya bağlantıları (ek, kapak/resmi yazı PDF'i) bunların yerini tutar.
- **Çoklu şirket kuralı (`ir.rule`):** proje ve firma görünürlüğü (`canSeeWork`) aynı işi görür.
- **Yönetici grubu (silme yetkisi):** proje yöneticisi yetkisi. Taslağı oluşturan da silebilir.
- **HTML içerik:** düz metin + hafif işaret seçildi. PDF ve e-postada aynı sonucu verir, editör gerektirmez.
- **Odoo chatter / e-posta oluşturucu:** zaman çizelgesi ve .eml taslağı. SMTP isteğe bağlıdır.
- **Takip eden (follower), aktivite:** İşler'deki sorumlu, termin ve bildirimler kullanılır.
- **Gelen yazı için PDF:** Odoo her yazı için rapor basabiliyordu. CDE'de gelen yazının aslı ek olarak yüklenir; resmi yazı yalnızca giden yazıda üretilir.
- **`subject_en` … migration'ı:** CDE'de eski veri yok.
