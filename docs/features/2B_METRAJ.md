# 2B Metraj

PDF ve DWG/DXF çizimlerinden uzunluk, alan ve adet metrajı. PDF sayfası iki noktalı bir referans çizgiyle
kalibre edilir; DWG/DXF'te ölçek çizim biriminden gelir. Ölçümler gruplanır, grup toplamları alınır, istenirse
bir birim fiyata (5D maliyet kalemi) bağlanıp tutarlandırılır ve Excel'e aktarılır.
İlke: noktalar çizimin kendi biriminde saklanır, miktar her okumada sayfa ölçeğinden yeniden hesaplanır. Ölçek
düzeltilirse o sayfadaki bütün ölçümler kendiliğinden düzelir.

## Nereden Açılır

- **PDF görüntüleyici** → **2B Metraj** (açık sayfayla).
- **Metraj** sayfası → **2B Çizim** sekmesi (`/projects/:pid/quantities?mode=2d`): görebildiğiniz PDF, DWG ve
  DXF çizimlerinin güncel versiyonları ve grup toplamları. PDF için **Ölç**, DWG/DXF için **CAD Görüntüleyicide Ölç**.
- Doğrudan adres: `/projects/:pid/takeoff/:versionId`.
- **CAD görüntüleyici** (DWG/DXF) → ölçüm sonuç listesinde **Metraja Ekle**.

## PDF'te Ölçüm

1. **Ölçek:** ölçüsü bilinen bir çizginin (ölçü çizgisi, aks aralığı) iki ucuna tıklayın, gerçek uzunluğu metre
   olarak girin (`5` ya da `2,5`). Sayfanın ölçeği "1 birim = x m" olarak saklanır; referans çizgi mavi kesikli
   gösterilir. Her sayfanın ayrı ölçeği vardır. Ölçek silinirse o sayfadaki uzunluk ve alanlar "ölçeksiz" kalır.
2. **Uzunluk:** noktalara tıklayın; Enter, çift tıklama ya da **Bitir** ile tamamlayın (açık çoklu çizgi).
3. **Alan:** köşelere tıklayın; Enter, çift tıklama ya da **Bitir** ile kapatın. **Düşülecek Alan (Boşluk)**
   işaretliyse alan grubunda eksi sayılır (pencere, kapı, şaft).
4. **Adet:** saydığınız her öğeye tıklayın; Enter ya da **Bitir** ile tek ölçüm olarak kaydedilir (nokta sayısı = adet).

- Araç çubuğundaki **Grup** (önceki gruplar önerilir), **Poz** (5D birim fiyat; İş Programı modülü açıksa) ve
  **Renk** yeni ölçümlere uygulanır.
- Esc çizimi, ikinci Esc aracı bırakır; Backspace son noktayı geri alır; PageUp/PageDown sayfa çevirir.
- Çizim sırasında canlı değer ipucu çubuğunda görünür. Sayfa ölçeklenmemişse "Ölçek Yok" uyarısı çıkar; ölçüm yine
  kaydedilir, miktarı ölçek gelince hesaplanır.
- Telefonda dokunarak ölçülür; yan panel **Metraj (n)** düğmesiyle alttan açılır.

## DWG/DXF'te Ölçüm

CAD görüntüleyicinin **Uzunluk**, **Zincir Uzunluk** ve **Alan** sonuçlarında **Metraja Ekle** görünür
(klasörde işaretleme yetkisi varsa). Noktalar gerçek çizim koordinatlarında kaydedilir; ölçek olarak dosyanın
birimi (`$INSUNITS`) ya da kullanıcının seçtiği çizim birimi "Çizim Birimi" yöntemiyle sayfa 1'e yazılır.
Kalibrasyonla belirlenmiş bir ölçek varsa çizim birimi onu ezmez. Sayfada ölçüm varken çizim birimini değiştirmek 409 döner
(mevcut ölçümlerin anlamı değişmesin diye); önce ölçümler silinmelidir. DWG/DXF ölçümleri 2B Metraj sayfasında listelenir,
düzenlenir, silinir ve Excel'e aktarılır; çizim üzerinde gösterim CAD görüntüleyicidedir.

## Toplamlar, Poz ve Tutar

- Grup toplamları grup adı ve türe (uzunluk m, alan m², adet) göre alınır; düşülen alanlar eksi girer.
  Ölçeksiz ölçümler toplama girmez, "n ölçeksiz" olarak işaretlenir.
- Ölçüm bir maliyet kalemine bağlanabilir. Kalemin birimi ölçümün birimiyle aynıysa (m, m², adet) tutar =
  miktar × birim fiyat; değilse bağ kalır, tutar hesaplanmaz ve seçili ölçüm kartında uyarı görünür.
