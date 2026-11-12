# BCF içe ve dışa aktarma (.bcfzip)

Tarih: 11.10.2026. OpenCDE planının ilk adımı (bkz. `docs/archive/research/OPENCDE_ARASTIRMA.md` §3, §7). Sorunlar BCF dosyası olarak
dışa aktarılır ve içe alınır. BCF API 3.0 aynı eşleme katmanını kullanacak.

## Nerede

- **İşler → Sorunlar**: "BCF İçe Aktar" ve "BCF Olarak Dışa Aktar" düğmeleri. Tablodan satır seçilirse yalnız seçili
  sorunlar, seçim yoksa listedeki (filtredeki) sorunlar aktarılır.
- **Sorun ayrıntısı**: "BCF Olarak Dışa Aktar" (tek sorun). Birden fazla görünümü olan sorunda görünümler küçük resim
  olarak listelenir. Her biri Model Görüntüleyicide açılır (`?issue=…&vp=<GUID>`).
- **MCP**: `cde_bcf_export` (okuma) ve `cde_bcf_import` (yazma; önce önizleme, sonra `commit: true`).

## Desteklenen sürümler

| Sürüm | Dışa aktarma | İçe aktarma |
|---|---|---|
| BCF 2.1 | Varsayılan. En uyumlu seçenek: Navisworks, Revit eklentileri, BIMcollab ZOOM, Solibri | Evet |
| BCF 3.0 | Seçilebilir. `extensions.xml` ile | Evet |
| BCF 2.0 | Hayır | Evet (2.1 gibi okunur) |

Dosya düzeni buildingSMART BCF-XML'e uyar: `bcf.version`, `project.bcfp`, `extensions.xml` (3.0),
`<sorun GUID>/markup.bcf`, `<sorun GUID>/viewpoint.bcfv` ve `snapshot.png|jpg` (ilk görünüm),
`<sorun GUID>/<görünüm GUID>.bcfv` ve `.png|jpg` (diğer görünümler).

## Alan eşlemesi

| SiteKeep | BCF | Not |
|---|---|---|
| `issues.guid` | Topic `Guid` | Burada açılan sorunda `id` ile aynı. İçe alınan sorunda dosyadaki GUID (küçük harf) |
| `number` | `ServerAssignedId` (3.0) | |
| `title`, `description` | `Title`, `Description` | Başlık en çok 300, açıklama 10 000 karakter |
| `status` | `TopicStatus` | Dışa: Open, In Progress, Resolved (İncelemede), Closed. İçe: önerilen eşleme, sihirbazda değiştirilebilir |
| `type` | `TopicType` | Boşsa "Issue" yazılır |
| `priority` | `Priority` | Low, Normal, High, Critical |
| `labels`, `stage`, `referenceLinks` | `Labels`, `Stage`, `ReferenceLinks` | |
| `assigneeUserId` | `AssignedTo` (e-posta) | Eşleşmeyen e-posta saklanır, dışa aktarırken geri yazılır |
| `createdBy`, `createdAt` | `CreationAuthor`, `CreationDate` | Eşleşmeyen yazar: içe aktaran kişi + dosyadaki e-posta saklanır |
| `updatedAt`, `modifiedBy` | `ModifiedDate`, `ModifiedAuthor` | |
| `dueDate` (gün) | `DueDate` | Dışa: gün öğlen UTC. İçe: dosyadaki gün |
| görünümün modelleri | Header `File` | `Reference` = model versiyon kimliği, `IfcProject` = IfcProject GlobalId |
| `issue_comments` | `Comment` | GUID, yazar, tarih, görünüm bağı (`Viewpoint Guid`) |
| `issues.viewpoint` + `issue_viewpoints` | `Viewpoints` | İlki birincil görünüm. Görünümler değişmez, GUID ile eklenir |
| `issue_related_topics` | `RelatedTopic` | GUID ile tutulur, ilgili sorun henüz olmayabilir |
| `importedFrom` | — | Kaynak, sürüm, dosya adı, eşleşmeyen değerler, belge bağlantıları |

### Görünüm (VisualizationInfo)

| SiteKeep (sahne) | BCF (IFC dünyası) |
|---|---|
| `camera.position`, `target − position` | `CameraViewPoint`, `CameraDirection` |
| `camera.up` | `CameraUpVector` (eski görünümlerde yuvarlanmasız yukarı hesaplanır) |
| `camera.fov`, `camera.aspect` | `FieldOfView`, `AspectRatio` (3.0) |
| `camera.viewToWorldScale` | Ortografik `ViewToWorldScale` |
| `selection` | `Selection` (IfcGuid) |
| `visibility` | `Visibility` (`DefaultVisibility` + `Exceptions`, `ViewSetupHints`) |
| `coloring` | `Coloring` (`RRGGBB` / `AARRGGBB`) |
| `sections.planes` | `ClippingPlanes` (yön ters çevrilir: BCF gizlenen yarıyı gösterir) |
| `sections.box` | 6 kesit düzlemi. İçe aktarmada eksenlere dik 6 düzlem yeniden kutu olur |
| `measurements`, sorun noktası (pin) | `Lines` (nokta = başı ve sonu aynı çizgi) |
| `snapshot` | `snapshot.png` / `.jpg` |

## Koordinatlar

- BCF: IFC dünya koordinatı, metre, Z yukarı.
- Görüntüleyici: three.js, Y yukarı. Fragments modeli içe alırken web-ifc `COORDINATE_TO_ORIGIN` ile kaydırır.
- Dönüşüm: sahne = (x, z, −y) + kaydırma. Ters yön: IFC = (X, −Z, Y) − kaydırma. Yönler yalnız döner.
- Kaydırma ilk modelinkidir (model setinde ilk hizalanan model). Yeni görünümler bunu `sceneOffset` olarak saklar.
- Eski görünümlerde kaydırma sunucuda modelin görüntüleyici dosyasından okunur ve önbelleğe alınır. Okunamazsa uyarı
  verilir.
