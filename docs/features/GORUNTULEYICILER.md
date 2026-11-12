# Görüntüleyiciler (DWG, belge, tablo, sunum…)

Dosyalar indirmeden, sistemin içinde açılır. Her şey sunucuda ve tarayıcıda çalışır; internet gerekmez.
Bütün bileşenler açık kaynak ve yeniden dağıtılabilir.

**Ofis dosyaları için sunucuda ek yazılım gerekmez.** Word, OpenDocument metin, PowerPoint ve Excel
dosyaları tarayıcıda açık kaynak kütüphanelerle gösterilir. Sunucuda bir **dönüştürücü** (isteğe bağlı eklenti)
varsa iki şey eklenir: birebir sayfa düzeninde PDF ve eski ikili biçimlerin (.doc, .rtf, .ppt, .pps, .odp) önizlemesi.

## Nasıl çalışır

- Dosya listesinde, dosya çekmecesinde ve arama sonuçlarında **Aç** düğmesi var.
- Hangi görüntüleyicinin açılacağına tek bir kayıt karar verir: `packages/shared/src/viewers.ts`.
- PDF'ler PDF görüntüleyicide (`/p/:pid/view/:vid`), IFC'ler model görüntüleyicide açılır. Bunlar değişmedi.
  PDF görüntüleyicideki **2B Metraj** bağlantısı aynı sayfayı ölçek ve ölçüm araçlarıyla açar ([2B Metraj](2B_METRAJ.md)).
- Diğer her şey `/p/:pid/open/:vid` sayfasında açılır. Önizlemesi olmayan dosyada "Önizleme yok — indir" kartı çıkar.
- Bazı biçimler için sunucu yükleme sonrası bir **önizleme** üretir (iş kuyruğu, sırayla tek iş).
  Durumlar: `pending`, `processing`, `ready`, `failed`, `unavailable` (araç kurulu değil).
- Ofis dosyalarında yüklemeden sonra yalnız **metin** okunur (dönüştürücü gerekmez). Dönüştürücü varsa ardından PDF de yapılır.
- Eski sürümler ilk açıldığında önizlemeleri sıraya alınır.
- Görüntülemek için "görüntüleme" yetkisi yeter. İndirme yetkisi gerekmez.

## Desteklenen biçimler

| Tür | Uzantılar | Tarayıcıda (ek yazılımsız) | Dönüştürücüyle (isteğe bağlı) | Aramaya giren metin |
|---|---|---|---|---|
| PDF | pdf | PDF görüntüleyici (işaretleme) | — | ilk 200 sayfa |
| Word | docx, docm, dotx | Belge görüntüleyici (docx-preview): sayfalar | "Sayfa düzeninde aç (PDF)", işaretleme | XML'den |
| OpenDocument metin | odt, ott | Basit görünüm: başlık, paragraf, liste, tablo, resim | "Sayfa düzeninde aç (PDF)" | XML'den |
| Eski belge | doc, rtf | "Önizleme için dönüştürücü gerekli" + indir | PDF görüntüleyici | PDF'ten (yalnız dönüştürücüyle) |
| PowerPoint | pptx, pptm, ppsx | Slayt görüntüleyici (pptx-renderer) | PDF varsa slaytlar PDF'ten | slaytlar + notlar |
| Eski sunum | ppt, pps, odp | "Önizleme için dönüştürücü gerekli" + indir | Slayt görüntüleyici (PDF) | PDF'ten (yalnız dönüştürücüyle) |
| Tablo | xlsx, xlsm, xlsb, xls, ods, csv, tsv | Tablo görüntüleyici (SheetJS, sunucuda JSON) | "Sayfa düzeninde aç (PDF)" | hücre değerleri |
| Çizim | dwg, dxf | DWG/DXF görüntüleyici | DWG: LibreDWG → DXF | TEXT, MTEXT, öznitelik, leader |
| Görsel | png, jpg, jpeg, gif, webp, bmp, svg, avif | Yakınlaştır/kaydır | — | — |
| Metin | txt, log, json, xml, ini, cfg, conf, yaml, yml, ifcxml, bcf, sql | Satır numaralı metin | — | evet |
| Markdown | md, markdown | Markdown (Sor'daki bileşen) | — | evet |
| Video / ses | mp4, m4v, webm, ogv, mov / mp3, wav, ogg, oga, m4a, aac, flac | HTML5 oynatıcı | — | — |
| E-posta | eml | Başlıklar, düz metin gövde, ek adları | — | evet |
| IFC | ifc | Model görüntüleyici: yürüme, plan, kesit, ölçü (aşağıdaki bölüm) | — | — |

Diğer uzantılar (rvt, nwd, msg, tiff…): "Önizleme yok — indir".

"Sayfa düzeninde aç (PDF)" yalnız PDF hazırsa ya da sunucuda dönüştürücü varsa görünür.
Dönüştürücü yoksa bu düğme hiç çıkmaz; dosya yine tarayıcıda açılır.

### IFC model görüntüleyici

IFC modelleri Model → Görüntüleyici sekmesinde (`/p/:pid/viewer`) açılır. Görünüm tamamen tarayıcıda, That Open
Components/Fragments ve three.js ile çalışır; internet gerekmez. Masaüstünde görünüm küpü ile yörünge, yürüme ve plan
kipleri; kesit, ölçü, görünürlük, X-Işını ve PNG görüntü alma araçları sağdaki çubuktadır. Telefonda **Modeller**,
**Sığdır** ve **Modele Sor** üstte kalır; diğer araçlar **⋯ Diğer** menüsüne taşınır.

Kısayollar:

| Tuş | İşlev |
|---|---|
| `1` / `2` / `3` | Yörünge / Yürüme / Plan |
| `W A S D` veya oklar | Yürüme; `Shift` koşma, `Q`/`E` alçalma/yükselme |
| Çift tık | Yörünge/Plan kipinde o noktaya inip yürümeye başla |
| `F` | Sığdır |
| `K` / `B` | Kesit düzlemi / kesit kutusu |
| `M` | Uzunluk ölç |
| `H` / `I` / `U` | Seçimi gizle / yalnız seçimi göster / tümünü göster |
| `X` / `G` | X-Işını / PNG görüntü al |
| `Enter` | Alan ölçüsünü bitir |
| `Esc` | Yardımı, etkin aracı veya yürümeyi sırayla kapat |
| `?` | Kısayollar |

Yazı alanı veya pencere açıkken kısayollar çalışmaz. Yürümede tuvale tıklamak fare bakışını kilitler; `Esc` bırakır.
Telefonda sol alttaki kol yürütür, ekran sürükleme bakışı değiştirir.

- **Yürüme:** göz yüksekliği zeminden 1,7 m'dir. Aşağı ışın zemini izler; 0,5 m'den yüksek masa/korkuluk zemin sayılmaz.
  Altta zemin yoksa yükseklik korunur. İleri ışın 0,35 m'den yakın duvarda ileri hareketi durdurur; yan ve geri hareket
  sürer. Hız 0,5–6 m/sn'dir.
- **Plan:** üstten ortografik görünür. Katlar model indeksinden, gerekirse IFC `IfcBuildingStorey` verisinden alınır.
  Seçilen katın 1,2 m üstüne, bir üst katın en az 5 cm altına yatay kesit konur. Birden çok modelde katlar ilk modeldendir.
- **Kesit:** `K` açıkken bir yüze çift tıklamak taşınabilir düzlem oluşturur; birden çok düzlem açılıp kapatılabilir.
  `B`, seçim varsa 25 cm paylı seçim kutusu, yoksa tüm model kutusu oluşturur. Kesit dolgusu ağır modellerde kapatılabilir.
- **Ölçü:** uzunluk iki, açı üç tıkla; alan çift tık veya `Enter` ile tamamlanır. Hacim seçili elemanlardan hesaplanır.
  Nokta, kenar ve yüzeye yakalama vardır; sonuçlar m, m², ° ve m³ olarak Türkçe sayı biçiminde gösterilir.
- **Görünürlük:** gizle/yalıt/tümünü göster seçim üzerinde çalışır. X-Işını seçili olmayan elemanları %12 opak yapar.
  Özellikler panelinde IFC sınıfı, kat, GlobalId ve kopyalanabilir özellik değerleri bulunur.

Kesitler ve ölçüler sorun görünümüne ve model seti görünümüne kaydedilir. Görünüm açıldığında geri yüklenir; kayıtta
yoksa mevcut kesit ve ölçüler temizlenir. Kesit düzlemleri sahne koordinatında, ölçüler nokta/değer (hacimde GUID
listesi/değer) olarak saklanır; eski kayıtlarla uyumludur.

**Eğriler.** IFC'deki daire ve yaylar dönüşümde düz parçalara bölünür (web-ifc `CIRCLE_SEGMENTS`).
Tam daire başına **48 parça** kullanılır; yarıçapın en çok %0,25'i kadar içe çöker (r = 4 m'de ≈ 9 mm).
24.10.2026'ya kadar web-ifc'nin varsayılanı 12 idi: dairesel saçak, kafe, büfe gibi yapılar köşeli
çokgen görünüyor, arkalarındaki Revit'in önceden böldüğü elemanlar (ör. kırmızı karkas) düz parçaların
ortasından dışarı taşıyordu. O tarihten önce çevrilmiş bir model ilk açıldığında arka planda yeniden
çevrilir; bu sırada eski hali açık kalır, yenisi bir sonraki açılışta gelir (dönüşüm başarısız olursa
eski hali kalır, tekrar denenmez). Değer sunucuda `CDE_IFC_CIRCLE_SEGMENTS` (12–128) ile değişir;
eğrili elemanların üçgen sayısı değerle doğru orantılıdır (48'de 12'ye göre ≈ 4 kat).

