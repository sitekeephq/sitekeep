# Parametre Değişikliği (Değişiklik Talebi)

Tarih: 11.10.2026. Kullanıcı kararı: "Modeli parametre değişimi ile güncelleme", 1. adım.

## Ne yapar

- IFC elemanlarının bilgi parametrelerini (özellik setleri, Pset) CDE içinde değiştirir.
- Sonuç, aynı dosyanın yeni versiyonudur. Geometri değişmez.
- Geometri değişiklikleri 2. adımdır: Revit'te, AEC Pilot ile yapılır.
- İki adım aynı "Değişiklik Talebi" kaydını kullanır. Yalnız "uygulama" tarafı değişir.

## Nerede

- Model → **Parametre Değişiklikleri** sekmesi (`/p/:pid/param-changes`).
- IFC dosyasının çekmecesinde **✎ Parametre Değişiklikleri** düğmesi (`?file=` ile o dosya).
- "+ Yeni" → **Parametre Değişikliği**.
- Koordinasyon modülü kapalıysa yeni talep açılamaz. Mevcut talepler okunur.

## Talep nasıl oluşur

Üç yol vardır. Hepsi aynı önizlemeyi verir.

1. **Seçimden:** GlobalId listesi + özellik + yeni değer.
2. **Sorgudan:** "Modele sor" sorgusu (sınıf, kat, koşul) + "set" kuralı.
   Örnek: kapılarda FireRating = EI30 olanlar → FireRating = EI60.
3. **Cümleden:** "EI30 olan kapıları EI60 yap".
   - Yapay zekâ yalnız `{query, set}` JSON'u yazar.
   - JSON zod ile doğrulanır, sonra modelin sözlüğüne karşı kontrol edilir.
   - Modelde olmayan sınıf, kat, özellik reddedilir ("uydurma özellik").
   - Yeni değer cümlede yoksa reddedilir. Koşul değeri cümlede ya da modelde olmalıdır.
   - Model yoksa "Yapay Zekâya Gönder" ile bağlı istemciye gider (görev türü `param_change`).

Önizleme şunları gösterir:

- Eleman başına eski → yeni değer.
- Sınıf ve kat başına sayı.
- Modelde olmayan özellik: **eklenecek**.
- Zaten aynı değerde olanlar (atlanır).
- Değeri tipte duran elemanlar ve tipin seçim dışındaki elemanları.

Özellik ve set adları büyük/küçük harf ve Türkçe karakterden bağımsız eşleşir.
Set yazılmazsa, özelliğin modelde bulunduğu set kullanılır.
Yeni özellik için set adı gerekir. Miktarlar (Qto) değiştirilemez.

## Durumlar

Taslak → Onay Bekliyor → Onaylandı → Uygulanıyor → Uygulandı.
Diğer sonlar: Reddedildi, İptal.
2. adım için: **Revit'te Uygulanacak**.
Uyarı durumu: **Değerler Kayboldu** (talep yeniden açılır).

## Onay

- Proje ayarı: "Parametre değişikliği onay gerektirir". Varsayılan: açık.
- Onaylayan: proje yöneticisi veya ayarlanan onaylayıcı rol.
- Uygulama için talep onaylı olmalı.
- Onay kapalıysa proje yöneticisi taslağı doğrudan uygulayabilir.
- Onaya gönderince onaylayıcılara bildirim gider. Onay ve ret oluşturana bildirilir.

## Değerin sahibi

- **Revit'e de İşlenecek:** değer tasarım modeline de girmeli.
- **Yalnızca CDE'de:** modelde olmayan bilgi CDE'de eklenir (zenginleştirme).
- Varsayılan: yalnız yeni özellik ekleniyorsa "Yalnızca CDE'de", diğer her durumda "Revit'e de İşlenecek".

## Uygulama (Yeni Versiyon)

- İş kuyruğunda, ayrı bir worker'da (web-ifc) çalışır.
- Değer, elemanın IfcPropertySet / IfcPropertySingleValue kaydına yazılır.
- Var olan IFC türü korunur (IfcLabel, IfcIdentifier, IfcReal, IfcBoolean…).
- Özellik yoksa eklenir. Set yoksa set ve IfcRelDefinesByProperties oluşur (IFC2X3 ve IFC4).
- Birden fazla elemanın paylaştığı set önce kopyalanır. Başka eleman değişmez.
- Değer tipteyse: varsayılan "Elemana Yaz" (eleman tipi geçersiz kılar).
  "Tipte Değiştir" seçilirse tipin bütün elemanları değişir; önizleme bunları listeler.
