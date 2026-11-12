# Metraj Onayı, Poz Bağlama ve Hakedişe Aktarma

Metraj sayfasındaki 3B (IFC) envanter ya da 2B (PDF, DWG/DXF) ölçüm toplamları proje yöneticisince **onaylanır**.
Onay numaralı, değişmez bir anlık görüntüdür. Onaydaki gruplar sözleşme kalemlerine **bağlanır** ve dönem hakedişi
**Onaylı Metrajdan Doldur** ile bu bağlardan doldurulur. Hangi hakedişin hangi onaydan geldiği kayıtlıdır.

## Akış

1. **Onay:** Metraj → 3B Model sekmesinde **Metrajı Onayla** (seçili IFC versiyonu) ya da 2B Çizim sekmesinde
   çizimin satırındaki **Metrajı Onayla**. Açılan pencerede isteğe bağlı not girilir. "Metraj Onayı #n kaydedildi."
   bildirimi **Onayları Gör** bağlantısıyla gelir.
   - IFC: gruplar sınıf · tip · malzeme kırılımındadır; değerler boşluk düşülmüş net/brüt alan, net/brüt hacim, uzunluk,
     ağırlık ve adet. Boşluk indeksi eskiyse 409 döner, sayfa indeksi hazırlar. Modelin birimi okunamamışsa (eski indeks) onay
     409 döner; model yeniden indekslenmelidir. Onay numaraları proje satırı kilitlenerek verilir (eşzamanlı onayda çakışmaz).
   - 2B: gruplar grup adı · türdür (uzunluk, alan, adet); grubun ölçümlerinde kullanılan maliyet kalemleri saklanır.
     Ölçeksiz ölçüm varsa onay reddedilir (400).
2. **Onaylar sekmesi** (`/projects/:pid/quantities?mode=approvals`): numara, dosya ve versiyon, not, onaylayan,
   durum, kullanan hakedişler. Satır açılınca grup tablosu görünür. **Geri Al** gerekçe ister; geri alınan onay
   saklanır, "Geri Alındı" olarak işaretlenir ve hakediş doldurmak için kullanılamaz.
3. **Bağlama:** Sözleşme → **Metraj Bağları** sekmesi. Onay seçilir; her grup için kalem ve ölçü (kalemin birimine uygun:
   m³ → net/brüt hacim, m² → net/brüt alan, m → uzunluk, kg/ton → ağırlık, adet → adet) seçilir.
   **Önerileri Uygula (n)** önerileri doldurur; **Bağları Kaydet** kaydeder. **Kalem Toplamları** bir kaleme bağlı
   grupların toplamını gösterir. Seçili onayda olmayan eski bağlar korunur.
4. **Hakediş:** Dönem Hakedişleri sekmesinde taslak ya da reddedilmiş hakedişte **Metraj Onayı** seçilip
   **Onaylı Metrajdan Doldur**. Onaylı miktar kümülatif sayılır: bu dönem = en az 0, (onaylı miktar − önceki
   hakedişlerin toplamı). Satırın "Metraj Kaynağı / Ataşman" alanına `Metraj Onayı #n · dosya Vn · k eleman`
   yazılır. Hakediş başlığında "Kaynak: Metraj Onayı #n · dosya Vn" görünür; onay sonradan geri alınırsa yanında
   "Onay Geri Alındı" rozeti çıkar. Hakediş revizyonu onay bağını kopyalar.
5. **Hakediş kuralları:**
   - Hakedişler sırayla onaya gider: önceki numara onaydayken sonraki sunulamaz, sonraki numara sunulmuşsa öncekine
     dönülemez. Yalnızca son revizyon düzenlenir, sunulur ve onaylanır.
   - "Önceki miktar" son onaylanmış hakedişten alınır ve sunarken yenilenir; elle yalnızca 1 no'lu taslakta girilir.
   - **Onaya Sun** ekrandaki kaydedilmemiş değerleri önce kaydeder.
   - Onaydaki ya da onaylı hakedişi olan sözleşmenin şartları, para birimi ve KDV ayarı; hakedişte kullanılan kalemin
     birimi ve birim fiyatı değiştirilemez, kalem silinemez (409).
   - Onaylı hakedişi olan sözleşme silinemez; önce durumu **İptal** yapılır.
   - Durum sırası: Onaylandı → Faturalandı → Ödendi. ERP referansı onaylı hakedişte de güncellenebilir.
   - Avans kesintisi varsayılan %0'dır ve toplamda avans tutarını aşmaz.

## Bağ Önerileri