- İçe alınan görünüm `sceneOffset: [0, 0, 0]` ile saklanır. Görüntüleyici açarken kendi kaydırmasına taşır.
- IfcMapConversion (harita koordinatı) uygulanmaz. BCF de uygulamaz.
- BCF'de hedef noktası yok. İçe alınan kamerada yörünge merkezi bakış yönünde 10 m ileridedir.

Dönüşüm `packages/shared/src/bcf.ts` içinde tek yerde. Sunucu, web ve MCP aynı kodu kullanır.

## İçe aktarma

1. Dosya seçilir. Sunucu önizleme döner: her sorun için **Yeni**, **Güncellenecek**, **Değişiklik Yok** ya da
   **Uyuşmazlık**.
2. Eşleme: durumlar, türler, öncelikler, kişiler (e-posta → proje üyesi ya da "Eşleşmeyen"), modeller (dosya adı,
   IfcProject GUID ya da versiyon kimliği ile önerilir).
3. İçe aktar. Sonuç: yeni, güncellenen, değişmeyen, korunan sorun sayısı; eklenen yorum ve görünüm sayısı.

Kurallar:

- Eşleme GUID iledir. Aynı dosya ikinci kez kopya oluşturmaz.
- Yorumlar ve görünümler yalnız eklenir (GUID ile). Silinmez, üzerine yazılmaz.
- Dosya son içe aktarmadan beri değiştiyse ve sorun burada değişmediyse alanlar güncellenir.
- İki tarafta da değiştiyse **uyuşmazlık**: varsayılan olarak buradaki değerler korunur. Sihirbazda "Dosyadaki
  Değerleri Uygula" seçilebilir.
- Var olan sorunun alanlarını yalnız oluşturan, atanan ya da proje yöneticisi değiştirir. Diğer üyelerin içe
  aktarması yalnız yeni yorum ve görünüm ekler.
- Sorunlar modülü kapalıysa içe aktarma reddedilir (403). Dışa aktarma okuma olduğu için çalışır.
- Salt okuma erişim anahtarı dışa aktarır ve önizleme yapar, içe aktaramaz.

## Güvenlik ve sınırlar

| Sınır | Değer |
|---|---|
| .bcfzip boyutu | 100 MB |
| ZIP içindeki dosya sayısı | 5 000 |
| Açılmış tek dosya / toplam | 20 MB / 300 MB |
| Sıkıştırma oranı (1 MB üstü dosyada) | en çok 200 |
| Bir dosyada sorun | 2 000 (dışa aktarmada da) |
| XML dosyası | 8 MB |
| Görüntü | 5 MB, en çok 8000 piksel kenar |

- ZIP yalnız bellekte açılır. Mutlak yol, `..`, ters bölü, sembolik bağlantı içeren dosya adı reddedilir (zip-slip).
- XML'de DOCTYPE ya da ENTITY bildirimi reddedilir (XXE, entity bombası).
- Görüntü türü dosya adından değil içerikten anlaşılır. PNG parçaları CRC ile denetlenir, görüntü verisi açılır.
  PNG ve JPEG yalnız gerekli parçalarıyla yeniden yazılır: metin, Exif, XMP, yorum atılır.
- Bitmap'ler ve BIM parçacıkları (BimSnippet) desteklenmez, uyarı verilir.
- Kamera yuvarlanması (roll) görüntüleyicide uygulanamaz. Dik bakışta yukarı yön korunur.
- BCF 2.1 görüş açısını 45–60° ile sınırlar. Dışarıdaki değer bu aralığa çekilir ve uyarı verilir.

## Uç noktalar

| Yöntem | Yol | Not |
|---|---|---|
| GET | `/api/v1/projects/:pid/bcf/export?version=2.1&ids=…&status=…&snapshots=0` | .bcfzip indirir |
| POST | `/api/v1/projects/:pid/bcf/export` | JSON: dosya adı, indirme bağlantısı, küçükse base64 |
| POST | `/api/v1/projects/:pid/bcf/import/preview` | multipart `file` ya da JSON `{fileName, data}` |
| POST | `/api/v1/projects/:pid/bcf/import` | aynı + `mapping` |
| GET | `/api/v1/projects/:pid/issues/:iid/viewpoints` | sorunun tüm görünümleri |

Şema: `0029_bcfzip` (issues: `guid`, `labels`, `stage`, `reference_links`, `modified_by`, `imported_from`;
issue_comments: `guid`, `viewpoint_guid`, `modified_at`, `modified_by`, `imported_author`; yeni tablolar
`issue_viewpoints`, `issue_related_topics`).

## Test edilenler

- Otomatik testler (`apps/server/test/coordination/bcf.test.ts`, `packages/shared/test/bcf.test.ts`):
  - Dışa aktarılan 2.1 ve 3.0 XML'i resmî buildingSMART XSD'lerine karşı denetlenir (`test/fixtures/bcf-xsd`).
  - buildingSMART test dosyaları (2.1: "One part visible", "user assignment"; 3.0: "Orthogonal camera",
    "Related topics") içe alınır.
  - Elle yazılmış 2.1 ve 3.0 dosyaları, yeniden içe aktarma, uyuşmazlık, gidiş-dönüş, zararlı ZIP'ler, yetkiler,
    modül kapalı.
- Navisworks, BIMcollab ZOOM, Solibri ve Revit eklentileriyle elle deneme **henüz yapılmadı**. İlk müşteri
  dosyasıyla denenmeli.
