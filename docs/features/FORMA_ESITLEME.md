# Forma dosya eşitleme

Forma / Autodesk ACC’deki **kayıt, klasör ve dosyaları** CDE’ye almak (ve yayımlananı
geri yazmak). Çalışanlar: **kayıt** eşitlemesi (sorun, inceleme, form, bilgi talebi,
malzeme onayı, konum, kullanıcı ve şirket) ve **elle dosya getirme**. Klasör
eşlemeleriyle otomatik dosya turu (faz 2) ve dışa yazma henüz yok.

Tasarım (arşiv, sözleşme değil):
Yedekleme ve Forma Eşitleme §2.
Projede Autodesk’in tek yeri bu sayfa; Proje Ayarları’nda Autodesk sekmesi yok
(`?sekme=autodesk` ve `?sekme=forma-esitleme` buraya yönlenir). Sırlar yazılmaz.

---

## Bugün

Yol: proje menüsü **Yönetim → Forma Eşitleme** (`/projects/:id/forma-esitleme`,
proje yöneticileri; API’nin kuralı da bu).

| Parça | Ne | Gerçek mi |
|---|---|---|
| ACC Projesi | listeden ACC projesi seç → Autodesk ile Bağlan; bağlıysa ad, hesap, otomatik eşitleme (her 30 dk, durdur/başlat), Değiştir | evet |
| Getir | **Hepsini Getir** (bütün kayıt türleri) · **Seçerek Getir** (istenen kayıt türleri, ACC/CDE sayılarıyla; ya da Autodesk Docs’tan dosya) | evet |
| Aktarım | kayıt eşitlemesi adım adım (tür başına ✓ / alınıyor / bekliyor, kayıt sayısı, yüzde, **İptal**) ve dosyalar (sırada / indiriliyor yüzde ve MB / işleniyor / yeni / yeni versiyon / zaten güncel / iptal / hata, **İptal**) | evet |

Bağlanınca hiçbir şey gelmez ve otomatik eşitleme kapalı başlar; Hepsini Getir ya da
tür seçerek getirmek o türleri getirir ve otomatik eşitlemeyi açar. Tek tek kayıt
getirmek açmaz.

Bir CDE projesinin tek ACC projesi var: son giriş yapılan (`authorized_at`). Değiştir ile
başka projeye bağlanınca öncekilerin otomatik eşitlemesi durur; getirilen kayıt ve
dosyalar yerinde kalır.
| Yönetim (sistem) → Forma Eşitleme | eşleme ekranı örneği | hayır; sabit örnek (`admin/forma-sync.ts`) |

### Autodesk’ten Getir nasıl çalışır

1. `GET /projects/:pid/integrations/autodesk/:cid/docs?folder=<urn>`: bağlantının
   kendi token’ıyla Data Management (`topFolders`, `folders/:id/contents`). Hub
   bağlantıda yoksa ilk açılışta bulunur ve kaydedilir. Her dosyada `imported`:
   daha önce hangi CDE dosyasına, hangi Autodesk sürümüyle geldiği.
2. `POST …/:cid/imports` `{ targetFolderId, files[] }`: yükleme hakkı, klasör
   kapısı ve isimlendirme standardı hemen denetlenir; uymayanlar `rejected`
   olarak döner. Kabul edilen her dosya ayrı bir `autodesk_file_import` işi olur.
3. İş: sürüm Data Management’tan yeniden okunur → OSS `signeds3download` →
   imzalı S3 adresinden akışla `storage.put` (belleğe alınmaz) → `addVersion` →
   `afterVersionAdded` (IFC → Fragments, önizleme, antet, denetim kaydı
   `via: "autodesk"`).
4. Öğe ↔ CDE dosyası `external_entity_links` (`kind: "document"`,
   `nativeType: "file"`, `metadata.versionNumber`). Aynı öğe yeniden getirilirse
   kendi CDE dosyasına (taşınmış/yeniden adlandırılmış olsa da) versiyon eklenir;
   aynı ya da eski sürüm “zaten güncel” olarak atlanır.