- **IFC grupları:** Poz Öner'in eşleme hafızası (`poz_mappings`, sınıf/tip/malzeme düzeyleri). Hafızadaki poz kodu
  sözleşme kaleminin poz koduna ya da koduna (büyük/küçük harf ve noktalama yok sayılarak) eşlenir.
- **2B grupları:** önce grubun ölçümlerindeki maliyet kalemi, sonra grup adının kalem koduyla eşleşmesi.

Bağlar grup anahtarıyla saklanır (`["model", sınıf, tip, malzeme]` ya da `["drawing", grup, tür]`). Aynı modelin ya
da çizimin sonraki onaylarında bağlar yeniden kullanılır.

## Yetki

| İşlem | Gereken |
|---|---|
| Onay vermek, geri almak | Proje yöneticisi |
| Onayları görmek | Yönetici hepsini; diğerleri dosyasını görebildikleri onayları |
| Bağları görmek / önerileri almak | Sözleşmeyi görme yetkisi |
| Bağları kaydetmek, hakedişi onaydan doldurmak | Proje yöneticisi |

Denetim kaydı: `quantity.approved`, `quantity.approval_revoked`, `contract.quantity_bindings_updated`,
`contract.payment_filled_from_quantities`.

## Veri ve API

- Tablolar (`drizzle/0047_quantity_approvals.sql`, `src/db/schema-contracts.ts`):
  - `quantity_approvals`: proje içi sıra numarası, kaynak (`model` | `drawing`), versiyon, dosya adı, not, gruplar,
    toplamlar, boşluk özeti, durum (`approved` | `revoked`), onaylayan, geri alan ve gerekçe.
  - `quantity_bindings`: sözleşme, kalem, grup anahtarı, etiket, kaynak, ölçü. Sözleşme + grup anahtarı tekil.
  - `progress_payments.quantity_approval_id`.
- Ortak hesap `packages/shared/src/quantities/approvals.ts`: grup anahtarları, birime uygun ölçüler, kg → ton
  çevrimi, kalem toplamları (`boundQuantities`).

| Uç | İş |
|---|---|
| `GET /projects/:pid/quantity-approvals?versionId=` | Onay listesi |
| `GET /projects/:pid/quantity-approvals/:id` | Onay ve grupları |
| `POST /projects/:pid/quantity-approvals` | `{ versionId, note? }` → 201 |
| `POST /projects/:pid/quantity-approvals/:id/revoke` | `{ reason }` (zorunlu) |
| `GET /projects/:pid/contracts/:cid/quantity-bindings` | Sözleşmenin bağları |
| `PUT /projects/:pid/contracts/:cid/quantity-bindings` | `{ bindings: [{ groupKey, label, source, contractItemId, measure }] }`, hepsini değiştirir |
| `GET /projects/:pid/contracts/:cid/quantity-bindings/suggest?approvalId=` | Bağ önerileri |
| `POST /projects/:pid/contracts/:cid/payments/:payId/fill-from-quantities` | `{ approvalId }` |

Hatalar: geri alınmış onay 400; bağ yoksa 400 ("Metraj Bağları" sekmesine yönlendirir); başka sözleşmenin kalemi,
birime uymayan ölçü ya da tekrarlanan grup 400.

## Testler

- `packages/shared/test/approvals.test.ts`: anahtarlar, birime göre ölçüler, kg → ton, kalem toplamları, eksik ölçü.
- `apps/server/test/quantities/approvals-api.test.ts`: yalnız yönetici onayı, IFC grupları ve net alan, görünürlük,
  bağsız doldurma 400, hafızadan öneri, ölçü doğrulaması, doldurma (kümülatiften yalnız artış), geri alma, 2B onayı
  ve maliyet kaleminden öneri.
- `e2e/specs/quantity-approvals.spec.ts` (masaüstü): onay penceresi, Onaylar sekmesi ve grupları, Metraj Bağları,
  hakedişi doldurma ve kaynak, gerekçeli geri alma.
- `e2e/specs/mobile-quantity-approvals.spec.ts` (iPhone): dokunarak onay, bağlama ve doldurma; yan kaydırma yok.
- `e2e/specs/mobile-smoke.spec.ts`: `quantities?mode=approvals`.

## Henüz Yok

- Sor (MCP) aracı onayları okumaz.
- Kat/bölge bazlı kısmi onay (ilerleme yüzdesi); onay her zaman modelin ya da çizimin tamamıdır.
- Çok adımlı (kontrol → onay) iş akışı; tek adımlı yönetici onayıdır.