- Geometri, yerleşim, miktarlar ve GlobalId'ler değişmez. Dosyanın geri kalanını web-ifc yeniden yazar.
- Yeni versiyon `addVersion` ile kaydedilir: yükleme ile aynı kurallar
  (yetki, onay kapısı, isimlendirme, öznitelikler aynen taşınır).
- Açıklama: "Parametre değişikliği: <başlık> (<n> eleman)".
- Normal hat çalışır: Fragments dönüşümü ve eleman indeksi.
- İndeks hazır olunca değerler yeni versiyonun indeksinden okunur.
  Hepsi varsa talep **Uygulandı** olur; satır başına sonuç yazılır.
- Dosyanın daha yeni versiyonu varsa uygulama durur: **Güncel Versiyona Taşı** gerekir.

## Sonraki versiyonların otomatik kontrolü

Dosyanın her yeni versiyonu indekslenince (yükleme, WOPI, AEC Pilot, geliştirici yüklemesi) talepler kontrol edilir:

- **Uygulandı:** değerler yoksa → **Değerler Kayboldu**, talep yeniden açılır, kaybolan satırlar işaretlenir.
  Oluşturana ve proje yöneticilerine bildirim: "Önceki parametre değişikliği bu versiyonda yok: <başlık> (n eleman)".
  Dosya çekmecesinde versiyonun yanında ve listede uyarı rozeti görünür.
- **Değerler Kayboldu:** değerler geri gelirse → yine **Uygulandı**.
- **Revit'te Uygulanacak:** bütün değerler gelirse → **Uygulandı** (Revit'ten doğrulandı).
- Aynı versiyon aynı talep için bir kez kontrol edilir (`param_change_checks`).
- "Doğrula" düğmesi aynı kontrolü elle, istenen versiyonda yapar.

## MCP araçları

- `cde_change_requests_list`, `cde_change_request_get`: okuma.
- `cde_change_request_create`: taslak (yazma anahtarı). `preview: true` yalnız önizler.
- `cde_change_request_verify`: sonraki versiyonu kontrol eder (yazma anahtarı).
- `cde_change_request_apply`: yazma anahtarı + proje yöneticisi ya da onaylayıcı + onaylı talep.

## REST

`/api/v1/projects/:pid/param-changes`:
`GET /` (liste), `POST /preview`, `POST /ai-plan`, `POST /` (taslak), `GET /:id`, `PATCH /:id`,
`POST /:id/submit | approve | reject | cancel | apply | authoring | verify | rebase`,
`GET|PUT /settings`. Dosya özeti: `GET /projects/:pid/files/:fid/param-change-status`.

## Görüntüleyiciye bağlama

Panel ayrı bir bileşendir (`apps/web/src/components/ParamChangePanel.tsx`):

```tsx
<ParamChangePanel modelVersionId={versionId} selection={seciliGlobalIdler} onPreview={(guids) => vurgula(guids)} />
```

- `selection` verilirse "Seçimden" yolu açık gelir.
- `onPreview` değişecek elemanların GlobalId'lerini verir (vurgulama için).
- Kaydedince talep sayfası açılır (`onCreated` ile değiştirilebilir).

## Sınırlar

- Bir talep en fazla 5000 değişiklik. Önizleme ilk 500 satırı gösterir.
- Yalnız tek değerli ve seçenekli özellikler. Sınırlı, liste, tablo değerleri değişmez.
- Öznitelikler (Name, Tag, ObjectType) ve miktarlar değişmez.
- IFC4'teki set listeleri (IfcPropertySetDefinitionSet) okunmaz.
- web-ifc dosyayı yeniden yazar; başlık ve sıralama biçimi değişebilir.

## 2. adım planı (Revit)

1. Talep onaylanır, "Revit'te Uygulanacak" yapılır.
2. AEC Pilot `cde_change_request_get` ile satırları okur, Revit'te parametreleri yazar.
3. IFC yeniden dışa aktarılır, aynı dosyaya yeni versiyon yüklenir.
4. Otomatik kontrol (veya `cde_change_request_verify`) talebi "Uygulandı" yapar.
5. Geometri değişiklikleri de aynı kayıtla izlenecek; yalnız uygulama tarafı Revit olacak.
