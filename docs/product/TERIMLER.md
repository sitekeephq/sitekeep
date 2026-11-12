# Terimler: arayüzde Türkçe karşılıklar

Tarih: 10.10.2026. Kullanıcının gördüğü her ad Türkçedir: menü, sayfa, düğme, uyarı, bildirim, PDF/Excel çıktısı ve
"Sor" asistanının cevabı. "Review'lar", "Issue'lar" gibi İngilizce ödünç sözcükler kullanılmaz.

İç adlar değişmez: veritabanı tabloları ve alanları, durum/enum değerleri, API yolları (`/issues`, `/reviews`), sayfa
adresleri, sorgu parametreleri, olay türleri (`review.started`), MCP araç adları (`cde_issues_list`) ve tip anahtarları
(`transmittal`, `aksiyon`). MCP araç açıklamaları modeller için İngilizce kalır; araçların Türkçe çıktıları bu terimleri
kullanır.

Ürün ve standart adları olduğu gibi kalır: IFC, BIM, ISO 19650, PDF, DWG, DXF, KEP, IDS (dosya biçimi), MCP, Ollama,
ONLYOFFICE, Collabora, That Open. MCP yönetici ekranında Türkçe açıklamasıyla geçer ("yapay zekâ istemcileri için araç
sunucusu").

## Sözlük

| İngilizce / eski | Türkçe | Not |
|---|---|---|
| Review, Review'lar | İnceleme, İncelemeler | "İnceleme başlat", "İnceleme #12", inceleme zinciri, inceleme şablonu |
| Reviewer | İnceleyen | "İnceleyen görüşleri" |
| Issue, Issue'lar | Sorun, Sorunlar | "Sorun oluştur", "Sorun #7" |
| Pin (issue pin) | Nokta | "📍 Noktadan sorun", "+ Görünümden sorun" |
| Viewpoint | Görünüm | |
| BCF topic | Sorun | "BCF İçe Aktar", "BCF Olarak Dışa Aktar" (../features/BCF.md). BCF adı olduğu gibi kalır |
| Conflict (içe aktarmada) | Uyuşmazlık | "Çakışma" model çakışması için ayrıldı |
| RFI, RFI log | Bilgi talebi, Bilgi talebi listesi | Kısaltma yalnız açıklamalarda bir kez: "bilgi talebi (RFI)". Yeni projelerde numara kısaltması **BT** (`…_BT_000`), eski projelerde kayıtlı `…_RFI_000` kalır |
| Submittal, submittal kalemi / paketi | Teknik onay, teknik onay kalemi / paketi | |
| Submittal register | Teknik onay listesi | Excel sayfası ve dosya adı da: `…-teknik-onay-listesi.xlsx` |
| Spec, spec bölümü | Şartname, şartname bölümü | "Şartnameden teknik onay listesi çıkar" |
| Register ("şartname register'ı") | Liste | "Şartname listesini içe aktar" |
| Transmittal, Transmittaller | Gönderim formu, Gönderim formları | Kapak PDF başlığı "GÖNDERİM FORMU"; varsayılan klasör "Gönderim formları" (aşağıya bakın). Yeni projelerde numara kısaltması **GF** (`{Proje}-GF-…`), eski projelerde kayıtlı `{Proje}-TRM-…` kalır |
| Markup | İşaretleme | "İşaretlemeler", "İşaretleme olarak kaydet" |
| Clash, clash testi | Çakışma, çakışma testi | |
| Model Coordination | Model koordinasyonu | Menüde "Koordinasyon" |
| Model viewer (menü) | Model Görüntüleyici | Kullanıcı kararı (10.10.2026); önce "Model" idi |
| Model set | Model seti | |
| Federation, federated | Birleşik model | |
| Viewer | Görüntüleyici | "Görüntüleyicide aç" |
| Dashboard | Panel | Rapor paneli |
| Monitoring | Sistem Durumu | Yönetim ve Proje Ayarları sekmesi; Grafana değil |
| Log / logs | Son Hatalar | Sistem Durumu; ham sunucu günlüğü değil |
| Cleanup (disk) | Türevleri Temizle | Önizleme ve Fragments; proje dosyası silinmez |
| Workflow | İş akışı | |
| Template | Şablon | |
| Ball in court ("Top kimde") | Sıradaki taraf | İş kartı, bilgi talebi listesi ve teknik onay listesi (Excel dahil) |
| Baseline | Temel plan | "Temel plan yap", "Planlanan (temel plan)" |
| Lookahead | Yakın dönem planı | |
| WBS | İş kırılımı | İçe aktarma eşlemesinde "İş kırılımı (WBS)" |
| Gantt | Gantt şeması | |
| Action (toplantı maddesi), Aksiyon | Eylem, Eylemler | Kullanıcı kararı (10.10.2026). Yeni projelerde numara deseni `{Proje}-EYL-{0000}` |
| Token (API) | Erişim anahtarı | "API erişim anahtarları", "Yeni erişim anahtarı" |
| Google Sign-In | Google ile devam et | `/login` düğmesi. OpenCDE OAuth uygulaması değil. [Google ile giriş](../features/GOOGLE_GIRIS.md) |
| Domain allowlist | İzinli Alan Adı | Yönetim → Kullanıcılar. Google ile yeni kullanıcı açma anahtarı |
| Forma / ACC file sync | Forma Eşitleme | Proje → Yönetim. ACC projesi bağlantısı, kayıt ve dosya getirme tek sayfada. [Forma eşitleme](../features/FORMA_ESITLEME.md) |
| Upload / download | Yükle / indir | |
| WIP / Shared / Published / Archived | Çalışma / Paylaşılan / Yayınlanan / Arşivlenen | ISO 19650 durum etiketleri |
| Shared for Review / Shared for Approval | İnceleme için / Onay için | Proje şablonlarındaki alt durum etiketi |
| As-Built | İş sonu | İBB yapısındaki "04-İş Sonu (As-Built)" adından |
| IDS check | Bilgi gereksinimi kontrolü (IDS) | IDS dosya biçiminin adı olarak kalır: "IDS dosyası" |
| Specification (IDS içinde) | Gereksinim tanımı | |
| Embedding model | Arama modeli (embedding) | Yalnız yapay zekâ yönetim ekranı |
| Status open / closed / draft | Açık / Kapalı / Taslak | Etiket tabloları zaten Türkçeydi |

Dil modeli istemleri ("Sor" asistanı, rapor paneli üreticisi, çakışma özeti) aynı listeyi kullanır:
`packages/shared/src/terms.ts` (`UI_TERMS_TR`, `termsInstructionTr()`).

## Büyük harf kuralı

"Her Kelime Büyük Harf İle Başlasın" (kullanıcı kararı, 10.10.2026). **Adlar ve etiketler** Title Case yazılır, Türkçe
harf kurallarıyla (i → İ, ı → I: "İş Programı", "Tüm İşler"):

- sol menü, grup başlıkları ve "Sor…"; sayfa ve bölüm başlıkları (h1/h2/h3), sekmeler, pencere başlıkları;
- iş tipi ve kategori adları ("Gelen Yazı", "Teknik Onay Kalemi"), İşler bölümleri, durum etiketleri ("Notlu Onaylandı",
  "Tutanak Hazırlanıyor"), hızlı filtre ve rozet etiketleri;
- onay kutusu ve seçenek düğmesi (radio) metinleri ("Yalnız Açık İşler", "Sistem Yöneticisi"; kullanıcı kararı
  10.10.2026); " — " ya da noktadan sonraki açıklama cümle gibi kalır;
- tablo sütunları, form alanı etiketleri, düğmeler ("+ Yeni Yazı", "PDF Olarak Kaydet", "Sayfa Düzeninde Aç (PDF)"), ad
  niteliğindeki seçenekler ("Gruplama Yok", "Tipe Göre"), yönetim sekmeleri, rapor şablonu adları, PDF başlıkları,
  Excel sütunları ve sayfa adları, hazır tiplerin, form kütüphanesinin ve proje şablonlarının alan etiketleri.

Küçük kalan sözcükler (başta değilse): ve, ile, veya, ya da, için, de/da, ki ve TDK'nın başlık kuralındaki soru eki
mı/mi/mu/mü ("Formlar ve Konumlar", "Açık mı"). Büyük harfle ya da rakamla başlayan sözcükler olduğu gibi kalır: PDF,
IFC, BIM, ISO, KEP, MCP, BT, GF, sayılar. Parantez içi açıklama adın parçası değildir ve cümle gibi kalır: "Yeni Şifre (en
az 10 karakter)", "Not (isteğe bağlı)".