5. Gizlilik: tüm çağrılar `outboundFetch` (`entegrasyon:autodesk`) üzerinden;
   S3 indirmesi de aynı bağlantı altında kayda düşer, kapatılınca durur.

6. İlerleme: indirilen bayt süreç içinde sayılır (`bytesReceived`, yalnız
   “indiriliyor” satırında). Yeniden başlatmada yarıda kalan aktarım baştan
   alınır (kuyruk işi yeniden koşar; açılışta işi kaybolmuş aktarımlar
   `resumeInterruptedImports` ile kuyruğa döner).

### İptal

- Kayıt eşitlemesi (`POST …/:cid/sync/cancel`): sıradaysa hiç başlamaz; sürüyorsa bir
  sonraki türden önce durur, okunanlar saklanır ama proje sekmelerine bir sonraki tam
  turda işlenir. Adımlar `GET …/:cid/progress` ile izlenir.
- Dosya (`POST …/imports/:id/cancel`): sıradaysa başlamaz; inerken indirme kesilir ve
  hiçbir şey saklanmaz. İndirme bittikten sonra (işleniyor) iptal edilemez.

### Kayıt türleri (Seçerek Getir)

`GET …/:cid/records`: her tür için seçili mi, son eşitlemede ACC’de kaç kayıt
(`null` = hiç okunmadı), CDE’de kaç bağlı kayıt. `POST …/:cid/records { kinds }`:
seçim bağlantıya yazılır (`autodesk_connections.sync_kinds`, `null` = hepsi) ve
eşitleme hemen kuyruğa girer; zamanlanmış turlar da yalnız seçili türleri okur.
Türler: sorun, inceleme, form, bilgi talebi, malzeme onayı, konum, kullanıcı
(şirketlerle birlikte). Tek yönlü: ACC → CDE.

Tek tek kayıt: Seçerek Getir’de bir tür “Kayıtları Gör” ile açılır.
`GET …/:cid/records/:kind?refresh=1` türü ACC’den o an tam okur (proje sekmelerine
işlemeden saklar) ve listeler: ad, ACC numarası, durum, ACC’de güncellenme, ACC’de
silindi mi, CDE karşılığı (“CDE’de Aç”), ACC’nin verdiği tüm düz alanlar (Ayrıntılar).
`POST …/:cid/records/bring { records: [{ kind, externalId }] }` yalnız seçilenleri hemen
proje sekmelerine işler (`projectAutodeskRecords`); tür otomatik eşitlemede değilse bu
kayıtlar sonra güncellenmez. Eşitleme sürerken 409.

ACC uç noktaları (02.11.2026’da gerçek hesapla denendi): şirketler
`hq/v1/accounts/{hesap}/projects/{proje}/companies` (hesap = hub kimliği, `b.`
olmadan), malzeme onayı `submittals/v2`, inceleme ve form sayfası en çok 50.
Sorun, inceleme, form ve malzeme onayı kullanıcı token’ı ister (uygulama
token’ıyla 401/403).

Kod: `integrations/autodesk/documents.ts` (Data Management + OSS),
`integrations/autodesk/file-import.ts` (kuyruk, iş, liste),
`integrations/autodesk/routes.ts`, web `features/admin/pages/ProjectFormaSync.tsx`.
Test: `apps/server/test/integrations/autodesk-files.test.ts`.

Sınırlar: bulut paylaşımlı Revit modelleri (C4R) depolanmış içerik taşımaz,
“İndirilemez” görünür. RVT olduğu gibi gelir; 3B yalnız IFC’de. İşler tek
kuyrukta sırayla koşar; büyük bir indirme IFC dönüşümlerini bekletir.

---

### Kurulum (bir kez)

1. **APS uygulaması** (aps.autodesk.com → My Apps). İki tür de çalışır:
   - "Desktop, Mobile, Single-Page App": yalnız PKCE, secret yok.
   - "Traditional Web App": PKCE + secret; `AUTODESK_CLIENT_SECRET` doldurulur, token
     istekleri Basic kimlikle gider.
