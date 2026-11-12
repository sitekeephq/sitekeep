# SiteKeep — yük ve stres testleri (k6)

`cde.js`, gerçek kullanıcı karışımını taklit eder: klasör gezme, arama, kimlik kontrolü ve isteğe bağlı yükleme. Profil ve eşikler dosyanın başında tanımlı. Tasarım ve hedefler: `docs/planning/GUVENLIK_UYUM_VE_STRES_TESTI.md` §3.

## Hazırlık
1. **Ortam:** canlıya benzer **ayrı bir test sunucusu**. PGlite değil PostgreSQL; aynı CPU, RAM ve disk. `stress`, `spike` ve `soak` profilleri **canlıda çalıştırılmaz**.
2. **Veri:** gerçekçi hacim; ör. 50 proje, 100 bin dosya, 500 IFC. Geliştirici araçlarıyla (`cde_dev_seed`) ya da demo içe aktarıcıyla üretilir. Müşteri verisi kullanılmaz.
3. **Jeton:** test kullanıcısı için Hesabım → API Belirteçleri'nden **salt okuma** jetonu alın. `UPLOAD=1` için okuma + yazma jetonu ve bir test klasörü gerekir. Jetonu dosyaya yazmayın; ortam değişkeniyle verin.
4. **Kurulum:** k6 ([k6.io](https://k6.io), açık kaynak, AGPL; ayrı program olarak çalışır).

## Çalıştırma
```bash
k6 run -e CDE_URL=https://staging.ornek -e CDE_TOKEN=$CDE_TOKEN -e CDE_PROJECT=PKF-DEMO -e PROFILE=smoke load/k6/cde.js
```

| Profil | Ne yapar |
|---|---|
| `smoke` | 2 kullanıcı, 1 dk: betik ve ortam çalışıyor mu (her PR'da) |
| `load` | 200 eşzamanlı kullanıcı, 30 dk: beklenen yük |
| `stress` | 200 → 1200 kullanıcı: kırılma noktası ve bozulma biçimi |
| `spike` | 20 → 500 ani artış: sabah girişleri |
| `soak` | 100 kullanıcı, 8 saat: bellek ve bağlantı sızıntısı |

Ek değişkenler:
- `UPLOAD=1`: isteklerin %5'i 256 KB yükleme yapar.
- `WIP_FOLDER=<klasör id>`: yükleme hedefi.
- `SEARCH_TERMS=a,b,c`: arama kelimeleri.

## Sonuçlar
- Her çalıştırma `load/k6/results/<profil>-<zaman>.json` dosyasına yazılır (git dışı).
- Eşikler aşılırsa k6 hata koduyla çıkar; CI'da adım kırmızı olur.
- Rapor için `docs/planning/GUVENLIK_UYUM_VE_STRES_TESTI.md` §3.6'daki şablon kullanılır.
- Test sırasında sunucu tarafı da izlenmeli: CPU, RAM, disk G/Ç, veritabanı bağlantıları, yavaş sorgular, iş kuyruğu birikmesi (IFC → Fragments, DWG, önizleme).

## Sonra eklenecek senaryolar
- Büyük dosya yükleme (300 MB IFC, 170 MB DXF) ve dönüştürme süresi.
- Model ve çizim açma (Fragments ve 2B sahne indirme).
- İnceleme/onay akışı, form doldurma, rapor paneli sorgusu.
- OpenCDE Documents API yükleme (AEC Pilot akışı).
- Yapay zekâ istekleri: ayrı ölçülür, GPU'ya bağlı.
- Tarayıcı tarafı: mevcut Playwright testleriyle sayfa açılış süreleri.