**Cümle gibi kalanlar:** yardım ve açıklama metinleri, boş liste cümleleri, hata ve bildirim iletileri, yer tutucular,
seçim kartlarının açıklama satırları, form kütüphanesindeki evet/hayır kontrol maddeleri, etkinlik kaydı satırları, yapay
zekâ cevapları ve istemleri, belge metinleri. Kullanıcının yazdığı veri (başlık, klasör adı, yöneticinin verdiği tip adı)
hiç değişmez. Klasör adları da değişmedi (aşağıya bakın).

Yardımcı: `packages/shared/src/title-case.ts` → `titleCaseTr(text)`, `isTitleCaseTr(text)`. Etiketler kaynakta Title Case
yazılır; yardımcı yalnız kayıtlı varsayılanların yükseltilmesinde ve denetimde kullanılır.

## Kayıtlı veriler

Kayıtlı değerler değiştirilmedi. İstisna, projeye kurulan varsayılan ad ve etiketlerdir; yönetici değiştirdiyse onunki
kalır:

- **Kapak klasörü:** yeni projelerde gönderim formu kapakları kökte "Gönderim formları" klasörüne yazılır. Kökte eski
  "Transmittaller" klasörü olan projeler onu kullanmaya devam eder; ikinci bir klasör açılmaz.