2. **Callback** uygulamada birebir kayıtlı olmalı:
   `https://<sunucu>/api/v1/integrations/autodesk/callback` (yerel:
   `http://localhost:5173/api/v1/integrations/autodesk/callback`).
3. **ACC Custom Integration.** Hesap yöneticisi ACC → Account Admin → Custom
   Integrations’a Client ID’yi ekler. Eklenmeyen hesapta giriş olur ama proje
   403 döner. Kontrol: uygulama token’ıyla `GET /project/v1/hubs` hesabı
   listelemeli.
4. **Sunucu:** `AUTODESK_CLIENT_ID`, `AUTODESK_CALLBACK_URL`, gerekirse
   `AUTODESK_CLIENT_SECRET` (canlıda `app.env` + `FORCE=1` deploy).
5. **Bağla:** Forma Eşitleme → ACC Projesi → listeden ACC projesini seç → Autodesk ile
   Bağlan. Liste uygulamanın kendi token’ıyla gelir (`GET …/autodesk/catalog`, yalnız
   secret’lı uygulamada); secret yoksa veya liste boşsa kimlikler elle girilir. Dönüşte
   Forma Eşitleme açılır ve “bağlandı” / “iptal edildi” yazar. Kendiliğinden bir şey
   gelmez; kayıtlar Getir ile istenir.

Durum (02.11.2026): canlı ve yerel, Hasan Bey’in APS hesabındaki **7D CDE** uygulamasını (Autodesk'teki kayıt adı)
(Traditional Web App) kullanıyor; callback’ler `sitekeep.ornek.com` ve `localhost:5173`.
Uygulama **7Dimensions** hesabına eklendi (18 proje). Başka hesaptaki proje için o hesabın
Custom Integrations’ına aynı Client ID eklenir.

---

## Sonraki adım: otomatik dosya turu (faz 2)

Ürün sözleşmesi arşiv §2. Motoru bağlamak için:

1. **Data Management API.** Hub, proje, klasör, öğe, versiyon;
   `lastModifiedTime` ile tarama. Kapsam içe `data:read`; dışa kural varsa
   `data:write` / `data:create`.
2. **İmzalı S3 akış.** `signeds3download` / `signeds3upload`. Büyük IFC
   belleğe alınmaz; kaldığı yerden devam. 100 MB+ zaman aşımı Forma MCP’de
   görüldü.
3. **Eşleme kaydı.** (Forma proje + klasör) ↔ (CDE proje + klasör) + yön +
   filtre (tür, isim, onay, alt klasör). Aynı çiftte iki yön birden yok.
4. **İş.** `jobs` türü örn. `forma-sync`. Yeni dosya → CDE yükleme servisi
   (`via: forma-sync`). Yeni versiyon. Ad değişince `external_entity_links`.
   Forma’da silinen CDE’de durur, “kaynakta silindi”.
5. **Dışa.** Yalnız Yayımlanan. Autodesk bulutuna çıkar; açık onay + Gizlilik
   Merkezi (`entegrasyon:autodesk`).
6. **Uçlar.** `GET /admin/forma-sync` örnek bırakır, gerçek eşleme ve
   `integration_sync_runs` okur. `POST …/run` = Şimdi Eşitle. Eşleme
   ekle/sil kalıcı olur.
7. **forma-mcp gömülmez.** Mantık Node APS istemcisine taşınır. MCP yalnız
   asistan aracı kalabilir (`cde_forma_sync_status` / `_run`).

Kayıt eşitlemesi bu işin parçası değildir; durur.

---

## 1. İki katman (karışmaz)

| Katman | Bugün | Bu ekran |
|---|---|---|
| **Kayıt** | Sorun, inceleme, RFI, form, üye | Özet rozet |
| **Dosya** | Elle getirme (Autodesk’ten Getir); eşleme turu yok | Getir modalı + Son Aktarılanlar |
