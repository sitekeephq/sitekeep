# PDF'ten Form Şablonu ve Anlatılan Onay Akışı

Müşterinin kullandığı resmî kâğıt form PDF olarak yüklenir. Sistem alanları bulur.
Kullanıcı akışı düz Türkçe anlatır. Sonuç, onay akışı bağlı normal bir form şablonudur.
Doldurulan form, yüklenen PDF'in kendi düzeninde çıkar.

## Nasıl çalışır

1. **Formlar → Şablonlar → PDF'ten Şablon Oluştur.** PDF seçilir (en fazla 30 MB, ilk 20 sayfa).
2. Sunucu PDF'i saklar ve alanları arar. Sonuç bir taslaktır; henüz kaydedilmez.
3. **Alanlar** ekranında PDF sayfaları ve alan kutuları görünür. Yanda alan listesi vardır.
   - Kutuya tıklayınca listede, listede tıklayınca sayfada seçilir.
   - Kutu sürüklenerek taşınır, sağ alt tutamaçla boyutlandırılır.
   - **Alan Çiz** ile sayfada sürükleyerek yeni alan eklenir.
   - Listede ad, tip, zorunluluk ve bölüm değiştirilir. Tablolarda sayfadaki satır sayısı girilir.
   - Silmek için **Sil** ya da Delete tuşu. Ok tuşları kutuyu 1 pt (Shift ile 10 pt) kaydırır.
   - **Geri Al** (Ctrl+Z) son değişiklikleri geri alır.
4. **Yapay Zekâ ile Adlandır** isteğe bağlıdır. Modele yalnız kısa alan listesi gider, PDF gitmez.
   Model ad, tip ve bölüm önerir; kutuların yeri değişmez.
5. **Kaydet.** Şablon normal, sürümlü bir form şablonudur. Her sürüm kaynak PDF'i saklar.
   Bir form kullandıktan sonra yapılan değişiklik yeni sürüm açar; eski formlar eski sürümle kalır.
6. **Onay Akışı** sekmesinde akış anlatılır veya elle kurulur, sonra kaydedilir.

## Alan bulma düzeyleri

| Düzey | Ne zaman | Nasıl |
|---|---|---|
| Doldurulabilir PDF (AcroForm) | PDF'te form alanları var | Alanlar aynen okunur: ad, tip, seçenekler, sayfa ve kutu. En güvenilir düzey. |
| Metin Katmanlı PDF | Alan yok ama metin seçilebiliyor | Etiketler ve boşluklar kurallarla bulunur. Yapay zekâ kapalıyken de çalışır. |
| Taranmış PDF | Metin katmanı yok | Alan bulunamaz. Açık bir mesaj çıkar; alanlar sayfada elle çizilir. |

Metin katmanında aranan işaretler:

- `Proje Adı: ..........` ve `Tarih: ______` gibi noktalı veya alt çizgili boşluklar.
- Etiketin yanındaki çizgi (`Döküm Yeri: ________` çizgi olarak çizilmişse).
- Altında etiket olan imza çizgileri (`Hazırlayan İmza`, `Kontrol Eden İmza`).
- İçinde veya üstünde etiket olan kutular (`Açıklama`, `Kaşe`).
- Onay kutuları: `☐ Evet ☐ Hayır` tek bir Evet/Hayır maddesi olur; başka etiketler seçim olur.
- Kutusuz `Evet Hayır` yazıları.
- Tablo ızgaraları: başlığı dolu, satırları boş ızgara tekrarlı tablo olur.
  Etiket–değer ızgarası (solda etiket, sağda boş hücre) ayrı alanlar olur.
- Sonu `:` ile biten etiket ve sağında boşluk.
- Tip etiketten çıkar: tarih, imza/kaşe, fotoğraf/kroki, km, birimli sayı (`(m³)`, `(mm)`), açıklama (çok satırlı).
- Bölümler: büyük harfli veya daha büyük yazılı kısa satırlar.

Taranmış PDF için görüntü modeli (ör. Ollama üzerinde Qwen2.5-VL) veya OCR gerekir.
Sunucuda `VisionFieldDetector` arayüzü hazırdır (`apps/server/src/forms/pdf-detect.ts`).
Bir model bağlanınca sayfa görüntülerini alır, aynı biçimde aday alanlar döndürür.

## Akışı anlatmak

Örnek anlatım:

> Formu şantiye şefi doldurur, kalite kontrol mühendisi kontrol eder; ret olursa yükleniciye geri döner;
> onaylanınca müşavire bilgi gider; 3 gün içinde cevap verilmeli; imza alanlarını onaylayan kişi doldurur.

Çıkan adımlar:

```
1. Şantiye Şefi doldurur
2. Kalite Kontrol Mühendisi kontrol eder (Onay → kapanır; Ret → 1. adıma döner) · 3 gün · Doldurur: Kontrol Eden İmza
Onaylanınca bilgi: Müşavir
Durum: onaylanınca Kapalı; iade veya retle doldurana dönerse Taslak
```

Başka örnekler:

- "Formu formen doldurur, şantiye şefi kontrol eder, proje müdürü onaylar; müdür reddederse şantiye şefine döner."
  Üç adım çıkar; 3. adımın reti 2. adıma döner.