- **Hazır iş tipleri:** ad, alan etiketleri ve durum etiketleri bir sonraki açılışta güncel varsayılanı alır ("Transmittal"
  / "Gönderim formu" → "Gönderim Formu", "Yazı tarihi" → "Yazı Tarihi", "Notlu onaylandı" → "Notlu Onaylandı"), yalnız
  hâlâ seeder'ın verdiği değeri taşıyorsa. Seeder verdiği adı `settings.seededName`, alan ve durum etiketlerini
  `settings.seededLabels` (`f:anahtar`, `s:anahtar`) alanında tutar. Bu alanlar olmadan kurulmuş eski kayıtlarda önceki
  varsayılan, bilinen eski ad ya da aynı sözcüklerin başka harf büyüklüğüyle yazılışıdır (`isSeededDefaultLabel`).
  Yönetici etiketi sonradan eski haline yazarsa o da onun kabul edilir ve kalır. Yükseltme iki kez çalışsa da bir şey
  değişmez.
- **Numara desenleri** kayıtlıdır ve değişmez; var olan numaralar yeniden verilmez. Yeni projelerde bilgi talebi `BT`
  (`{Gönderen}_{Alıcı}_{Disiplin}_BT_{000}`), gönderim formu `GF` (`{Proje}-GF-{Gönderen}-{YYYY}-{0000}`), eylem `EYL`
  ile numaralanır. Eski projeler `RFI`, `TRM`, `AKS` ile devam eder. "Standart" hazır ayarı artık `BT` yazar; "ZAVM" hazır
  ayarı müşterinin Forma kodlamasını (`PAS_CNS_{D}_RFI_{001}_{Konu}`) sürdürdüğü için `RFI` olarak kaldı.
- **Alt durum etiketi:** şablonların yazdığı "İş sonu", sunucu açılışında "İş Sonu" olur
  (`apps/server/src/seeded-labels.ts`). Elle yazılmış başka etiketler kalır.

Proje şablonları (`apps/server/templates`) ve form kütüphanesi yalnız yeni oluşturulan projeleri ve yeni eklenen form
şablonlarını etkiler: şablon adları, onay adımı adları, öznitelik ve isimlendirme standardı adları Title Case oldu.
Rapor şablonlarından oluşturulmuş paneller kullanıcı verisidir, değişmez.

## Denetim

`npm test`, `apps/web/scripts/check-ui-terms.mjs` betiğini de çalıştırır. Betik `apps/web/src` içindeki JSX metinlerinde,
metin dizgelerinde ve şablon dizgelerinde şu sözcükleri arar: Review, Issue, RFI, Submittal, Transmittal, Markup,
Clash, Dashboard, Viewer, Register ve Aksiyon (çoğulları ve "Review'lar" gibi ekli halleri). Tanımlayıcıya benzeyen dizgeler (`"review"`,
`"/issues"`, `"?markup="`), nesne anahtarları, içe aktarmalar, tipler ve yorumlar atlanır. İngilizce sözcüğün gerçekten
gerektiği bir satıra `ui-terms-ok` yorumu eklenebilir. Paylaşılan etiket tabloları için `packages/shared/test/terms.test.ts`
vardır.

