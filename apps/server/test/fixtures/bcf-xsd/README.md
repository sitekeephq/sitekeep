# BCF-XML şemaları ve örnek dosyalar (buildingSMART)

Bu klasördeki `.xsd` dosyaları ve `../bcf-samples/` içindeki `.bcf` dosyaları buildingSMART International'ın
[BCF-XML](https://github.com/buildingSMART/BCF-XML) deposundan **değiştirilmeden** kopyalandı (11.10.2026).

| Klasör | Kaynak |
|---|---|
| `2.1/` | `release_2_1` dalı, `Schemas/` (markup, visinfo, version, project) |
| `3.0/` | `release_3_0` dalı, `Schemas/` (tamamı) |
| `../bcf-samples/v21-*.bcf` | `release_3_0` dalı, `Test Cases/v2.1/…` (One part visible, user assignment) |
| `../bcf-samples/v30-*.bcf` | `release_3_0` dalı, `Test Cases/v3.0/…` (Orthogonal camera, Related topics) |

Lisans: © buildingSMART International Ltd., Creative Commons Attribution-NoDerivatives 4.0 International
(CC BY-ND 4.0), bkz. `LICENSE-buildingSMART.txt` (deponun `release_3_0/LICENSE` dosyası). `release_2_1` dalında
ayrı bir lisans dosyası yok; depo lisansı esas alındı. Dosyalar yalnız testlerde, birebir kopya olarak kullanılır.

Testler (`apps/server/test/bcf.test.ts`) dışa aktarılan XML'i bu şemalara karşı denetler. Denetleyici
`apps/server/test/xsd-lite.ts`: BCF şemalarının kullandığı XSD alt kümesini (sequence, choice, öznitelik,
desen, uzunluk, sayı sınırları, sayım) uygular; tanımadığı bir XSD yapısında hata verir.
