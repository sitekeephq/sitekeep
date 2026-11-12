# Metraj Envanteri

IFC modelinin eleman bazlı metrajı ve aynı modelin iki versiyonu arasındaki metraj farkı. Miktarlar modelden okunur;
yapay zekâ hesap yapmaz, aynı model hep aynı sayıyı verir.

## Nereden Açılır

- **Planlama ve Analiz → Metraj**.
- Adres biçimi: `/projects/<proje>/quantities?v=<versiyon>&from=<eski versiyon>&g=class,storey`.
  - `v` yoksa ilk IFC modelinin güncel versiyonu açılır.
  - `from` verilirse fark görünümü açılır.
  - `g` gruplamadır.

## Ekran

- **Model / Versiyon / Karşılaştır** seçimleri. "V<n> İle Karşılaştır" bir önceki versiyonu seçer.
- **Gruplama:** Sınıf, Kat, Tip, Malzeme (en çok üçü birlikte). Katlar alttan üste, diğerleri alfabetik sıralanır.
  Değeri olmayanlar "Katsız", "Tipsiz", "Malzemesiz" grubuna düşer.
- **Toplamlar:** eleman sayısı, net hacim, net alan, boşluk, uzunluk ve miktarı olmayan eleman sayısı.
- **Grup tablosu:** adet, net hacim (m³), brüt alan, boşluk, net alan (m²), uzunluk (m), ağırlık (kg).
  - Satır açılınca grubun elemanları ve her değerin okunduğu özellik (ör. `Qto_WallBaseQuantities.NetSideArea`) görünür.
  - Boşluğu olan elemanın Boşluk hücresinde boşluk adedi ("2 Boşluk"), ölçülemeyen boşluk ve model kendi brüt − net
    değerini farklı veriyorsa "Model: … m²" yazar. Üzerine gelince kapı / pencere adları görünür.
- Toplamların altındaki not boşluğun nereden geldiğini söyler (geometri ya da brüt − net), farklı çıkan ve ölçülemeyen
  boşlukları sayar.
  - "Modelde Göster" görüntüleyicide grubun elemanlarını seçer (ilk 300).
- **Fark görünümü:**
  - Toplamlar eski → yeni ve fark.
  - Değişen gruplar: en büyük değişiklik üstte. Eklenen / silinen / değişen eleman sayısı ve ölçü farkları gösterilir.
  - Değişen elemanlar: eklendi, silindi ya da miktarı değişti. Silinen eleman eski versiyonda açılır.
- **Excel'e Aktar:**
  - Envanter: "Metraj Özeti" ve "Elemanlar" sayfaları. Elemanlar sayfasında GlobalId, boşluk adedi, modelin kendi
    boşluk alanı ve kaynak özellik var.
  - Fark: "Metraj Farkı" ve "Değişen Elemanlar" sayfaları; her ölçü için eski / yeni / fark.

## Miktarlar Nasıl Okunur

Kaynak, IFC'nin temel miktar setleridir: `Qto_*` (IFC4) ve `BaseQuantities` (IFC2x3, Revit).

| Ölçü | Okunan miktar |
| --- | --- |
| Net / brüt hacim | `NetVolume`, `GrossVolume`; ikisi de yoksa `Volume` |
| Net / brüt alan | Duvarda `NetSideArea` / `GrossSideArea`; döşeme vb. `NetArea` / `GrossArea`; yoksa `NetFootprintArea` / `GrossFootprintArea`; hiçbiri yoksa `Area` (net) |
| Boşluk | geometriden ölçülen boşluklar (aşağıda); boşluğu olmayan elemanda brüt alan − net alan (ikisi de varsa) |
| Uzunluk | `Length` |
| Ağırlık | `NetWeight`, yoksa `GrossWeight`, yoksa `Weight` |

- Temel miktar setinde olmayan hacim, alan ve uzunluk Revit'in `Dimensions` setinden okunur.
- Sayı olarak yazılmış uzunluk, alan ve hacim modelin birimiyle (`IfcUnitAssignment`: mm, cm, ft …) metreye çevrilir.
  Birimi metinde yazan değerler ("3,5 m") olduğu gibi okunur.
- Mahaller (IfcSpace) ve boşluk elemanları (IfcOpeningElement) sayılmaz.
- Fark GlobalId ile bulunur. 0,0005'ten küçük farklar değişiklik sayılmaz.
- Eleman başka gruba geçtiyse (kat, tip ya da malzeme değiştiyse) değişmiş sayılır.

## Boşluklar

Kapı, pencere ve şaft boşlukları modelin geometrisinden ölçülür; exporter'ın net alanı düşüp düşmediğine bakılmaz.

- İndeks her `IfcRelVoidsElement` için boşluğu (`IfcOpeningElement`), onu dolduran kapı / pencereyi
  (`IfcRelFillsElement`) ve gövde geometrisini yazar.
- Okunan geometri: `IfcExtrudedAreaSolid` (doğrudan, `IfcMappedItem` içinden ya da `IfcBooleanClippingResult`'ın ilk
  parçası). Kesitler: dikdörtgen, yuvarlatılmış dikdörtgen, daire, elips, `IfcPolyline` / `IfcIndexedPolyCurve` ile
  çizilmiş kapalı kesit (iç boşluklar düşülür). Diğerleri "ölçülemedi" sayılır ve düşülmez.
