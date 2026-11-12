# Poz Öner

IFC modelindeki eleman gruplarına projenin birim fiyat listesinden poz önerir. Onaylanan satır sıradan bir
maliyet kuralına (5D) dönüşür ve hafızaya yazılır; sonraki projelerde aynı grup için ilk sırada önerilir.
İlke: miktarı ve tutarı model hesaplar; yapay zekâ yalnızca verilen aday listesinden poz kodu seçer; onaylanmayan
öneri hiçbir toplama girmez.

## Nereden Açılır

- **Metraj** sayfası → **Poz Öner** (seçili versiyon için).
- **İş Programı → Diğer → Maliyet (5D) → Maliyet Kuralları** → **Poz Öner** (seçili model için).
- **Maliyet (5D) → Öğrenilen Eşlemeler**: hafıza.
- Yalnızca planlama yetkisi olanlar (proje yöneticisi) görür. İş Programı modülü kapalıysa düğme görünmez.

## Nasıl Çalışır

1. **Gruplar.** Elemanlar sınıf · tip · malzeme üçlüsüne göre gruplanır.
   - Her grup için tam o elemanları seçen bir kural aranır, bu sırayla: `Sınıf + Tip = …`, `Sınıf + Malzeme = …`, yalnız `Sınıf`.
   - Hiçbiri tam seçmiyorsa grup "tek bir kuralla ayrılamıyor" diye önerisiz kalır. Örnek: aynı sınıfta tipi ve malzemesi olmayan başka eleman var.
   - Mevcut bir maliyet kuralının fiyatladığı elemanı içeren gruplar atlanır ve "zaten fiyatlanıyor" sayısına yazılır.
2. **Miktar.** Pozun birimi miktar kaynağını belirler:
   - m³ → net hacim (yoksa brüt hacim)
   - m² → net alan (duvarda NetSideArea)
   - m → uzunluk
   - kg → ağırlık
   - ton → ağırlık × 0,001
   - adet → eleman sayısı

   Kaynaklar Metraj envanterindekiyle aynıdır (`Qto_*`, Revit "Dimensions" yedeği). Grupta o birimde miktar yoksa poz aday olamaz.
3. **Kaynaklar** (öncelik sırasıyla):
   - **Öğrenilmiş:** daha önce onaylanan grup ↔ poz eşlemesi. Eşleşme düzeyleri ve güven:
     - Aynı sınıf, tip ve malzeme: %95
     - Aynı tip: %85
     - Aynı malzeme: %75
     - Yalnız sınıf: %60

     Her önceki onay güveni biraz artırır. Poz, bu projenin listesinde poz numarasıyla (yoksa koduyla) bulunur; başka projedeki kalem kodu farklı olabilir.
   - **Yapay Zekâ:** projenin yapay zekâ sağlayıcısı.
     - Her grup için anahtar sözcükle seçilmiş en çok 8 aday ve tanımları gönderilir; model yalnızca bunlardan birini seçer.
     - Listede olmayan kod, bilinmeyen grup ya da grupta miktarı olmayan birim atılır.
     - Yanıt okunamazsa ya da yapay zekâ kapalıysa uyarı gösterilir; öğrenilmiş ve anahtar sözcük önerileri sürer.
     - Her çağrı denetim kaydına `ai.poz_suggest` olarak yazılır.
   - **Anahtar Sözcük:** pozun tanımında sınıf sözcüğü (duvar, döşeme, kolon, kiriş, kapı, pencere…), malzeme sözcükleri (beton, c30, gazbeton…) ve tip sözcükleri aranır.
     - Uygun birim (betonarmede m³, kapı / pencerede adet, kâgir duvarda m²) puanı artırır.
     - Gerekçede eşleşen sözcükler yazar.
4. **Onay.**
   - Kullanıcı satırın pozunu değiştirebilir; miktar ve tutar yeniden hesaplanır.
   - Satırı kaldırabilir ya da **Reddet** diyebilir. Reddedilen poz o grup için bir daha önerilmez.
   - **Seçilenleri Kurala Çevir** seçili satırları maliyet kuralı yapar ve hafızaya yazar. Aynı eşleme tekrar onaylanırsa onay sayısı artar.
   - Denetim kaydı: `cost.poz_suggestions_accepted`, kaynak dağılımıyla.