IFC görüntüleyici sınırları:

- Kesit dolgusu Fragments `getSection` sonucuna bağlıdır; desteklenmezse yalnız çizgi, hata halinde yalnız kesme kalır.
- Hizalanmamış çoklu modellerde ikinci modelin kesit çizgisi kayabilir.
- PNG görüntüsünde tuvaldeki ölçü çizgileri çıkar, HTML ölçü etiketleri çıkmaz.
- Kotu olmayan katlar Plan kipinde seçilemez; IFC kot birimi model yüksekliğine göre metre/milimetre olarak kestirilir.
- Yürüme çarpışması tek ileri ışındır; geniş açıyla sürtünme ve alçak kapı üstünü algılamayabilir.
- Telefonda kesit düzlemi çift dokunmaya bağlıdır. Hacim, kapalı olmayan geometrilerde yaklaşık olabilir.

### Görüntüleyici özellikleri

- **Word (docx):** sayfa boyutu ve kenar boşlukları, üst/alt bilgi, tablolar, resimler, dipnotlar, gömülü yazı tipleri.
  Yakınlaştır (−/+, yüzde), **Sığdır** (pencere genişliği), sayfa sayısı, **Belgede ara** (Ctrl+F; Türkçe İ/ı duyarsız,
  tüm eşleşmeler vurgulanır, Enter/↑↓ ile gezilir). Telefonda sayfa ekrana sığdırılarak açılır.
- **OpenDocument metin (odt):** küçük, kendi yazdığımız okuyucu (`apps/web/src/viewers/office/odf.ts`).
  Kalın/italik/altı çizili/renk, bağlantılar (yalnız http/https/mailto), liste, tablo (birleşik hücre), gömülü resim.
  Sayfa düzeni değil, "Basit görünüm". Arama ve yakınlaştırma aynı.
- **Sunum (pptx):** küçük resim şeridi, ileri/geri, ok tuşları (←/→, PageUp/PageDown, Home/End), **Sunum modu** (F; Esc ile çık),
  konuşmacı notları (sunucudaki metin önizlemesinden, dönüştürücü gerekmez). Slaytlar tarayıcıda çizilir: metin biçimleri,
  madde işaretleri, resim, şekil, grup, tablo, grafik, arka plan ve tema renkleri. Dönüştürücünün PDF'i varsa
  önce o gösterilir (birebir); "Tarayıcı görünümü" ile geçilir. "İşaretle" PDF'i işaretleme araçlarıyla açar.