- **Excel'e Aktar:** `2B Metraj Özeti` (grup, tür, birim, ölçüm sayısı, miktar, ölçeksiz, tutar) ve `Ölçümler`
  (sayfa, grup, açıklama, tür, miktar, birim, poz, tutar, ölçen) sayfaları.

## Yetki

| İşlem | Gereken |
|---|---|
| Ölçümleri ve toplamları görmek, Excel | Dosyayı görme yetkisi |
| Ölçek belirlemek / silmek, ölçüm eklemek | Klasörde işaretleme (`view_download_markup` ve üstü) |
| Ölçümü değiştirmek / silmek | Ölçümü alan kişi ya da proje yöneticisi (işaretleme yetkisiyle) |

Ölçek değişikliği, ölçüm ekleme ve silme denetim kaydına yazılır (`takeoff.scale_set`, `takeoff.scale_removed`,
`takeoff.item_added`, `takeoff.item_removed`).

## Veri ve API

- Tablolar (`drizzle/0046_takeoff.sql`, `src/db/schema-takeoff.ts`):
  - `takeoff_scales`: versiyon + sayfa başına bir ölçek (`metres_per_unit`, `method` = `calibration` | `drawing_units`,
    kalibrasyon çizgisi ve gerçek uzunluğu).
  - `takeoff_items`: versiyon, sayfa, tür, noktalar (çizim biriminde), açıklama, grup, düşülen, renk, maliyet kalemi, ölçen.
- Hesap `packages/shared/src/quantities/takeoff.ts`: çoklu çizgi uzunluğu, shoelace alanı, kalibrasyon ölçeği,
  miktar (3 ondalık), grup toplamları. Sunucu ve arayüz aynı işlevleri kullanır.

| Uç | İş |
|---|---|
| `GET /projects/:pid/takeoff` | Görülebilen PDF/DWG/DXF çizimlerinin güncel versiyonları ve grup toplamları |
| `GET /projects/:pid/versions/:vid/takeoff` | Ölçekler, ölçümler (miktar, tutar), grup toplamları, `canEdit` |
| `PUT /projects/:pid/versions/:vid/takeoff/scales/:page` | `{ points: [[x,y],[x,y]], realLength }` ya da `{ metresPerUnit }` |
| `DELETE /projects/:pid/versions/:vid/takeoff/scales/:page` | Sayfa ölçeğini siler |
| `POST /projects/:pid/versions/:vid/takeoff/items` | `{ page, kind, points, label?, group?, deduct?, color?, costItemId?, drawingUnits? }` |
| `PATCH /projects/:pid/takeoff/items/:id` | `label`, `group`, `deduct`, `color`, `costItemId` |
| `DELETE /projects/:pid/takeoff/items/:id` | Ölçümü siler |
| `GET /projects/:pid/versions/:vid/takeoff/export` | Excel (`<dosya>-V<n>-2b-metraj.xlsx`) |

Sınırlar: ölçüm başına en çok 5000 nokta; uzunluk en az 2, alan en az 3 nokta; PDF dışı dosyalarda (IFC vb.) 400.

## Testler

- `packages/shared/test/takeoff.test.ts`: uzunluk, alan (sarım yönünden bağımsız), kalibrasyon, düşülen alan, gruplama.
- `apps/server/test/quantities/takeoff-api.test.ts`: ölçeksiz adet/uzunluk, kalibrasyon ve denetim kaydı, alan +
  boşluk + tutar, farklı birimli poz, nokta doğrulama, yazar/yönetici yetkisi, CAD çizim birimi (kalibrasyonu ezmez),
  çizim listesi, Excel.
- `e2e/specs/takeoff.spec.ts` (masaüstü): PDF görüntüleyiciden açma, kalibrasyon, alan + poz, boşluk, uzunluk, adet,
  düzenleme, silme (onay penceresi), Excel, CAD görüntüleyiciden **Metraja Ekle**, Metraj sayfası 2B listesi.
- `e2e/specs/mobile-takeoff.spec.ts` (iPhone): dokunarak kalibrasyon ve alan, alttan açılan panel, 2B listesi kart görünümü.
- `e2e/specs/mobile-smoke.spec.ts`: `quantities?mode=2d` yan kaydırma ve sekme durumu.

## Henüz Yok

- PDF'te yakalama (çizgi uçlarına yapışma) ve vektör çizgilerden otomatik uzunluk.
- DWG/DXF ölçümlerinin 2B Metraj sayfasında çizim üzerinde gösterimi (CAD görüntüleyicide oturum boyunca görünür).
- Ölçümlerin yeni versiyona taşınması (her versiyonun metrajı ayrıdır).