## Hafıza (Öğrenilen Eşlemeler)

- Tablo `poz_mappings` (göç `0045_poz_mappings`).
- Satırın alanları: sınıf, katlanmış tip ve malzeme anahtarı, poz no, tanım, birim, miktar kaynağı, karar (onaylandı / reddedildi), onay sayısı, son projesi.
- Kurulumdaki tüm projelerde ortaktır.
- Satır, ilk öğrenildiği projeye aittir. Başka bir projede aynı eşleme yeniden onaylanırsa yalnızca onay sayısı artar;
  başka proje satırın kararını, miktar kaynağını ya da sahibini değiştiremez (sistem yöneticisi hariç). Bir projenin
  reddi yalnızca o projede öneriyi gizler.
- Planlayıcı listeyi görür. Satırı yalnızca sahibi olan projenin planlayıcısı ya da sistem yöneticisi siler; silinemeyen
  satırda ✕ görünmez (`deletable`).
- Silmek mevcut maliyet kurallarını değiştirmez.

## API

| Yöntem | Yol | Not |
|---|---|---|
| POST | `/projects/:pid/cost-rules/suggest` | `{ versionId, ai? }` → öneriler, önerisiz gruplar, `covered`, `ai { used, model?, error? }` |
| POST | `/projects/:pid/cost-rules/suggest/accept` | `{ versionId, suggestions: [{ class, type, material, match, costItemId, quantity, multiplier, source }] }` → oluşan kurallar |
| POST | `/projects/:pid/cost-rules/suggest/reject` | `{ class, type, material, costItemId }` |
| GET | `/projects/:pid/poz-mappings` | hafıza (son 500) |
| DELETE | `/projects/:pid/poz-mappings/:id` | aynı proje planlayıcısı ya da sistem yöneticisi |

Kod: Cost modülü ([sitekeep-cost](../modules/cost.md)) `server/fived/poz.ts` (gruplar, puanlama, hafıza,
yapay zekâ), `server/fived/routes.ts`, `web/fived/PozSuggest.tsx`; ortak tipler `packages/shared/src/schedule/poz.ts`.

## Testler

- Birim: `apps/server/test/simulation/poz.test.ts`.
  - Gruplar ve tam kural.
  - Birim → miktar eşlemesi.
  - Anahtar sözcük seçimi ve tutar.
  - Ret.
  - Hafıza düzeyleri ve proje arası poz no eşleşmesi.
  - Sahte sağlayıcıyla yapay zekâ seçimi, uydurma kodun atılması ve okunamayan yanıt.
- API: `apps/server/test/simulation/poz-api.test.ts`.
  - Sağlayıcı yokken anahtar sözcük.
  - Yalnız planlayıcı.
  - Onay → kural, önizleme toplamı ve denetim kaydı.
  - Ret.
  - Başka projede hafıza ve onay sayısı.
  - Sahte yerel modelle yapay zekâ ve bozuk yanıtta geri düşme.
  - Eşleme silme yetkisi.
- E2E (masaüstü): `e2e/specs/poz-suggest.spec.ts`.
  - Metraj → Poz Öner.
  - Poz değiştirme, ret, seçim toplamı, kurala çevirme.
  - İkinci projede "Öğrenilmiş".
  - Maliyet (5D) kuralları ve Öğrenilen Eşlemeler'den silme.
- E2E (iPhone): `e2e/specs/mobile-poz-suggest.spec.ts`. Kart görünümü, yana kaymama, tek satırı kurala çevirme.
- Fikstür: `apps/server/test/fixtures/poz.ifc`.
  - Perde ve gazbeton duvar tipleri.
  - Kapı ve pencere tipleri.
  - Tipsiz bir pencere (ayrılamayan grup).
  - Korkuluk (uygun poz yok).

## Sınırlar

- Kural tek özellik koşulu taşır. Aynı tipin farklı malzemeli elemanları ayrı gruptur ama tip kuralı ikisini birden seçer; bu durumda malzeme ya da sınıf denenir, olmazsa grup önerisiz kalır.
- Hafıza poz numarasıyla taşınır; listelerde poz no boşsa yalnızca aynı kalem kodu eşleşir.