- **Tablo:** sayfa sekmeleri, gizli sayfalar soluk, sabit başlık satırı/sütunu, "İlk satırı sabitle", sütun genişlikleri,
  birleştirilmiş hücreler, Türkçe sayı/tarih (1.234,50 · 15.03.2026 · dd.mm.yyyy biçimi de), sayfada arama, seçili hücrenin tam değeri.
  Satır ve sütunlar sanal çizilir: 50 000+ satır akıcı kayar. Formüller hesaplanmaz; dosyadaki son değer gösterilir.
  Okuma sunucuda SheetJS ile yapılır; LibreOffice gerekmez.
- **DWG/DXF:** kaydır/yakınlaştır, **Sığdır** (çizimin ana gövdesi; uzaktaki başıboş nesneler hariç) ve **Tümünü Göster**,
  katman listesi (ara, aç/kapat, **Tümünü Aç / Tümünü Kapat**), "Yalnız Model Alanı", koyu/açık arka plan, ölçüm araçları
  ve **Bilgi** (aşağıda: "DWG/DXF ölçüm ve inceleme"). Türkçe karakterler için Noto Sans gömülü. Ayrı yüklenen parça
  (lazy chunk); ayrıştırma web worker'da. Eski DXF'lerde kod sayfası (`$DWGCODEPAGE`, ör. ANSI_1254) sunucuda okunur.
  Sunucu her çizimin **2B sahnesini** bir kez hazırlar; hazırsa tarayıcı DXF'i hiç ayrıştırmadan onu açar
  (bkz. [Büyük çizimler: 2B sahne](#büyük-çizimler-2b-sahne)). Civil 3D çizimleri ve okunamayan DWG'ler boş tuval yerine kartla açıklanır.
- **Görsel:** tekerlek/iki parmakla yakınlaştırma, sürükleyerek kaydırma, Sığdır, 1:1.
- **E-posta:** HTML gövde çalıştırılmaz; düz metne çevrilir.

### Yazdır / PDF olarak kaydet

Word, ODT, sunum ve tablo görünümlerinde **Yazdır / PDF** düğmesi var. Tarayıcının yazdırma penceresi açılır;
"PDF olarak kaydet" seçilir. Uygulama gizlenir, yalnız belge basılır.

- Word: her sayfa ayrı kâğıt, belgenin kendi sayfa boyutu (A4, yatay bölümler yatay).
- ODT: A4, 20 mm kenar boşluğu.
- Sunum: her slayt bir sayfa, slayt boyutunda (16:9 ya da 4:3). Grafikler bitince basılır.
  Dönüştürücünün PDF'i açıksa o PDF yeni sekmede açılır; oradan basılır.
- Tablo: "Bu sayfa" ya da "Tüm sayfalar"; A4, dar tablolar dikey, geniş tablolar yatay ve sayfa genişliğine küçültülür.
  Her sayfa (sheet) yeni kâğıtta başlar. Sayfa başına en çok 5 000 satır.

Pencerede açıkça yazar: sayfa düzeni **yaklaşıktır**. Birebir PDF için yönetici sunucuda bir dönüştürücü etkinleştirebilir.

### DWG/DXF ölçüm ve inceleme

Kod: `apps/web/src/viewers/cad/` (arayüz `CadMeasure.tsx`; saf TS modülleri `geometry.ts`, `units.ts`, `measure.ts`,
`snap-index.ts`, `scene-geometry.ts`, `bounds.ts`, `cad-phone.ts`). Testler: `apps/web/test/cad-*.test.ts` (sentetik veri).

- **Araçlar** (biri etkin): **Uzunluk** (iki nokta, ΔX/ΔY ile), **Zincir Uzunluk** (çok parçalı; çift tıklama, Enter ya da
  **Bitir** ile biter), **Alan** (çokgen: alan + çevre), **Açı** (kol ucu → köşe → kol ucu, 0–180°), **Koordinat** (gerçek
  çizim koordinatı) ve **Bilgi** (tıklanan yere en yakın çizginin katmanı ve türü: Çizgi, Çoklu Çizgi, Yay, Daire, Nokta).
  Esc önce çizilen ölçümü, sonra aracı iptal eder; Backspace son noktayı siler. Sürükleme ölçüm sırasında da kaydırır.
- **Sonuç listesi:** sağ üstte (telefonda altta); her satır silinebilir, **Temizle**, **Panoya Kopyala** (düz metin; Clipboard
  API olmayan http adreslerinde de çalışır). Ölçümler gerçek çizim koordinatında tutulur; "Yalnız Model Alanı" ile yeniden
  yüklemede kaybolmaz. Klasörde işaretleme yetkisi varsa Uzunluk, Zincir Uzunluk ve Alan satırlarında **Metraja Ekle**
  ölçümü çizim birimiyle 2B metraja kaydeder ([2B Metraj](2B_METRAJ.md)).
- **Koordinatlar:** dxf-viewer hassasiyet için geometriyi bir başlangıç noktasına (origin) kaydırır; gösterilen koordinata bu
  nokta geri eklenir (UTM gibi 423000 / 4550700 değerleri doğru görünür). Uzunluk ve alan kaydırmadan etkilenmez; alan, büyük
  koordinatlarda hassasiyet kaybı olmasın diye ilk köşeye göre hesaplanır. Sunucunun hazırladığı 2B sahnede başlangıç noktası,
  çizimin sağlam gövdesinin (`robustBounds`, `packages/shared/src/cad-bounds.ts`) merkezidir; 0,0'daki başıboş bir nesne UTM
  geometrisini float32 çözünürlüğüne (≈ 0,5 m) düşüremez.
- **Yakalama** (aç/kapat, tarayıcıda hatırlanır): **Uç Nokta**, **Orta Nokta**, **Merkez** (daire/yay), **Üzerinde** (çizgi
  üzerindeki en yakın nokta); imleçte küçük işaret ve adı görünür. Kaynak, yüklenmiş sahnenin kendisidir (parti başına köşe/indis
  tamponları, blok örnekleri dönüşümleriyle), DXF değil; sahneyi kim üretirse üretsin çalışır. Daire ve yaylar sahnede parçalara
  bölünmüş olduğundan eşit uzunlukta ve sabit açıyla dönen parça dizilerinden yeniden tanınır (merkez + yay orta noktası; iç
  köşeler uç nokta sayılmaz). Dizin ilk araç açılışında kurulur: dünya geometrisi için düzgün ızgara, her blok geometrisi için
  bir yerel ızgara + örnek kutuları ızgarası. 600 000 parça: kurulum < 1 sn, sorgu milisaniyenin altında. Gizli katmanlar
  yakalanmaz. Telefonda dokunma toleransı daha geniştir.
- **Birimler:** `$INSUNITS` / `$MEASUREMENT` sunucunun çizim denetiminden gelir (`dxf` önizlemesinin `meta.cad` alanı, ek indirme
  yok); bu alanı olmayan eski önizlemelerde DXF başlığından okunur (dosyanın yalnız başı akışla okunur, büyük dosya iki kez inmez).
  Gösterim varsayılanı metre, Türkçe biçim ("12,34 m", "56,70 m²", "45,0°"); **Gösterim** seçimi mm / cm / m. "Çizim Birimi:
  mm" etiketi algılanan birimi gösterir; dosya birimsizse metre varsayılır ve yazılır, **Çizim Birimi** seçiminden elle
  değiştirilebilir (mm, cm, m, inç, fit).
- **Sığdır:** sahnedeki köşelerden sağlam sınırlar (`bounds.ts`). Her eksende sıralı değerler, aralığın %1'inden geniş
  boşluklarda kümelere ayrılır; en çok noktalı küme çekirdektir. Çekirdek, komşu kümeye boşluk ikisinin büyük olanının
  boyunun en çok iki katıysa büyür. X ve Y, kalan noktalar üzerinde sırayla, değişiklik kalmayana kadar tekrarlanır. Böylece
  0,0'daki kağıt alanı (layout), −y'deki aynalanmış bloklar ve saçma koordinattaki tek tük nesneler UTM çizimini noktaya
  çevirmez; aynı paftadaki ayrı görünüşler, kesitler, lejant ve antet birlikte kalır. Bırakılan bir küme grubu çekirdeğe yakın
  ağırlıktaysa (iki eş çizim) kesilmez. İlk açılış da bu görünümle olur. **Tümünü Göster** gerçek tam sınırları gösterir.
- **Arka plan:** koyu/açık; renk 7 (beyaz/siyah) iki zeminde de görünür (renk düzeltmesi zemine göre). Ölçüm katmanı renkleri de
  zemine göre seçilir.
- **Telefon (≤ 700px):** çubukta Sığdır ve Katmanlar kalır; Tümünü Göster, araçlar, Yakalama, Arka Plan, Yalnız Model Alanı,
  Panoya Kopyala ve Temizle "⋯ Diğer" menüsüne geçer. Ölçüm dokunarak yapılır; çift dokunma ya da **Bitir** zinciri bitirir.
- **Yapılmayanlar:** *Paftalar* (layout sekmeleri) yok: kağıt alanı nesnelerini layout'a göre ayırmak yükleme yolunu (sahne
  üretimi) ya da dxf-viewer'ı değiştirmeyi gerektirir. *Sorun Olarak Kaydet* yok: dosya önizleme sayfasında görünümden sorun ya da
  işaretleme oluşturma yolu henüz yok. Katmanlarda nesne sayısı yok: sahneden ucuz okunamıyor.

## Büyük çizimler: 2B sahne

Büyük bir DWG, LibreDWG ile 150 MB'ı aşan bir DXF'e dönüşebilir (yüz binlerce blok içi LINE). Bu metni tarayıcıda
ayrıştırmak yavaştır, gigabaytlarca bellek ister, telefonda hiç olmaz. Bu yüzden sunucu, dxf-viewer'ın tarayıcıda
yaptığı işi **bir kez** kendisi yapar ve sonucu saklar:

1. **DXF** (`dxf` önizlemesi): DWG → DXF (LibreDWG) ya da yüklenen DXF. Ardından **onarım** ve **çizim denetimi** (aşağıda).
2. **2B sahne** (`scene` önizlemesi): DXF hazır olunca kendiliğinden sıraya girer. Bir worker thread
   (`apps/server/src/previews/scene-worker.ts`) DXF'i dxf-viewer'ın kendi ayrıştırıcısıyla okur ve `DxfScene`'i
   tarayıcıdakiyle aynı yazı tipleriyle (Noto Sans latin + latin-ext) kurar. Sonuç tek bir ikili dosyadır, gzip'li,
   diğer önizlemelerin yanında (`projects/<proje>/previews/`) saklanır; sürüme bağlıdır, yeni sürüm yeni sahne demektir.
   Veritabanı göçü gerekmez (`version_previews` satırı, `kind = "scene"`). Önceden dönüştürülmüş çizimlerin sahnesi ilk açılışta sıraya girer.
3. **Tarayıcı** (`apps/web/src/viewers/cad/scene-loader.ts`): sahne hazırsa dxf-viewer'ın `workerFactory` seçeneğine
   sahte bir worker verilir. Bu worker DxfWorker'ın mesaj protokolünü (LOAD → PROGRESS → LOAD yanıtı, DESTROY) indirilen
   sahneyle yanıtlar. Görüntüleyici, kendi kuracağı sahne nesnesinin aynısını alır; dxf-viewer'a yama ya da çatal yok.
   Ölçüm ve yakalama gibi araçlar aynı sahneyi okur.

**Sahne dosyası** (`7DSCENE1`): 8 bayt sihirli sözcük, 4 bayt JSON uzunluğu, JSON (biçim sürümü; çizim başlığı:
`$INSUNITS`, `$MEASUREMENT`, `$EXTMIN/$EXTMAX`, `$ACADVER`; sahne: batch'ler, renkli katmanlar, orijin, sınırlar;
tamponların yeri), sonra 8 bayta hizalı `vertices` (Float32), `indices` (Uint16), `transforms` (Float32) tamponları.
Tamponlar **bayt karıştırılmış** (byte shuffle: önce bütün ilk baytlar, sonra ikinciler…) yazılır; gzip kayan noktalı
veriyi böyle yaklaşık iki kat iyi sıkıştırır. Tarayıcı gzip'i yerel olarak açar (`Content-Encoding: gzip`), karıştırmayı geri alır.

**Başlangıç noktası (origin):** dxf-viewer ilk rastladığı köşeyi başlangıç alır; 0,0'da başıboş bir nesne varsa UTM
koordinatlı geometri float32'de ≈ 0,25–0,5 m çözünürlüğe düşer. Sunucu sahneyi kurmadan önce üst düzey nesnelerin
köşe/merkez/yerleşim noktalarından sağlam sınırları (`robustBounds`, Sığdır'ın kullandığı işlev) hesaplar ve başlangıcı o
kutunun merkezine koyar (2,1 MB'lık ölçme paftasında 0,0 yerine x ≈ 389 500, y ≈ 4 546 415).

**Yalnız Model Alanı:** çizimde kâğıt alanı nesnesi varsa sunucu ikinci bir sahne de kurar (`?space=model`); yoksa
iki görünüm aynıdır ve tek sahne kullanılır.

**Görüntüleyici ne yapar** (`apps/web/src/viewers/cad/CadGate.tsx`):

| Durum | Gösterilen |
|---|---|
| Sahne hazır | Sahne indirilir ("İndiriliyor %…"), DXF ayrıştırılmaz. |
| Sahne hazırlanıyor, DXF ≤ 60 MB | DXF eskisi gibi tarayıcıda ayrıştırılır (sahne bitince yeniden yüklenmez). |
| Sahne hazırlanıyor, DXF > 60 MB, bilgisayar | "Hazırlanıyor: Çizim okunuyor / Sahne kuruluyor / Paketleniyor…" kartı; **Ham DXF'i Aç** ile beklemeden açılabilir. |
| Sahne hazırlanıyor, DXF > 60 MB, telefon | Aynı kart, DXF açma düğmesi yok; sahne bitince kendiliğinden açılır. |
| Sahne yapılamadı, DXF > 60 MB, telefon | "Telefonda açılamayacak kadar büyük" kartı, **Tekrar Dene**, **İndir**. |
| Civil 3D | "Civil 3D Çizimi" kartı: "Bu çizim Civil 3D nesneleri içeriyor (hizalama, koridor, yüzey). Açık kaynak dönüştürücü bu nesneleri okuyamaz. Civil 3D'de 'AutoCAD'e Aktar' (EXPORTTOAUTOCAD) ile kaydedip yeniden yükleyin; 3B model için IFC 4.3 olarak dışa aktarın." Altında nesne, Civil 3D sınıfı ve dönüştürücü hatası sayıları, **İndir**. |
| Nesne yok (dönüşüm başarısız) | "Çizim Okunamadı" kartı. |
| Kısmi dönüşüm | Çizim açılır; köşede küçük uyarı ("… bazı nesneleri okuyamadı (N hata)" ya da "Civil 3D nesneleri gösterilemiyor"). |

**Çizim denetimi** (`cadCheck`, `dxf` önizlemesinin `meta.cad` alanı): dwg2dxf'in yazdığı `ERROR` satırları (bütün
stderr boyunca sayılır), DXF'in CLASSES bölümündeki `AECC_*` sınıfları, ENTITIES bölümündeki (model + kâğıt) ve blok
içindeki nesne sayıları, `$INSUNITS` ve `$EXTMIN/$EXTMAX`. AECC sınıfı var ve en çok 5 nesne → `civil3d`; hiç nesne yok →
`empty`; nesne var ama 100 ve üstü dönüştürücü hatası (birkaç düzine zararsız hata olağandır) ya da AECC sınıfı → `partial`; yoksa `ok`. `civil3d` ve `empty` için sahne kurulmaz.

**Onarım** (`DxfPairRepair`, `repairDxfFile`): DXF satır satır, akış olarak okunur (latin1; baytlar aynen kalır). Grup kodu
olması gereken satır tam sayı değilse, ya da tam sayı olup ardından gelen değer o kodun türüne uymuyorsa (sayı beklenirken
metin gibi), satır önceki değerin devamıdır: MTEXT metninde (kod 1 ve 3) `\P` (paragraf), diğerlerinde boşlukla eklenir.
Birleştirilen satır sayısı `meta.repairs`'ta. Hızlı yol: denetim (zaten her DXF'i satır satır okur) kod satırlarının hepsini tam sayı
bulursa onarım hiç çalışmaz; yüklenen DXF olduğu gibi (`original: true`), dönüştürülen DXF yeniden yazılmadan saklanır.
Hem ham DXF yolu hem 2B sahne onarılmış DXF'ten çalışır. LibreDWG 0.13 çıktılarında ölçülen: 12 MB DXF'te 107, 17 MB'ta 1, 171 MB'ta 98
birleştirme; onarımdan sonra üçü de dxf-viewer'ın ayrıştırıcısıyla okunur ve ayrıştırıcının saydığı nesneler 0.14 çıktısınınkiyle
aynıdır (10 179 / 21 084 / 541 üst düzey, 20 509 / 2 892 / 581 825 blok içi). 0.14 çıktılarında onarım gerekmez.

**Neden That Open Fragments değil?** Fragments, IFC'den gelen **3B BIM ağları** (mesh, eleman kimlikleri, özellikler)
için yapılmış bir biçimdir; IFC görüntüleyici onu kullanır. 2B çizimde ağ yok: çizgiler, yazı üçgenleri, blok örnekleri ve
katman renkleri var. Bunların doğal biçimi dxf-viewer'ın kendi sahnesidir. 2B sahne, Fragments'ın 2B karşılığıdır:
bir kez sunucuda üretilen, sürüme bağlı, sıkıştırılmış ve doğrudan yüklenen türev.

**Ölçümler** (ARM dizüstü, Node 24, worker thread; LibreDWG 0.14 çıktıları; gerçek proje çizimleri yalnız yerelde ölçüldü):

| DWG | DXF | Denetim (onarım gerekmedi) | Ayrıştırma | Sahne kurma | Paketleme + gzip | Sahne (açık → gzip) | Yalnız model |
|---|---|---|---|---|---|---|---|
| 22,6 MB, AC1021 (≈ 580 000 blok içi LINE) | 173 MB | 3,1 s | 4,5 s | 1,6 s | 2,3 s (iki sahne) | 34,2 → 17,2 MB | 29,2 → 15,1 MB |
| 2,1 MB, AC1027 (UTM, metre) | 17,4 MB | 0,2 s | 0,3 s | 0,4 s | 0,6 s (iki sahne) | 32,9 → 11,3 MB | 2,2 → 0,9 MB |
| 1,6 MB, AC1032 | 12,1 MB | 0,1 s | 0,3 s | 0,5 s | 0,2 s | 9,6 → 4,2 MB | — (kâğıt alanı yok) |
| 6,4 MB Civil 3D, AC1024 | 0,15 MB, ENTITIES boş | < 0,1 s | — | — | — | Civil 3D kartı | — |

DWG → DXF (dwg2dxf) bunlardan ayrıdır: en büyük çizimde ≈ 17 s. Denetim kod satırlarında tam sayı olmayan satır bulursa onarım
çalışır (LibreDWG 0.13 çıktısı: 171 MB'ta + 5,3 s, 12–17 MB'ta + 0,3–0,5 s); 0.14 çıktılarında gerekmez. Tarayıcı 173 MB metin yerine 17 MB indirir ve hiçbir şey
ayrıştırmaz. DXF'in kendisi gzip'le ≈ 14 MB olurdu, ama tarayıcıda ayrıştırılması saniyeler ve gigabaytlarca bellek ister.
Bayt karıştırma olmadan aynı 2,1 MB'lık çizimin sahnesi gzip'le 21,0 MB tutuyordu (şimdi 11,3 MB). Sahne, yazıları üçgen
olarak taşıdığı için yazısı bol çizimlerde DXF'ten büyük olabilir.

## Yapay zekâ kancası

- Önizleme işleri dosyanın metnini `version_texts` tablosuna yazar (sürüm başına en fazla 200 000 karakter).
- Ofis dosyalarında bu iş `text` önizlemesidir: docx/docm/dotx, pptx/pptm/ppsx (slaytlar + notlar), odt/ott/odp metni
  XML parçalarından okunur. **Dönüştürücü gerekmez.** Notlar önizlemenin `meta.notes` alanına da yazılır (slayt görüntüleyici).
- Proje araması (`GET /projects/:pid/search?q=`) artık güncel sürümün **içeriğinde** de arar. Sonuçta kısa bir `snippet` döner.
- "Sor" asistanının `cde_search_files` aracı aynı aramayı kullanır; eşleşen parçayı `match` alanında görür.
- Eski ikili biçimlerin (.doc, .ppt, .rtf) metni yalnız dönüştürücü varsa, PDF'ten okunur.
- Test: `apps/server/test/viewers.test.ts` → "works without any converter…" (dönüştürücü yokken docx/pptx/odt araması ve notlar).

## Bileşenler ve lisanslar

| Bileşen | Sürüm | Lisans | Nerede | Not |
|---|---|---|---|---|
| docx-preview | 0.4.1 | Apache-2.0 | web (lazy) | Word görüntüleyici. Gömülü HTML (altChunk) kapalı; `javascript:` bağlantıları silinir. |
| @aiden0z/pptx-renderer | 1.3.0 | Apache-2.0 | web (lazy) | PowerPoint görüntüleyici. Değiştirilmeden kullanılır. İçinde değiştirilmemiş `mtx-decompressor` (MPL-2.0, dosya bazlı; gömülü yazı tipi açma) var; lisans metni pakette. |
| Apache ECharts (+ ZRender) | 6.1 | Apache-2.0 (ZRender: BSD-3-Clause) | web (lazy) | pptx-renderer'ın grafik çizimi. |
| JSZip | 3.10.1 | MIT (MIT ya da GPL-3.0 seçimli; MIT seçildi) | web (lazy) | docx/odt/pptx ZIP okuma. Zaten vardı (@thatopen). |
| SheetJS Community Edition (`xlsx`) | 0.20.3 | Apache-2.0 | sunucu | npm'deki `xlsx` 0.18.5 eski ve bilinen açıkları var. Resmî paket `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` adresinden kurulur (package-lock'ta bu adres). |
| dxf-viewer | 1.0.49 | MPL-2.0 | web (lazy) | Değiştirilmeden kullanılır. MPL dosya bazlıdır; kendi kodumuzu etkilemez. |
| That Open Components (`@thatopen/components`, `@thatopen/components-front`, `@thatopen/fragments`) | 3.4 | MIT | web | Model görüntüleyici. Tuvaldeki That Open yazısı resmî `showLogo = false` ayarıyla kapalı; atıf Hesabım → Hakkında'da ve görüntüleyicinin Kısayollar penceresinde: "Görüntüleyici That Open Company açık kaynak bileşenleriyle (MIT) çalışır." |
| three.js | 0.186 | MIT | web | Zaten vardı (IFC). |
| opentype.js | 1.3.x | MIT | web | dxf-viewer bağımlılığı. |
| Noto Sans (`@fontsource/noto-sans`) | 5.x | OFL-1.1 | web | latin + latin-ext WOFF; DXF yazıları. |
| pdf.js (`pdfjs-dist`) | 6.3 | Apache-2.0 | web | Zaten vardı; slayt görüntüleyici de kullanır. |
| ONLYOFFICE Docs / Collabora Online / Gotenberg | — | AGPL-3.0 / MPL-2.0 / MIT | ayrı servis, **isteğe bağlı** | Dönüştürücü eklentisi (compose profili). Bkz. OFIS_ENTEGRASYONU.md. Görüntüleme için gerekmez. |
| LibreOffice (soffice) | 7.x+ | MPL-2.0 | sunucu, ayrı süreç, **isteğe bağlı** | Son çare yerel dönüştürücü; Docker imajında yok. Görüntüleme için gerekmez. |
| LibreDWG `dwg2dxf` | 0.14 | GPL-3.0-or-later | sunucu, ayrı süreç | Bkz. aşağıdaki not. 0.14 ve üstü gerekli. |