Büyük harf kuralını `apps/web/test/app/ui-terms.test.ts` denetler: menü adları, İşler görünümleri, Model ve Proje Ayarları
sekmeleri (`apps/web/src/nav.ts`), İşler bölümleri ve hızlı filtreleri, hazır iş tiplerinin adları, alan ve durum etiketleri ve paylaşılan `*_LABELS_TR` tabloları
`isTitleCaseTr` ile Title Case olmalı. Onay kutusu ve seçenek düğmesi metinleri de denetlenir: betiğin
`findChoiceLabels()` işlevi, içinde `<input type="checkbox|radio">` olan `<label>` öğelerinin kendi metnini ve `<strong>`
başlığını toplar (iç içe `<span>` notları ve " — " sonrası açıklama hariç). Cümle taşıyan dört tablo (`ACCESS_VIA_LABELS_TR`, `MODEL_OP_LABELS_TR`,
`ROLE_PACKAGE_ACTION_LABELS_TR`, `STAGE_REVISE_LABELS_TR`) bilerek dışarıda.

## Kararlar (10.10.2026)

1. **Klasör adları kalır.** Varsayılan klasörler ("01-WIP (Çalışmada)", "02-SHARED (Paylaşılan)", "03-PUBLISHED
   (Yayınlanan)", "04-ARCHIVED (Arşiv)"), İBB şablonundaki "01-Paylaşılan (Shared for Review)", "04-İş Sonu (As-Built)" ve
   kapak klasörü "Gönderim formları" olduğu gibi kaldı.
2. **Numara kısaltmaları:** yeni projelerde bilgi talebi `BT`, gönderim formu `GF` (yukarıya bakın). Diğer hazır
   kısaltmalar değişmedi: `GLN` (gelen yazı), `TPL` (toplantı), `EYL` (eylem), form kütüphanesi `BDO`, `TKK`, `GSR`,
   `ISG`, `MKS`, teknik onay türleri `MOS`, `NUM`, `UCZ`, `YB`, `IP`, `ISG`, `TR`, `PMR`, `KS`, `IKOF`, `BAS`, `MKF`.
   Hepsi Türkçe kökenli. İngilizce kökenli olanlar yalnız şablonların isimlendirme standartlarındaki ISO 19650 doküman
   tipi kodlarıdır (`DR`, `RP`, `SP`, `SH`, `CO`, `RF`, `RI`, `DE`, `SD`, `CD`, `MC`, `HO`, `M3`); standart oldukları için
   kaldı.
3. **Menü:** "Model" → "Model Görüntüleyici". 11.10.2026 sadeleştirmesiyle (docs/product/SADELESTIRME.md, 1. aşama) menüde yine
   "Model" var; görüntüleyici onun "Görüntüleyici" sekmesi, yanında "Koordinasyon" ve "İş Programı" sekmeleri durur.
4. **Terimler:** "Teknik Onay" ve "Gönderim Formu" kalır.
5. **Büyük harf kuralı:** yukarıda; onay kutusu ve seçenek düğmesi metinleri de Title Case, soru eki mı/mi/mu/mü küçük
   kalır, "ZAVM" numara hazır ayarı `RFI` ile kalır.

## Karar bekleyenler

1. **Teknik ekranlar.** Ofis düzenleyici (WOPI) yönetim ekranındaki "WOPI", "Proof", "JWT", "Discovery" ve editörün
   kendi hata iletileri teknik ad olarak kaldı. Proje ayarları → İş tipleri tablosu iç anahtarı (`rfi`, `aksiyon`,
   `transmittal`) küçük yazıyla göstermeye devam ediyor. Anahtar değişmediği için böyle bırakıldı.
2. **Araştırma ve tarihli belgeler.** `docs/archive/ANALIZ.md`, `docs/archive/research/OPENCDE_ARASTIRMA.md`, `docs/archive/research/FORMA_MODUL_YAPILARI.md`,
   `docs/archive/research/ORNEK_PROJELER_PKF_MBE.md`, `docs/product/KONSEPT.md`, `docs/archive/YOL_HARITASI.md`, QA ve sabah özetleri Forma/ACC modüllerini İngilizce
   adlarıyla anar. Arayüzü anlatmadıkları için değiştirilmedi.
3. **Şablon iskelet boyutları.** Proje şablonlarındaki boyut adları ("Bölge grubu", "Doküman tipi") şablon içi anahtar
   olarak kaldı; sihirbazda bu adla görünür.

- Form kütüphanesindeki Evet/Hayır kontrol maddeleri cümle düzeninde kalır (karar 10.10.2026).