- "Teknik ofis doldurur, müşavir görür." Müşavir adımında yalnız "Görüldü" cevabı olur.

Kurallar:

- Model yalnız küçük bir JSON üretir. Gerisi kuralla yapılır ve zod ile doğrulanır.
- Geçersiz cevap bir kez hata listesiyle düzelttirilir. Yine olmazsa açık bir hata mesajı döner.
- Adlar projedeki rol, firma ve kişilerle eşleştirilir. Eşleşmeyen ad "Projede Olmayan Roller" kutusunda çıkar.
  **Rol Oluştur** rolü açar; **Eşleştir** mevcut rol, firma veya kişiye bağlar. Eşleşmeden kaydedilmez.
- "Proje yöneticisi" yerleşik rol olur. "Formu dolduran" akışı başlatan kişidir.
- Kaydedilen akış normal bir onay akışı şablonudur (tür: Form Onayı). Elle kurmak için aynı ekran kullanılır.
- Yapay zekâ kapalıysa **Elle Kur** ile adımlar, atananlar, cevaplar, dönüş adımı, süre ve alanlar seçilir.

## Alan yetkisi (sunucuda)

- Bir adıma verilen alanı yalnız o adımın atananı, yalnız o adımda doldurur.
- Dolduran kişi bu alanları değiştiremez; değer veya ek göndermeye çalışırsa 403 alır.
- Bu alanlar doldurandan zorunlu istenmez. Adımda onay verilmeden önce doldurulmaları gerekir.
- Atanan kişi alanları `PATCH /forms/:id/step-values` ile kaydeder; başka alana dokunamaz.
- Formu yalnız akışta "dolduran" olarak seçilenler açabilir (boşsa herkes).
- Ret, adımda seçilen önceki adıma döner (yeni tur) ya da doldurana taslak olarak döner.

## Çıktı (PDF)

- Kaynak PDF'i olan şablonlarda çıktı, yüklenen PDF'in üzerine yazılır.
- Doldurulabilir PDF'te onay kutuları ve seçenek düğmeleri PDF'in kendi işaretiyle işaretlenir.
  Metinler PDF düzleştirildikten sonra kutuya yazılır (Liberation Sans; Türkçe harfler tam).
- Diğer PDF'lerde metin kutuya sığacak boyutta yazılır, uzun metin satıra bölünür.
- İşaret kutularına tik çizilir, imza görseli kutuya oturur, tarih gg.aa.yyyy olur.
- Tablo satırları ızgaraya yazılır. Sığmayan satırlar ek sayfada "devam" başlığıyla çıkar.
- Fotoğraflar ek sayfalarda toplanır.
- "Onay Damgası" (adım, kişi, tarih, sonuç) sayfanın boş kenar boşluğuna konur. Yer yoksa ek sayfaya.
- Form numarası, yer varsa 1. sayfanın üst boşluğuna yazılır.
- Kaynak PDF'i olmayan şablonlar eski genel çıktıyı kullanır.

## Doldurma

- Formu Doldur ekranı aynıdır; telefonda ve çevrimdışı çalışır.
- **PDF Görünümü** değerleri formun kendi PDF'i üzerinde gösterir. PDF tarayıcıda saklanır, çevrimdışı da açılır.
- Bir alana dokununca form görünümünde o maddeye gidilir.
- Onay adımındaki kişi kendi alanlarını (ör. imza) doldurur, sonra cevap verir. Bu adım için bağlantı gerekir.

## Uç noktalar

| Yöntem | Yol | Açıklama |
|---|---|---|
| POST | `/projects/:pid/form-templates/pdf` | PDF yükle, alanları bul (taslak döner) |
| GET | `/projects/:pid/form-pdf-sources/:sid` · `/file` | Kaynak PDF bilgisi · dosyası |
| POST | `/projects/:pid/form-templates/name-fields` | Alanları yerel modelle adlandır |
| POST | `/projects/:pid/form-templates/flow/generate` | Anlatımdan akış taslağı |
| GET · PUT · DELETE | `/projects/:pid/form-templates/:tid/flow` | Şablonun akışı |
| PATCH | `/projects/:pid/forms/:fid/step-values` | Adım sahibinin alanları |
| POST | `/projects/:pid/forms/:fid/review` | `code` ile özel cevap (ör. `RET`) |

MCP: `cde_form_templates_list` şablonun kaynağını (PDF) ve akış adımlarını verir.
`cde_form_template_from_description` anlatımdan şablon ve akış oluşturur (yazma anahtarı, proje yöneticisi).

## Sınırlar

- Taranmış PDF'te otomatik alan bulma yok (görüntü modeli kurulu değil).
- Döndürülmüş sayfalar ve sayfa başına ayrı kırpma kutuları denenmedi.
- Şifreli (parola korumalı) PDF kabul edilmez.
- Kurallar sık görülen düzenleri bulur; karışık formlarda kutuları kontrol edip düzeltmek gerekir.
- Bir tablonun birleştirilmiş hücreleri tek sütun gibi okunabilir.
- Mevcut şablonun PDF'ini değiştirmek için yeni PDF şablonu açılır (alanlar eşlenmez).
- Yerel 8B model işlemcide yavaştır; akış ve adlandırma birkaç dakika sürebilir.
- Onay adımındaki imza ve alanlar çevrimdışı kaydedilmez.