**LibreDWG (GPL) notu:** dwg2dxf ayrı bir programdır. Sunucu onu yalnızca komut satırından çağırır
(dosya girer, DXF çıkar); kütüphane olarak bağlanmaz. Bu "bir araya getirme"dir (aggregate); SiteKeep kodu GPL olmaz.
Docker imajı dwg2dxf ikilisini içerdiği için, imajı müşteriye verirken GPL gereği LibreDWG kaynağına erişim
sağlanmalı: imajdaki sürüm `LIBREDWG_VERSION` (varsayılan 0.14), kaynak `https://ftp.gnu.org/gnu/libredwg/`.

**LibreDWG 0.14 ve üstü gerekli.** 0.13, MTEXT/TEXT/öznitelik değerlerini (yazı tipi kodlu olanları) satır sonlarıyla
bölerek yazar; DXF'in kod/değer satır çiftleri kayar ve tarayıcı "Cannot parse group code" hatasıyla durur.
Sunucu her DXF'i bir **onarım geçişinden** geçirir (bkz. 2B sahne bölümü); 0.13 çıktıları da açılır, ama bölünmüş yazılar
birleştirilmiş olur ve 0.13 bazı çizimlerde 0.14'ün okuduğu nesneleri okumaz. Onarım gereken her dönüşümde sunucu günlüğe
not düşer; `dwg2dxf --version` sürüm numarası veriyorsa 0.14'ten eskisi için ilk dönüşümde uyarı da yazar (bazı derlemeler
yalnız git kimliği yazar, onlarda yalnız onarım notu çıkar).
LibreDWG istenmezse `--build-arg WITH_LIBREDWG=0`; DWG'ler o zaman "önizleme aracı yok" durumunda kalır, DXF'ler açılır.

