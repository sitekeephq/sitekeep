# Doküman karşılaştırma (Revizyon karşılaştır)

Bir dokümanın iki versiyonunu yan yana koyar. Neyin değiştiğini görsel, metin ve yapay zekâ özetiyle gösterir.

## Nereden açılır

- **Dosya çekmecesi:** "⇄ Önceki revizyonla karşılaştır" düğmesi. Versiyon geçmişinde her satırda "Karşılaştır" bağlantısı var.
- **PDF görüntüleyici:** sol panelde "⇄ Önceki revizyonla karşılaştır".
- **İnceleme sayfası:** dosya tablosunda versiyon rozetinin yanındaki "⇄".
- Adres: `/p/<proje>/compare?to=<versiyon>` önceki versiyonla karşılaştırır. `from=` ile başka bir versiyon ya da dosya seçilir.
- Sayfada eski ve yeni versiyon seçilebilir. "⇄" ile yer değiştirir. "Başka dosyayla…" aynı klasörden başka bir dosyayı eski taraf yapar.

## Desteklenen türler

| Tür | Görsel | Metin farkı |
|---|---|---|
| PDF (pafta, rapor) | Var | Sayfa sayfa satır/hücre farkı, antet farkı |
| XLSX | Yok | Çalışma sayfası, satır ve hücre farkı |
| CSV / TSV | Yok | Satır ve hücre farkı |
| DOCX | Yok | Paragraf farkı |
| TXT / MD | Yok | Satır farkı |

İki dosya aynı türde olmalı. IFC modelleri model görüntüleyicide karşılaştırılır.

## Görsel karşılaştırma (PDF)

- Sayfalar tarayıcıda pdf.js ile çizilir. Piksel farkı bir Web Worker'da hesaplanır. Sunucu yorulmaz.
- **Üst üste:** eski versiyonda olup yenide olmayan kırmızı, yeni eklenen mavi, değişmeyen gri.
- **Yan yana:** iki sayfa, kaydırma birlikte hareket eder. Dar ekranda alt alta dizilir.
- **Kaydırıcı:** yeni sayfa eskinin üstünde; kaydırıcıyla sınır taşınır.
- 1 piksellik kaymalar ve kenar yumuşatma fark sayılmaz.
- Kâğıt boyutu değişip oranı aynı kaldıysa eski sayfa yeni boyuta ölçeklenir.
- **Hizala (← ↑ ↓ →):** eski sayfayı 1 pt kaydırır. Bölgeler o sayfa için yeniden hesaplanır.
- **Değişen bölgeler (n):** farklı pikseller kümelenir, her küme bir kutudur. Listeden tıklayınca sayfa o bölgeye yakınlaşır.
- Bölgeler ilk açılışta hesaplanır ve sunucuda saklanır. Sonraki açılışlar hızlıdır.
- Görsel analiz en fazla ilk 60 sayfada yapılır.

## Metin farkı

- Sunucu, docintel'in PDF metin okuyucusunu kullanır (en fazla 300 sayfa).
- Tüm doküman tek seferde karşılaştırılır. Metin bir sonraki sayfaya kaydıysa fark sayılmaz.
- Benzer satırlar "değişen" olarak eşlenir ve kelime farkı gösterilir: `KOLON S12 40x60 → 50x60`.
- Antet (antet bölgesi) içindeki değişiklikler "(antet)" etiketiyle ayrılır.
- **Antet değişiklikleri** tablosu: revizyon, tarih, çizim no, ölçek, pafta adı ve revizyon tablosunun son satırı.
- Taranmış PDF'te metin katmanı yoktur. Ekranda "Metin katmanı yok, yalnızca görsel karşılaştırma." yazar.

## Kontroller

- **Revizyon aynı ama içerik değişmiş:** "revizyon bulutu/tablosu güncellenmemiş olabilir" uyarısı.
- **Revizyon değişmiş ama antet dışında değişiklik yok:** uyarı.
- **Revizyon yükselmiş ama tablo güncellenmemiş:** uyarı.
- **Revizyon geri gitmiş**, **sayfa sayısı değişmiş**, **iki dosya birebir aynı** bilgileri.
- İçerik değişikliği için hem metin farkı hem görsel bölgeler (antet dışında olanlar) sayılır.

