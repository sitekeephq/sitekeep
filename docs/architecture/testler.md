# Testler: unit, e2e ve smoke

Bu belge bağlayıcıdır. Yeni bir ekran, yeni bir rota veya kullanıcıya görünen bir geliştirme
bitmiş sayılmaz; aşağıdaki üç katman yazılmadan ve Node.js 22 ile çalıştırılmadan kapanmaz.
Ayrıntılı komutlar ve dal akışı için Geliştirme iş akışı,
dizin sahipliği için [Depo yapısı](structure.md), Playwright kurulumu için
[E2E rehberi](../../e2e/README.md).

Üçü birlikte şunu gösterir: yazılan yollar kırık değildir. Yazılmayan dal, Safari ve
geliştiricinin kendi veritabanı bu koşunun dışındadır. E2E boş, izole bir veritabanı kullanır.

## 1. Ne zaman zorunlu

Zorunlu:

- Yeni sayfa, sekme, diyalog veya menü rotası.
- Var olan ekranda kaydetme, liste, hesap, onay, silme veya yetki değişikliği.
- Bu ekranın dayandığı saf kural (tutar, miktar, doğrulama, durum geçişi).

Güncelleme yeter, yeni dosya şart değil: ekranın unit, e2e ve smoke testi zaten varsa
yeni davranışı o testlere ekle. Atlama gerekçesi Pull Request gövdesinde yazılır;
"sonra ekleriz" gerekçe değildir.

Zorunlu değil:

- Yalnızca yorum, belge veya kullanıcıya görünmeyen yeniden adlandırma. Mevcut testler yine çalışır.
- Ekranı olmayan saf hesap. Bunun unit testi zorunludur; e2e ve smoke ancak bir sayfa da değiştiyse eklenir.
- Google girişi, Autodesk, canlı OpenCDE, Office dönüştürücü, SMTP ve yapay zekâ sağlayıcısı.
  E2E sunucusu bunları kapatır. Sınırları sunucu testi veya kasıtlı bir entegrasyon ortamı karşılar.

## 2. Üç katman

### 2.1 Unit

Saf kural ve kayıt sözleşmesi. Ekran boyutu burada yoktur.

| Ne | Nereye | Komut |
|---|---|---|
| Para, miktar, doğrulama, durum | `packages/shared/test/` | `npm test -w @sitekeep/shared -- test/<dosya>.test.ts` |
| HTTP, yetki, veritabanı, hata kodu | `apps/server/test/<alan>/` | `npm test -w @sitekeep/server -- test/<alan>/<dosya>.test.ts` |
| Web'de saf yardımcı (ayrıştırma, biçim) | `apps/web/test/<alan>/` | `npm test -w @sitekeep/web -- test/<alan>/<dosya>.test.ts` |

Bir ekranın unit'i en az şunları tutar:

- Doğru girdi, beklenen sonuç.
- Boş, hatalı veya sınır değer. Sayıysa yuvarlama.
- Yetki: proje yöneticisi yazar, üye okur, yabancı ve anonim giremez. Sunucu testi bunu karşılar.

Sunucu testi Türkçe sabit metin gömmez. Metin `msg("ns:key")` ile gelir. Ayrıntı
[i18n](i18n.md).

### 2.2 E2E

Kullanıcının asıl yolu, üretim derlemesine karşı, Chromium masaüstünde.

- Dosya: `e2e/specs/<alan>.spec.ts`. `mobile-` ile başlayan ad kullanma; o ad telefon projesine gider.
- Seçiciler rol, etiket ve görünen Türkçe metindir (`getByRole`, `getByLabel`, `getByText`).
- Yolu tarayıcı tıklar. Pahalı hazırlığı izole API kurabilir; sınanan davranış API ile değiştirilmez.
- Canlı, paylaşılan veya müşteri verisi kullanılmaz.

Bir ekranın masaüstü e2e dosyası en az şunları bir kez geçer:

1. Boş ekran metni.
2. Oluştur, listede gör, ayrıntıyı aç.
3. Hatalı kayıt reddedilir ve ekranda hata kalır.
4. Kaydet, beklenen tutar veya durum görünür.
5. Varsa onay, dışa aktarma veya silme. Silme sonrası liste boş duruma döner.

Komut, önce derleme:

```bash
npm run build
npm run e2e -- e2e/specs/<alan>.spec.ts
```

`e2e` hazır `apps/server/dist` ve `apps/web/dist` kullanır. Derlemeden koşmak eski ekranı test eder.

### 2.3 Smoke ve mobil

Smoke, sayfanın açıldığını ve telefonda kabaca sığdığını tutar. Formu doldurmaz.
Piksel karşılaştırması yoktur. Ekran görüntüsü yalnız test kırılınca yazılır.

Yeni rota `e2e/specs/mobile-smoke.spec.ts` içindeki `ROUTES` listesine eklenir.
Tur şunları doğrular: proje menüsü tıklanır, `.sidenav-current` o sayfanın adını gösterir,
sayfa yatay kaymaz. Sözleşme gibi adı olan bir sayfada başlık da görünür olmalıdır.

Asıl düğmeler telefon ölçüsünde ayrı dosyadadır: `e2e/specs/mobile-<alan>.spec.ts`.
iPhone 13 Chromium projesi yalnız `mobile-*.spec.ts` dosyalarını çalıştırır.
Bu dosya en az şunları geçer:

- Sayfa ve oluşturma diyaloğu yatay kaymaz (`scrollWidth` pencereyi 1 pikselden fazla aşmaz).
- Sekmeler ve birincil kayıt düğmesi tıklanır.
- Bir alanı doldurup kaydedince sonuç ekranda görünür.

```bash
npm run e2e -- e2e/specs/mobile-<alan>.spec.ts
npm run e2e -- e2e/specs/mobile-smoke.spec.ts
```

Safari / WebKit yerelde kapalıdır. CI çalıştırır. Yerelde açmak: `E2E_SAFARI=1 npm run e2e -- --project=safari`.

## 3. Yeni ekran kontrol listesi

İş kapanmadan:

```text
[ ] Unit: doğru sonuç, boş/hatalı girdi, yetki (shared ve/veya server ve/veya web).
[ ] Masaüstü e2e: boş ekran, oluştur, hatalı kayıt, kaydet, varsa sil.
[ ] mobile-smoke ROUTES: yeni rota, menü adı, yatay taşma yok.
[ ] mobile-<alan>.spec.ts: diyalog sığar, ana düğme kaydeder, sonuç görünür.
[ ] Node 22 ile bu dosyalar çalıştı ve geçti.
[ ] npm test (ilgili workspace) ve değişen spec için npm run e2e geçti.
```

Üçü, o ekranda yazılan yolların kırık olmadığını gösterir. Geliştirici bir kez de
kendi proje verisiyle sayfayı telefonda açar. E2E o veriyi görmez.

## 4. Çalıştırma

Node varsayılanı 16 ise `tsc` kırılır. Kabukta Node 22 öne alınır, sonra komutlar çalışır.

```bash
npm test
npm run typecheck
npm run build
npm run e2e
```

Tek dosya, tüm depoyu beklemeden:

```bash
npm test -w @sitekeep/shared -- test/<dosya>.test.ts
npm test -w @sitekeep/server -- test/<alan>/<dosya>.test.ts
npm test -w @sitekeep/web -- test/<alan>/<dosya>.test.ts
npm run e2e -- e2e/specs/<alan>.spec.ts
```

Tam e2e, `npm run build` sonrasında. Port doluysa `E2E_PORT` boş bir porta çekilir.
Varsayılan `18080`.