**Seçilmeyenler (sunum):** `pptx-preview` npm'de ISC yazıyor ama kaynak kodu açık değil; yazarın koşulu kaynağın
yayımlanmasını yasaklıyor, yani açık kaynak değil. `@jvmr/pptx-to-html` (MIT) denendi: bir metin kutusunda tek yazı
biçimi kullanıyor (kalın/renkli tek madde bütün kutuyu boyuyor). PPTXjs ve pptx2html eski ve jQuery'ye bağlı.

**Seçilmeyenler (DWG):** `@mlightcad/libredwg-web` (LibreDWG'nin WASM derlemesi) tarayıcı paketine GPL kod katardı;
web paketini GPL ile karıştırmamak için seçilmedi. Ticari DWG SDK'ları (ODA vb.) açık kaynak değil.

## Kurulum

### Ofis → PDF dönüştürücü

Görüntüleme için hiçbir şey kurmak gerekmez. Dönüştürücü **isteğe bağlı** bir eklentidir: birebir sayfa düzeninde PDF
("Sayfa düzeninde aç (PDF)", işaretleme) ve eski .doc/.rtf/.ppt/.pps/.odp önizlemesi için.
Yönetici seçer: **Yönetim → Office entegrasyonu**. Ayrıntı: [docs/features/OFIS_ENTEGRASYONU.md](OFIS_ENTEGRASYONU.md).
Dönüştürücü seçiliyse yüklenen ofis dosyalarının PDF'i kendiliğinden yapılır; "Sayfa düzeninde aç (PDF)" düğmesi o zaman görünür.

| Seçenek | Nasıl çağrılır | Not |
|---|---|---|
| Otomatik (varsayılan) | Editör ayarlıysa onun sunucusu, değilse bu sunucudaki soffice | Hiçbiri yoksa PDF yapılmaz; dosyalar yine tarayıcıda açılır. |
| ONLYOFFICE | ConvertService API, JWT | ONLYOFFICE dosyayı CDE'den tek kullanımlık adresten indirir. |
| Collabora | `POST /cool/convert-to/pdf` | CDE sunucusuna `net.post_allow` ile izin verilmeli. |
| Gotenberg | `POST /forms/libreoffice/convert` | Yalnız dönüştürür. MIT lisanslı. |
| Yerel soffice | `soffice --headless --convert-to pdf` | Son çare; yalnız sunucuda kurulu ise. |

- Docker imajında **LibreOffice yok**. Dönüştürme için compose profillerinden birini açın
  (`--profile onlyoffice`, `--profile collabora` ya da `--profile gotenberg`).
- Dönüştürücü yoksa PDF kuyruğa alınmaz; docx/odt/pptx/xlsx tarayıcıda açılır. Ulaşılamıyorsa PDF `failed`/`unavailable`
  olur; yönetici bağladıktan sonra "Sayfa düzeninde aç (PDF)" ya da **Tekrar dene** yeterli.
- Metin araması dönüştürücüye bağlı değil: docx/pptx/odt metni ve sunum notları XML'den okunur.
- Süre sınırı, en büyük dosya, aynı anda dönüşüm sayısı ve tekrar deneme yönetim sayfasından ayarlanır.

### Docker

`docker compose build` yalnız LibreDWG'yi imaja ekler (DWG → DXF).

- `--build-arg WITH_LIBREDWG=0`: LibreDWG olmadan.
- `--build-arg LIBREDWG_VERSION=…`: başka LibreDWG sürümü (0.14 ve üstü).

### Windows (geliştirme / tek sunucu)

1. Ofis PDF için ya bir dönüştürücü servisi bağlayın ya da son çare olarak LibreOffice kurun:
   `winget install TheDocumentFoundation.LibreOffice`. `C:\Program Files\LibreOffice\program\soffice.exe` kendiliğinden bulunur.
2. LibreDWG: LibreDWG'nin GitHub sürüm sayfasındaki Windows (win64) paketini açın. `CDE_DWG2DXF_PATH` ile `dwg2dxf.exe` yolunu verin.
3. Sunucuyu yeniden başlatın. Günlükte `viewers: soffice …, dwg2dxf …` satırı bulunan yolları gösterir.

### Linux

```sh
# LibreDWG kaynaktan (Debian/Ubuntu paketinde yok):
curl -fsSL https://ftp.gnu.org/gnu/libredwg/libredwg-0.14.tar.xz | tar -xJ
cd libredwg-0.14 && ./configure --disable-bindings --disable-shared && make -j && sudo make install-strip
```

### Ortam değişkenleri

| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `CDE_OFFICE_CONVERTER`, `CDE_OFFICE_CONVERTER_URL` | `auto`, boş | Dönüştürücü varsayılanı (yönetim sayfası önceliklidir). Bkz. OFIS_ENTEGRASYONU.md. |
| `CDE_SOFFICE_PATH` | kurulum yolları, sonra PATH | Son çare soffice yolu. Verilip dosya yoksa "araç yok" sayılır. |
| `CDE_DWG2DXF_PATH` | kurulum yolları, sonra PATH | dwg2dxf yolu. |
| `CDE_CONVERT_TIMEOUT_MS` | 180000 | Tek dönüşümün varsayılan süre sınırı. Aşılırsa önizleme `failed`. |

Yerel soffice ve dwg2dxf her dönüşümde kendi geçici klasöründe çalışır; aynı anda tek dönüşüm yapılır.
Yönetici durumu `GET /api/v1/admin/converters` ile de görür (`office` alanı: etkin dönüştürücü).

## API

| Uç nokta | Ne yapar |
|---|---|
| `GET /projects/:pid/versions/:vid/preview` | Görüntüleyici türü, önizleme durumları (eksikleri kuyruğa alır) ve `pdfConverter` (sunucu ofis PDF'i yapabilir mi). |
| `POST /projects/:pid/versions/:vid/preview/:kind` | Önizlemeyi iste / tekrar dene (`pdf`, `sheet`, `dxf`, `scene`, `text`). |
| `GET /projects/:pid/versions/:vid/preview/:kind` | Önizlemenin kendisi (PDF, gzip JSON, DXF, 2B sahne, düz metin). `scene`: `Content-Encoding: gzip`, `ETag` + `Cache-Control: private, no-cache` (tarayıcı 304 ile yeniden doğrular), `X-Scene-Bytes` (açılmış boyut, ilerleme için), `?space=model` yalnız model alanı. |
| `GET /projects/:pid/versions/:vid/pdf` | PDF görüntüleyici için PDF: dosyanın kendisi ya da ofis dosyasının PDF'i. |
| `GET /projects/:pid/versions/:vid/media` | Görsel/video/ses/metin içeriği ve tarayıcıda çizilen ofis dosyaları (docx, odt, pptx), `Range` destekli. |
| `GET /admin/converters` | Ofis dönüştürücü, soffice ve dwg2dxf durumu (yönetici). |

Veritabanı: `version_previews` (sürüm × tür: durum, dosya, hata, meta) ve `version_texts` (arama metni).
IFC'nin `file_versions.derivative_*` alanlarına dokunulmadı. Göç: `apps/server/drizzle/0017_viewers.sql`.

## Sınırlar

- Tablo: en çok 2 milyon hücre, sayfa başına 200 000 satır ve 1000 sütun; fazlası kesilir ("sınırda kesildi").
  Hücre rengi, kenarlık, koşullu biçim, grafik ve resim gösterilmez. Formül yeniden hesaplanmaz.
- Excel'in "sabitlenmiş bölmeleri" okunmaz; bunun yerine "İlk satırı sabitle" düğmesi var.
- Sunum notları yalnız pptx'ten okunur.
- DWG/DXF: yalnız model alanı ve "kağıt alanını gizle" var; tek tek layout seçimi yok. SHX yazı tipleri yerine Noto Sans.
  DWG desteği LibreDWG'ye bağlı (R2000–R2018 çoğunlukla okunur; bazı yeni nesneler eksik kalabilir). İkili (binary) DXF'te metin araması yok.
  Ölçüm ve yakalama çizilen geometriden yapılır (aşağıya bakın); paftalar (layout) tek tek seçilemez.
  Civil 3D nesneleri (hizalama, koridor, yüzey…) açık kaynak araçlarla okunamaz; bu çizimler kartla açıklanır.
- Görsel: TIFF ve HEIC tarayıcıda açılmaz. Video/ses tarayıcının desteklediği codec'lerle sınırlı.
- E-posta: .msg desteklenmez. Ekler açılmaz, yalnız adları listelenir.
- Metin görüntüleyici dosyanın ilk 2 MB'ını / 50 000 satırını gösterir.
- Word (tarayıcı): sayfalar Word'ün kaydettiği sayfa sonlarından ve elle konmuş sayfa sonlarından gelir; tarayıcı kendisi
  sayfalamaz. Bu yüzden sayfa sayısı yaklaşıktır, uzun bölüm baskıda sonraki kâğıda taşar. Alan kodları (sayfa no) dosyadaki
  son değeri gösterir. İzlenen değişiklikler ve yorumlar gösterilmez. Yazı tipi bilgisayarda yoksa benzeriyle çizilir.
- ODT (tarayıcı): basit görünüm; sayfa düzeni, üst/alt bilgi, dipnot, metin kutusu konumu yok.
- Sunum (tarayıcı): animasyon ve geçiş yok, video/ses oynatılmaz. Gömülmemiş yazı tipleri farklı görünebilir.
  60 MB üstü Word ve 80 MB üstü sunum "Dosya büyük" kartıyla sorulur (tarayıcı belleği).
- Tarayıcı baskısı yaklaşıktır. Birebir sonuç dönüştürücünün PDF'idir; o da sunucuya kurulu yazı tiplerine bağlıdır.

## Test

`npm test` LibreOffice ya da LibreDWG gerektirmez: dönüştürücüler sahte süreçle (mock) denenir
(başarı, zaman aşımı, araç yok, hata, Civil 3D). Testler `apps/server/test/viewers.test.ts`, `apps/server/test/cad-scene.test.ts`
(DXF onarımı, çizim denetimi, 2B sahne: tarayıcının kurduğu sahneyle bayt bayt aynı mı, yükleme yolu kararı) ve `packages/shared/test/viewers.test.ts`.
Testlerdeki çizimler yapaydır (blok içinde binlerce LINE, AECC sınıflı boş çizim); gerçek proje çizimi depoya girmez.
Web yardımcıları (ODT okuyucu, belgede arama, baskı ölçüleri) `apps/web/test/` altında, kökteki `npm test` ile çalışır.