## Değişiklik özeti (yapay zekâ)

- Modele **yalnızca fark özeti** gider: değişen satırlar, antet farkları, sayfa başına bölge sayısı ve kontroller. Doküman gönderilmez.
- Özet kısa Türkçe maddelerdir. Her madde sayfasıyla gelir; tıklayınca o sayfaya ve ilgili bölgeye gidilir.
- Uyarı maddeleri turuncu gösterilir.
- Özet arka planda yazılır. Yerel modelde 30–60 sn sürebilir; ilerleme gösterilir, sayfa bu sırada kullanılabilir.
- Görsel bölgeler hazır olunca özet kendiliğinden başlar. "Yeniden yaz" yeni bir özet ister.
- Sonuç versiyon çifti başına saklanır.
- Yapay zekâ kapalıysa ya da sağlayıcı yoksa kural tabanlı özet gösterilir ve nedeni yazılır.
- Yönetici yapay zekâ politikası (kapalı / yalnız yerel / dış izinli) aynen uygulanır.

## İşlemler

- **İşaretleme olarak kaydet:** değişen bölgeler yeni versiyona revizyon bulutu olarak çizilir. Taslak olarak kaydedilir.
- **Sorun oluştur (⚑):** bir bölgeden ya da özet maddesinden. Bölge için bulut işaretleme açılır ve soruna bağlanır.
- **Rapor (PDF):** özet, kontroller, antet tablosu, metin farkları ve değişen sayfaların küçük görselleri.
- **Özeti incelemeye ekle:** yeni versiyon süren bir incelemedeyse özet, inceleme zaman çizelgesine not olarak eklenir.

## Sunucu uçları

| Uç | İş |
|---|---|
| `GET /projects/:pid/doc-compare?from=&to=[&rebuild=1][&wait=ms]` | Karşılaştırmayı getirir; yoksa başlatır |
| `GET /projects/:pid/doc-compare/:cid[?wait=ms]` | Durum, sonuç, özet ilerlemesi |
| `PUT /projects/:pid/doc-compare/:cid/regions` | Tarayıcının bulduğu bölgeleri saklar |
| `POST /projects/:pid/doc-compare/:cid/summary {force?}` | Yapay zekâ özetini başlatır |
| `POST /projects/:pid/doc-compare/:cid/report {thumbnails}` | Rapor PDF'i |
| `POST /projects/:pid/doc-compare/:cid/review-note {reviewId}` | Özeti incelemeye not olarak ekler |

- Tablo: `doc_comparisons` (migration `0017_doc_compare`). Çift başına bir satır.
- İki versiyonu da görme yetkisi gerekir. Yetkisi olmayan 404 alır.
- Rapor ucu salt okuma erişim anahtarlarına açıktır.

## MCP / Sor

- Araç: `cde_document_compare` (salt okuma).
- Girdi: `projectId` + `fromVersionId` + `toVersionId`, ya da yalnız `fileId` (güncel ↔ önceki).
- Çıktı: sayfa başına metin farkı örnekleri, antet farkları, kontroller, varsa yapay zekâ özeti, yoksa kural tabanlı özet.
- "Sor" asistanı "ne değişti, karşılaştır, fark" gibi sorularda bu aracı kullanır.

## Sonraya kalanlar

- Taranmış PDF için OCR ile metin farkı.
- Çizimdeki revizyon bulutlarını tanıyıp "bulut dışında değişiklik var" kontrolü.
- Otomatik hizalama (görüntü eşleme); şimdilik elle hizalama var.
- Sayfa sırası değişince sayfaları başlığa göre eşleme.
- Çok paftalı setlerde her sayfanın antetini ayrı okuma (şimdi ilk sayfa).
- DWG/DXF karşılaştırma.