- Boşluğun yüz alanı: kesitin iki kenarı ile ekstrüzyon boyundan, eleman kalınlığına en yakın (kalınlığın %90'ından
  kısa olmayan) en kısa boyut "içinden geçen" yön sayılır; kalan iki boyutun alanı düşülür. Böylece duvar yüzünde
  çizilip duvarı delen boşluk da, Revit'in planda çizip yukarı çektiği pencere boşluğu da doğru ölçülür.
- Kalınlık `Width` / `Thickness` miktarından, yoksa brüt hacim / brüt alandan bulunur. Düşülen alan brüt alanı geçemez.

| Modelde olan | Sonuç |
| --- | --- |
| Brüt alan | net = brüt − geometrik boşluk |
| Yalnız net alan (ör. Revit `Dimensions.Area`) | brüt = net + geometrik boşluk |
| Brüt hacim, net hacim yok | net hacim = brüt hacim − boşluk alanı × kalınlık |
| Net hacim | olduğu gibi kalır |

- Modelin kendi brüt − net değeri "Model: … m²" olarak saklanır; ölçülen boşluktan 0,01 m²'den fazla farklıysa eleman
  "farklı" sayılır.
- Kaynak sütununda geometriye dayanan değerler "Brüt − Geometrik Boşluk", "Net + Geometrik Boşluk" gibi yazılır.
- Boşluk okumadan önce yazılmış bir indeks ilk açılışta bir kez yeniden hazırlanır (409, "boşluk ölçüleriyle yeniden
  hazırlanıyor"). Yeniden hazırlanamazsa sayfa brüt − net ile açılır ve not bunu söyler.
- İki versiyon karşılaştırılırken boşluk geometriden yalnız ikisinin de indeksinde varsa düşülür; aksi halde ikisi de
  brüt − net ile hesaplanır. Yeniden işlenen versiyon sahte fark göstermez.
- Poz Öner ve 5B maliyet kuralları özelliklerin dışa aktarılan değerini kullanmayı sürdürür.

## Sor / MCP

`cde_quantity_inventory`:

- Proje ve versiyon (ya da dosya adının bir parçası) verilir; isteğe bağlı gruplama yapılır.
- `compareWithPrevious` bir önceki versiyonla farkı, `compareFromVersionId` seçilen versiyonla farkı verir.
- Sor asistanı "metraj", "m³", "hacim", "net alan", "boşluk" sözcüklerinde bu aracı seçer.
- Envanter yanıtında `openings` özeti vardır: kaynak (`geometry` / `model`), boşluklu eleman, boşluk, ölçülemeyen ve
  farklı çıkan eleman sayısı.

## API

| Uç | Ne yapar |
| --- | --- |
| `GET /projects/:pid/versions/:vid/quantities?groupBy=` | Toplamlar ve gruplar |
| `GET …/quantities/elements?groupBy=&group=&limit=` | Bir grubun (ya da tüm modelin) elemanları, en çok 5000 |
| `GET …/quantities/diff?from=&groupBy=` | `from` → `vid` farkı; değişen elemanlar en çok 2000 |
| `GET …/quantities/export?groupBy=&from=` | Excel |

## Yetki

- Modelin klasörünü görebilen herkes okur. Görmeyen için uçlar 404 döner.
- Yazma yoktur.

## Sınırlar

- **Geometriden ölçüm yok.** Miktarı olmayan eleman yalnız adet olarak sayılır ve "Miktarı Olmayan" uyarısı çıkar.
  Revit'te "Export base quantities" açık dışa aktarılmalıdır.
- **Boşluk geometrisi yalnız ekstrüzyondan okunur.** B-rep, CSG ya da süpürme ile çizilmiş boşluklar "ölçülemedi"
  sayılır ve düşülmez. Eğik (duvara dik olmayan) boşlukta yüz alanı kesitten hesaplanır, eğim düzeltilmez.
- Boşluk duvarın tek yüzü için düşülür (`GrossSideArea` tek yüzdür). Duvarı tam delmeyen niş de boşluk sayılır.
- Ağırlık birimi çevrilmez (kg varsayılır).
- Eski biçimli indekslerde ilk açılışta indeks yeniden hazırlanır (409); sayfa kendiliğinden yenilenir.

## Poz Öner

Planlayıcı için Metraj sayfasında **Poz Öner** düğmesi vardır. Seçili versiyonun eleman gruplarına birim fiyat önerir; onaylananlar
maliyet kuralı olur. Ayrıntı: [POZ_ONERI.md](POZ_ONERI.md).

## 2B Çizim

Metraj sayfasının **2B Çizim** sekmesi PDF ve DWG/DXF çizimlerini grup toplamlarıyla listeler. PDF sayfası kalibre edilip
uzunluk, alan (boşluk düşülerek) ve adet ölçülür; DWG/DXF ölçümleri CAD görüntüleyiciden **Metraja Ekle** ile gelir.
Ayrıntı: [2B_METRAJ.md](2B_METRAJ.md).

## Onay ve Hakedişe Aktarma

Proje yöneticisi 3B envanteri ya da bir çizimin 2B toplamlarını **Metrajı Onayla** ile numaralı bir onaya çevirir
(**Onaylar** sekmesi). Onaydaki gruplar sözleşmenin **Metraj Bağları** sekmesinde kalemlere bağlanır ve hakediş
**Onaylı Metrajdan Doldur** ile doldurulur. Ayrıntı: [METRAJ_ONAYI.md](METRAJ_ONAYI.md).
