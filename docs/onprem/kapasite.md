# Kapasite ve Yük Testi (Yönetim ekranı)

SiteKeep müşteri sunucusuna **exe / kurulum paketi** ile kurulur. Müşteri “bu sunucu
kaç kişiyi taşır” sorusunun cevabını bizden beklemez: kurulum **kendi kendini
ölçer, raporlar ve eksikleri söyler.**

Yer: **Yönetim → Sistem Durumu** (`/projects/:id/sistem-durumu`, yalnız `isAdmin`).
**Kapasite** kartı, **Canlı Test Et**, **Kapasite Rehberi**, **Raporlar**.

Bu belge üç şeyi anlatır:

1. **Bugün ne var** (§1–§8): ekran, mimari, örnek test motoru. Çalışır, örnek veriyle.
2. **Gerçeğe geçmek** (§9): örnek motorun yerine gerçek ölçen motorlar.
3. **Exe yapısı** (§10): kurulum paketinin içi, servisler, kurulum sihirbazı,
   güncelleme ve bu özelliğin pakete nasıl girdiği.

İlgili: [İzleme](izleme.md) (aynı ekranın diğer kartları), [Yedekleme](yedekleme.md),
`load/k6/` (bizim laboratuvar testlerimiz), arşivdeki
stres testi planı §3.

> Donanım sayıları **başlangıç önerisidir, ölçülmedi.** Ekranda “Tahmini Tablo”
> yazar. Referans makinelerde ölçülünce (§9.6) `CAPACITY_MEASURED_AT` dolar ve
> etiket kalkar.

---

## 1. Durum (25.10.2026)

| Parça | Durum |
|---|---|
| Kapasite tablosu ve kurallar (`packages/shared/src/platform/capacity.ts`) | **var**, birim testli |
| Kapasite kartı: donanım, kullanıcı sayısı, eksik listesi | **var**, gerçek veri (geliştirmede örnek makine) |
| Yeni Kullanıcı penceresinde sınır uyarısı | **var** |
| Canlı Test Et: Hızlı Kontrol + Tam Yük Testi, canlı grafikler, Durdur | **var**, ekran gerçek; **ölçüm örnek** (`DemoEngine`) |
| Kapasite Rehberi (müşteriye görünen belge) | **var** |
| Rapor: HTML (yazdır → PDF) ve 7D paketi (JSON) | **var** |
| Gerçek Hızlı Kontrol (`QuickCheckEngine`) | yok, §9.2 |
| Gerçek yük motoru (`LoadTestEngine`) | yok, §9.3 |
| Kalıcı rapor geçmişi (`capacity_runs` tablosu) | yok, §9.4; testler bellekte, yeniden başlatınca gider |
| Exe | yok, §10 |

[izleme.md](izleme.md) §6 “canlıya k6 yok” der. Bu kural kalır: müşteri
sunucusunda k6 çalışmaz. Exe'ye **kendi küçük ve korumalı test motorumuz** girer;
k6 bizim laboratuvarda kalır ve o motoru doğrular (§9.6).

---

## 2. Terimler

| Terim | Ne | Nereden |
|---|---|---|
| **Kayıtlı kullanıcı** | kapalı olmayan hesap | `users.disabled = false` |
| **Aktif kullanıcı** | son 30 günde oturum açmış | `tokens` (kind `session`), `coalesce(last_used_at, created_at)` |
| **Eşzamanlı kullanıcı** | aynı dakikada istek atan | yük testi |

Kademe tablosu **kayıtlı kullanıcıya** göre yazılır (müşteri bunu bilir).
Varsayım: yoğun saatte kayıtlıların **%15'i** eşzamanlıdır (`CAPACITY_CONCURRENCY`).
Yük testi **eşzamanlı** sayıyı ölçer; kayıtlıya bu oranla çevrilir
(`registeredFromConcurrent`).

---

## 3. Kapasite tablosu

Tek kaynak: `CAPACITY_TIERS`. Ekran, uyarılar, rapor ve bu tablo aynı sayıyı
kullanır. `packages/shared/test/capacity.test.ts` bu tablonun sabitle aynı olduğunu
denetler: sayıyı değiştiren ikisini birlikte değiştirir.

### 3.1 Kademeler (tahmini)

| Kademe | Kayıtlı kullanıcı | Eşzamanlı (≈%15) | vCPU | RAM | Veri diski (SSD) | Veritabanı |
|---|---|---|---|---|---|---|
| Deneme | ≤ 10 | 2 | 2 | 8 GB | 100 GB | aynı makine |
| Küçük | ≤ 50 | 8 | 4 | 16 GB | 500 GB | aynı makine |
| Orta | ≤ 200 | 30 | 8 | 32 GB | 1–2 TB | aynı makine, ayrı disk önerilir |
| Büyük | ≤ 500 | 75 | 16 | 64 GB | 2–4 TB | ayrı disk; ayrı sunucu önerilir |
| Kurumsal | > 500 | 75+ | — | — | — | ön çalışma: ayrı veritabanı sunucusu, nesne depolama |

Ortak şartlar (`capacityCommonRequirements()`): 64 bit işletim sistemi; ağ en az
100 Mbit/sn (büyük IFC için 1 Gbit/sn); veri diski SSD; yedek hedefi ayrı; sanal
makinede sabit çekirdek (paylaşımlı “burst” değil, örnek: GCP `e2`).

### 3.2 Kullanıcıdan bağımsız olanlar

Disk kullanıcı sayısıyla değil **model hacmiyle** büyür:

```
gerekli veri diski ≈ (yüklenen dosyalar) × 1,6   // Fragments + önizleme türevleri
                    + veritabanı + %30 boş alan
```

| Ek yük | Etkisi | Ne lazım |
|---|---|---|
| Büyük IFC (300 MB+) dönüşümü | bir çekirdek ve 4–8 GB RAM dakikalarca dolu | Orta kademeden itibaren +4 GB pay |
| Ofis düzenleme (ONLYOFFICE / Collabora) | ayrı süreç, kendi RAM'i | ayrı makine önerilir; aynı makinede +8 GB |
| Yapay zekâ (yerel model) | GPU'ya bağlı | ayrı raporlanır; bu tabloya girmez |

### 3.3 Yönetim nasıl olmalı (Rehber'de müşteriye yazılan)

- Kapasite testini **ilk kurulumda**, **donanım değişince** ve **büyük sürüm
  yükseltmesinden sonra** çalıştırın. 90 günden eski test sarı görünür.
- Kullanıcı sayısı kademe sınırının %90'ına gelince donanım planlayın; sınırı
  aşınca uyarı kırmızıya döner.
- Tam Yük Testini **mesai dışında** çalıştırın; Hızlı Kontrol her zaman güvenlidir.
- Disk %80'i geçmeden genişletin.

---

## 4. Uyarılar

Tek saf fonksiyon: `evaluateCapacity({ hardware, counts, lastRun })`. Kart, rapor
ve test sonu aynı fonksiyonu çağırır. Kullanıcı kontrolü ayrıca `usersFinding`
olarak dışarı açık (Yeni Kullanıcı penceresi onu “eklemeden sonraki sayı” ile çağırır).

| Kontrol (`key`) | Sarı (`warn`) | Kırmızı (`danger`) | Eylem metni (örnek) |
|---|---|---|---|
| `users` kayıtlı / donanımın kademesi | sınırın %90'ı | sınırı aştı veya donanım en küçük kademenin altında | “Büyük kademesi: en az 16 vCPU, 64 GB RAM.” |
| `memory` RAM / gereken kademe | altında, ≥ %75'i | %75'in altında | “RAM'i en az 32 GB yapın.” |
| `cpu` vCPU / gereken kademe | altında | yarısının altında | “İşlemciyi en az 8 vCPU yapın.” |
| `disk` veri diski boş alan | < %20 | < %5 | “Veri diskini büyütün veya Bakım'dan türevleri temizleyin.” |
| `test` son kapasite testi | hiç yok / 90 günden eski | — | “Canlı Test Et ile ölçün.” |
| `measured` ölçülen kayıtlı / aktif | ölçülen < aktif × 1,2 | ölçülen < aktif | “Ölçülen kapasite aktif kullanıcıya yetmiyor.” |

İşletim sistemi takılı RAM'den biraz az gösterir (16 GB → ~15,6 GB); karşılaştırma
%10 pay bırakır. Docker içinde `os.totalmem()` makineyi gösterir; sunucu cgroup v2
sınırını (`/sys/fs/cgroup/memory.max`, `cpu.max`) okur ve küçük olanı alır.

**Yeni Kullanıcı.** Ekleme sınırı geçirecekse pencerenin üstünde sarı/kırmızı bant:
“Bu ekleme ile 212 kullanıcı · sunucu 200 kullanıcıya göre. Sınır aşıldı. Büyük
kademesi: …”. **Engellemez** (karar §11-1).

**Canlı sunucu örneği.** sitekeep.ornek.com `e2-medium` (2 vCPU, 4 GB): kart
kırmızı der, çünkü en küçük kademe 8 GB ister. Bu doğru sonuçtur.

---

## 5. Ekran

Kod: `apps/web/src/features/admin/pages/AdminCapacity.tsx`; Sistem Durumu
(`AdminStatus.tsx`) Kaynaklar kartının altına `<CapacityCard />` koyar.

| Parça | Ne gösterir |
|---|---|
| **Kapasite kartı** | renk, “Örnek Veri” / “Tahmini Tablo” etiketleri, sunucunun kademesi, kayıtlı / aktif sayı, son test; altında eksik listesi (konu · durum · ne yapılmalı) |
| **Canlı Test Et** | kip seçimi (Hızlı Kontrol / Tam Yük Testi). Tam Yük Testi “Mesai Dışındayım” onayı ister; kurulumda kapalıysa seçilemez |
| Hızlı Kontrol çalışırken | ilerleme çubuğu, aşama, 6 ölçüm satırı tek tek dolar |
| Tam Yük Testi çalışırken | 4 canlı grafik (p95 yanıt süresi + sınır çizgisi, sanal kullanıcı, istek/sn, işlemci + sınır), basamak tablosu, **Durdur** |
| Test bitince | sonuç (“~30 eşzamanlı · ~200 kayıtlı”), durma nedeni, eksikler, **Raporu İndir**, **7D Paketini İndir**, **Yeni Test** |
| **Kapasite Rehberi** | kademe tablosu (bu sunucu yeşil, gerekip karşılanmayan sarı), ortak şartlar, disk hesabı, yönetim kuralları, uyarıların anlamı |
| **Raporlar** | testlerin listesi ve rapor indirme |

Grafikler kütüphanesiz SVG (`LineChart`); ana paket büyümez. Telefon görünümünde
tablolar kart olur (`phone-cards`), grafikler tek sütun.

Pencere kapansa da test sunucuda sürer; kart “Testi İzle” der ve pencere kaldığı
yerden izler.

---

## 6. Mimari

```
 tarayıcı (AdminCapacity.tsx)
   │  GET  /admin/capacity            kart
   │  POST /admin/capacity/runs       başlat ──────────────┐
   │  GET  /admin/capacity/runs/:id   saniyede bir sor     │
   ▼                                                       ▼
 capacity/routes.ts ── snapshot.ts (donanım, sayılar)   runs.ts  CapacityRuns
        │                                                  │  tek test, Durdur (AbortSignal),
        │                                                  │  son 20 test (bellekte)
        └── evaluateCapacity (shared) ◄── bitince ─────────┤
                                                           ▼
                                                 CapacityEngine (engine.ts)
                                                  ├─ DemoEngine          bugün
                                                  ├─ QuickCheckEngine    §9.2
                                                  └─ LoadTestEngine      §9.3
```

| Dosya | Görev |
|---|---|
| `packages/shared/src/platform/capacity.ts` | tablo, sınırlar, `evaluateCapacity`, `usersFinding`, DTO'lar |
| `apps/server/src/admin/capacity/snapshot.ts` | `readHardware` (os + cgroup + disk), `readCounts`; geliştirmede örnek makine |
| `apps/server/src/admin/capacity/engine.ts` | `CapacityEngine` arayüzü, `pause` |
| `apps/server/src/admin/capacity/demo-engine.ts` | örnek motor: sunucunun gerçek donanımına göre inandırıcı eğri, hiç istek atmaz |
| `apps/server/src/admin/capacity/runs.ts` | `CapacityRuns`: başlat, tek seferde bir (409), iptal, geçmiş |
| `apps/server/src/admin/capacity/report.ts` | HTML rapor (tek dosya, SVG grafik) ve 7D JSON paketi |
| `apps/server/src/admin/capacity/routes.ts` | uçlar, yetki, denetim kaydı (`capacity.run`) |

### 6.1 API (yalnız `isAdmin`)

| Uç | Ne |
|---|---|
| `GET /admin/capacity` | `AdminCapacityDto`: donanım, sayılar, renk, gereken / donanım kademesi, eksikler, son ve süren test |
| `GET /admin/capacity/runs` | geçmiş, yeni önce (saniyelik noktalar hariç) |
| `POST /admin/capacity/runs` `{ mode: "quick" \| "load" }` | başlatır; biri sürüyorsa 409; `CAPACITY_LOAD_TEST=0` iken `load` 400 |
| `GET /admin/capacity/runs/:id` | tek test, tüm noktalarla; ekran saniyede bir sorar |
| `POST /admin/capacity/runs/:id/cancel` | Durdur |
| `GET /admin/capacity/runs/:id/report?format=html\|json` | rapor indirir; test sürerken 400 |

Neden SSE değil sorma (polling): nginx/IIS arkasında ayar istemez, saniyede bir
küçük JSON yeter, `app.inject` ile test edilir. 1800 noktadan (30 dk) fazlası
tutulmaz.

### 6.2 Motor arayüzü

```ts
interface CapacityEngine {
  readonly demo: boolean;                          // true → her yerde "örnek veri"
  run(ctx: CapacityEngineContext): Promise<{ status: "passed" | "limited"; result }>;
}
interface CapacityEngineContext {
  mode: "quick" | "load";
  hardware: CapacityHardware;
  signal: AbortSignal;                             // Durdur
  setStage(stage: string, progress: number): void;
  setCheck(check: CapacityCheck): void;            // Hızlı Kontrol satırı
  sample(s: CapacitySample): void;                 // saniyelik nokta (grafik)
  step(s: CapacityStep): void;                     // basamak özeti (tablo)
}
```

Motor yalnız ölçer ve bildirir; kayıt, tek-test kuralı, iptal ve bitişte
`evaluateCapacity` `CapacityRuns`'tadır. Gerçek motor yazan bu dosyalara dokunmaz.

### 6.3 Ayarlar

| Değişken | Varsayılan | Ne |
|---|---|---|
| `CAPACITY_LOAD_TEST` | açık | `0`: Tam Yük Testi bu kurulumda kapalı |
| `CAPACITY_DEMO_TICK_MS` | 250 | örnek motorda bir “saniye” kaç ms (e2e 25, birim test 1) |
| `STATUS_DEMO` | geliştirmede açık | kart örnek makine (8 vCPU, 32 GB, 164 kullanıcı) gösterir; üretimde `0` |

### 6.4 Rapor ve gizlilik

Raporda proje adı, dosya adı, kişi adı / e-posta, IP, sır **yok**; yalnız sayılar.
7D paketi ayrıca disk yolunu ve testi başlatanı çıkarır. Paketi yönetici indirip
kendisi gönderir; kurulum 7D'ye hiçbir şey göndermez ([izleme.md](izleme.md) §1).

---

## 7. Testler

| Test | Ne denetler |
|---|---|
| `packages/shared/test/capacity.test.ts` | kademe seçimi, RAM payı, her uyarı satırı ve sınır değeri, oran, **belge tablosu = sabit** |
| `apps/server/test/platform/admin-capacity.test.ts` | yetki, gerçek donanım / sayım (kapalı hesap sayılmaz), Hızlı Kontrol 6 ölçüm, yük testinde ilk sınır basamağında durma ve sonuç hesabı, tek test (409), Durdur, `CAPACITY_LOAD_TEST=0`, HTML + JSON rapor (disk yolu yok) |
| `e2e/specs/capacity.spec.ts` | kart → Rehber → Hızlı Kontrol → Tam Yük Testi (onay, canlı grafik, sınır) → rapor indirme → kartta son test |
| `e2e/specs/mobile-capacity.spec.ts` | telefonda kart, Rehber (yana kaydırma yok), Hızlı Kontrol |

---

## 8. Sınırlar (bugün)

- Ölçüm **örnek**. Ekranda, raporda ve pakette bu yazar; satış demosu için yeterli,
  müşteriye “ölçüldü” denemez.
- Testler bellekte; sunucu yeniden başlayınca geçmiş gider (Raporlar penceresi
  bunu söyler).
- Sistem Durumu'nun üstteki genel rengi kapasiteyi henüz içermez (kartın kendi
  rengi var). §9.5.

---

## 9. Gerçeğe geçmek

Sıra: Hızlı Kontrol → kalıcı kayıt → yük motoru → laboratuvar. Her adım tek başına
canlıya çıkabilir; motor değişince ekran ve API değişmez.

### 9.1 Motor seçimi

`routes.ts`'te bugün `new DemoEngine(...)` var. Hedef:

```ts
const engine = process.env.CAPACITY_ENGINE === "demo" || capacityDemoOn()
  ? new DemoEngine(...)
  : new CompositeEngine({ quick: new QuickCheckEngine(deps), load: new LoadTestEngine(deps) });
```

Satış demosunda `CAPACITY_ENGINE=demo` kalır.

### 9.2 QuickCheckEngine (1–2 dk, canlıda güvenli)

Her ölçüm `setCheck` ile bir satır doldurur. Proje verisine dokunmaz; yazdığı her
şeyi `finally` içinde siler.

| Ölçüm | Nasıl | Eşik (öneri) |
|---|---|---|
| Donanım | `readHardware` + `hardwareTier` | kademe yoksa kırmızı |
| İşlemci | `worker_threads` ile çekirdek başına 3 sn `crypto.createHash("sha256")` döngüsü; tek ve toplam puan | referansın %60'ı altı sarı (burst / zayıf çekirdek) |
| Disk | veri klasörüne `capacity-<id>.bin` 256 MB yaz, `fsync`, oku, sil; 100 × 4 KB `fsync` gecikmesi | yazma < 100 MB/sn sarı, < 30 kırmızı; fsync p95 > 10 ms sarı |
| Veritabanı | 200 × `select 1`; geçici tabloya 100 satır yaz-geri al (transaction rollback) | p95 > 10 ms sarı, > 50 ms kırmızı |
| IFC dönüşümü | pakette gelen `capacity-sample.ifc`'yi (≈20 MB, bizim örnek bina) `runIfcWorker` ile dönüştür, çıktıyı sil | süre referansın 2 katı → sarı |
| Bellek payı | boş RAM − (kademe RAM × 0,6) | < 4 GB sarı, < 2 GB kırmızı |

Referans değerler laboratuvarda (§9.6) çıkar ve `CAPACITY_REFERENCE` sabitine yazılır.

### 9.3 LoadTestEngine (10–20 dk, bakım penceresi)

**Ayrı süreç.** `child_process.fork("capacity-runner.js")`. Yük üreten kod ana
sunucuyla aynı event loop'ta olursa sonucu bozar. Runner, sunucuya
`http://127.0.0.1:<PORT>` üzerinden istek atar (TLS / proxy dışında: uygulamanın
kendisi ölçülür; ağ ayrı raporlanır). Runner ↔ motor arası `process.send` ile
saniyelik nokta.

**İstemci.** Node 22'nin `fetch`'i + `undici.Agent({ connections: N })`. Her sanal
kullanıcı: istek → bekle (0,5–2 sn “düşünme”) → istek. Gecikmeler saniyelik
kovaya; p50/p95/p99 sıralanmış diziden (bir saniyede en çok birkaç bin değer).

**Senaryo karışımı** (k6 `cde.js` ile aynı, karşılaştırılabilsin diye):

| Senaryo | Pay | İstek |
|---|---|---|
| Klasör gezme, arama, oturum | %80 | `GET /projects/:id/folders/:f/contents`, `GET /search`, `GET /auth/me` |
| Model açma | %10 | `GET /versions/:v/model` (Fragments indirme) |
| Küçük yükleme | %5 | 256 KB dosya, test klasörüne |
| Form / inceleme / rapor | %5 | liste uçları |
| Arka planda | sürekli | 1 IFC dönüşümü kuyrukta |

**Test verisi.** Test başında sistem projesi `CAPACITY` (gizli: listede, aramada,
lisans sayımında görünmez) ve `capacity@localhost` kullanıcısı (kapalı hesap; yalnız
runner'ın kısa ömürlü API belirteci). Proje, `capacity-sample.ifc` ve 200 küçük
dosyayla bir kez kurulur, sonra yeniden kullanılır. Test sonunda yüklenen dosyalar
ve iş satırları silinir; açılışta yarım kalan test (`status = running`) `cancelled`
yapılır ve temizlenir.

**Basamaklar.** 5 → 10 → 15 → 20 → 30 → 40 → 50 → 75 → 100 → … her biri 60–90 sn;
ilk 20 sn ısınma, ölçüme girmez. Üst sınır: donanım kademesinin eşzamanlı sayısının
2 katı.

**Durma kuralları** (`CAPACITY_LIMITS`; biri tutarsa o basamakta durur, kapasite =
son geçen basamak):

- p95 > 500 ms, p99 > 1,5 sn, hata > %0,1;
- işlemci > %90 (30 sn) veya boş RAM < %10;
- **gerçek trafik:** Fastify `onRequest` kancası test başlığı (`x-cde-capacity: <run id>`)
  taşımayan istekleri sayar; son 2 dk'da eşiği geçerse test durur
  (“Gerçek kullanıcılar çalışıyor”);
- Durdur.

**Kaynak örneği.** Motor saniyede bir `os.cpus()` farkından işlemci %'si, boş RAM,
olay döngüsü gecikmesi (`perf_hooks.monitorEventLoopDelay`) okur. Aynı örnekleyici
Sistem Durumu'ndaki `cpu: null` alanını da doldurur.

### 9.4 Kalıcı kayıt

`capacity_runs` tablosu (drizzle + migration):

| Sütun | Tip |
|---|---|
| `id` | uuid |
| `mode`, `status` | text |
| `demo` | boolean |
| `started_at`, `finished_at` | timestamptz |
| `started_by` | uuid → users |
| `app_version` | text |
| `hardware`, `checks`, `steps`, `result`, `findings` | jsonb |
| `samples` | jsonb (en çok 1800 nokta; ~150 KB) |

`CapacityRuns` içindeki `Map` bir `CapacityRunStore` arayüzüne çekilir
(`get/list/save`); bellek ve veritabanı uygulaması. Süren testin canlı noktaları
bellekte kalır, bitince yazılır. Saklama: son 50 test.

### 9.5 Bağlantılar

- Sistem Durumu üst rengi: `adminStatus` kartın `level`'ını da hesaba katar.
- E-posta: kart kırmızıya dönünce yöneticilere (mevcut SMTP); haftada bir özet.
- Zamanlanmış Hızlı Kontrol: ayda bir, gece, `jobs` kuyruğunda `capacity_check`.
- Bildirim: kırmızı bulgu “Görevlerim”de yöneticiye görev olarak da düşebilir.

### 9.6 Laboratuvar (7D)

1. Her kademe için sabit çekirdekli bir VM (ör. GCP `n2-standard-2/4/8/16`),
   PostgreSQL, gerçekçi hacim (demo üreticiyle; müşteri verisi yok).
2. `load/k6/cde.js` → `load` + `stress`: kırılma noktası.
3. Aynı makinede yerleşik Tam Yük Testi: sonuç k6'dan en çok %20 sapmalı; sapıyorsa
   runner düzeltilir.
4. Ölçülen sayılar `CAPACITY_TIERS` ve §3.1'e (test ikisini birlikte ister),
   `CAPACITY_MEASURED_AT`'e tarih; Hızlı Kontrol referansları `CAPACITY_REFERENCE`'a.
5. Her büyük sürümden önce tekrar; sonuç sürüm notuna.

---

## 10. Exe yapısı

Hedef: müşteri BT'si **tek dosyayı çalıştırır**, sihirbazı bitirir, tarayıcıdan
CDE'ye girer. Docker, Node, PostgreSQL bilgisi istemez. Aynı paket güncellemede
de kullanılır.

### 10.1 Seçim

| Seçenek | Artı | Eksi | Öneri |
|---|---|---|---|
| **Windows: yerel servisler** (Node + PostgreSQL ikilileri + Windows servisi) | müşteri BT'sinin bildiği; Docker yok | Windows'a özgü yollar, servis yönetimi bizde | **ana yol** (“exe”) |
| Linux: `.deb` / `.rpm` + systemd | aynı mimari, daha az sürtünme | Türkiye'de kamu/kurumda Windows Server ağırlıklı | ikinci paket, aynı içerik |
| Docker paketi (`docker save` imajları + compose) | bugünkü canlı kurulumla aynı | müşteride Docker bilgisi ister | yalnız Linux, isteyen müşteriye |

Aşağısı Windows içindir; Linux'ta servis = systemd birimi, dizinler `/opt`, `/var/lib`.

### 10.2 Paketin içi

```
7D-CDE-Setup-1.4.0.exe            (Inno Setup, imzalı)
└─ C:\Program Files\SiteKeep\        ← uygulama (güncellemede değişir)
   ├─ node\node.exe                 Node 22 LTS, sürümü sabit
   ├─ app\server\                   apps/server/dist + üretim node_modules
   ├─ app\web\                      apps/web/dist (WEB_DIST)
   ├─ app\mcp\                      isteğe bağlı
   ├─ app\assets\                   web-ifc .wasm, fragments-worker.mjs, capacity-sample.ifc
   ├─ pgsql\                        PostgreSQL 17 Windows ikilileri (EDB zip)
   ├─ winsw\                        WinSW (servis sarmalayıcı) + servis XML'leri
   ├─ tools\sitekeep.exe              yönetim komutu (Node SEA): backup, restore, capacity, doctor
   └─ capacity-tiers.json           CAPACITY_TIERS'ın derleme anındaki kopyası (kurulum öncesi kontrol)

└─ C:\ProgramData\SiteKeep\          ← veri (güncellemede ve kaldırmada korunur)
   ├─ config\app.env                ayarlar (bugünkü /opt/sitekeep/app.env karşılığı)
   ├─ config\secret.key             CDE_SECRET_KEY (yalnız SYSTEM + Administrators)
   ├─ pgdata\                       veritabanı
   ├─ storage\                      yüklenen dosyalar, türevler (DATA_DIR)
   ├─ backups\                      yerel yedek (hedef ayrıca NAS/SFTP/S3)
   ├─ logs\                         uygulama ve servis günlükleri (döner)
   └─ license\license.json          imzalı lisans dosyası
```

Neden `node.exe` + dosyalar (tek SEA ikilisi değil): `worker_threads` ile IFC işçisi,
`.wasm` ve `node_modules` içindeki yerel modüller tek dosyada sorun çıkarır; klasör
düzeni hata ayıklamayı da kolaylaştırır. Tek dosya yalnız küçük yönetim komutu için.

### 10.3 Servisler

| Servis | Ne | Bağımlılık | Hata olunca |
|---|---|---|---|
| `7dcde-db` | `pg_ctl` ile PostgreSQL, `127.0.0.1:55432` (dışarı kapalı) | — | WinSW 10 sn sonra yeniden başlatır |
| `7dcde-app` | `node.exe app\server\index.js`, `app.env` okur | `7dcde-db` | aynı; 3 kez üst üste düşerse olay günlüğü + Sistem Durumu kırmızı |
| `7dcde-office` (isteğe bağlı) | ONLYOFFICE Document Server Windows | — | ayrı makine önerilir |

HTTPS: uygulama `127.0.0.1:8080`'de dinler; önünde ya müşterinin IIS / reverse
proxy'si ya da pakette gelen Caddy (`7dcde-proxy`, sertifika dosyası veya iç CA).
Sihirbaz Windows Güvenlik Duvarı'nda yalnız 443'ü açar.

### 10.4 Kurulum sihirbazı

1. **Ön kontrol** (kurmadan önce): Inno Setup betiği `capacity-tiers.json` ile
   çekirdek, RAM, hedef diskin boş alanını ve işletim sistemini okur. Tahmini
   kullanıcı sayısını sorar; karşılamıyorsa **uyarı sayfası** (“200 kullanıcı için
   32 GB RAM gerekir, bu sunucuda 16 GB var”): *Yine de kur* / *Vazgeç*. Kurulumu
   engellemez.
2. Dizin seçimi (veri diski ayrı sürücü önerilir: `D:\SiteKeep Data`).
3. Adres ve sertifika: alan adı, sertifika dosyası veya “iç ağ, kendinden imzalı”.
4. İlk yönetici hesabı (e-posta, geçici şifre; ilk girişte değişir).
5. Lisans dosyası.
6. Yedek hedefi (sonra da değişir).
7. Kurulum: dosyalar → `initdb` (rastgele DB şifresi `app.env`'e) → `secret.key`
   üret → servisleri kaydet ve başlat → `GET /api/v1/health` bekle (en çok 2 dk).
8. **İlk Hızlı Kontrol:** sihirbaz `sitekeep.exe capacity --quick --report
   "%ProgramData%\SiteKeep\reports\ilk-kurulum.html"` çalıştırır, sonucu son sayfada
   gösterir (yeşil/sarı/kırmızı + eksikler) ve “Raporu Aç” düğmesi verir. Aynı test
   Sistem Durumu → Kapasite → Raporlar'da görünür.
9. Bitir → tarayıcıda `https://<adres>` açılır.

### 10.5 Yönetim komutu (`sitekeep.exe`)

Tarayıcısız BT ve destek için; sunucunun yerel API'sine `127.0.0.1` üzerinden
**kurulum belirteci** ile bağlanır (yalnız yerel, `config\local.token`, SYSTEM'e açık).

| Komut | Ne |
|---|---|
| `sitekeep status` | servisler, sağlık, sürüm, lisans |
| `sitekeep capacity --quick [--report dosya.html]` | Hızlı Kontrol; çıkış kodu 0 yeşil / 1 sarı / 2 kırmızı |
| `sitekeep capacity --load --yes` | Tam Yük Testi (bakım penceresinde) |
| `sitekeep backup now` / `restore <dosya>` | [yedekleme.md](yedekleme.md) |
| `sitekeep doctor` | destek paketi: günlükler (maskeli), kapasite raporu JSON, ayarlar (sırlar hariç) |

Uç: `POST /api/v1/admin/capacity/runs` aynı uçtur; komut yalnız yerel belirteçle
yönetici yerine geçer. Böylece sihirbaz, komut ve ekran tek motoru kullanır.

### 10.6 Güncelleme

Aynı exe'nin yeni sürümü:

1. Sürüm kontrolü (eski → yeni; major atlama varsa uyarı).
2. `sitekeep backup now` (veritabanı + `secret.key`; dosyalar yerinde kalır).
3. `7dcde-app` durur → `Program Files` değişir → servis başlar → migration'lar
   açılışta uygulanır (bugünkü davranış) → sağlık beklenir.
4. Sağlık 2 dk içinde gelmezse **geri al**: eski uygulama klasörü
   (`Program Files\SiteKeep\.previous`) geri konur, yedekten veritabanı döner
   (bugünkü `deploy.sh --rollback` mantığı).
5. Kapasite: büyük sürümde sihirbaz Hızlı Kontrolü yeniden çalıştırır; kart
   “sürüm değişti” notuyla testi sarıya çeker.

Kaldırma `ProgramData`'yı **silmez**; ayrı “verileri de sil” onayı ister.

### 10.7 Derleme hattı (CI)

GitHub Actions, `windows-latest`:

1. `npm ci`, `npm run build`, `npm test`.
2. `npm prune --omit=dev` ile üretim bağımlılıkları; `scripts/copy-assets.mjs`
   ile worker + wasm.
3. Sabit sürümlü indirmeler, SHA256 doğrulamalı: Node 22 Windows zip,
   PostgreSQL 17 EDB ikilileri, WinSW, (isteğe bağlı) Caddy.
4. `capacity-tiers.json`'u `@sitekeep/shared`'den yaz.
5. `sitekeep.exe`: Node SEA (`node --experimental-sea-config`).
6. Inno Setup (`iscc sitekeep.iss`) → `7D-CDE-Setup-<sürüm>.exe`.
7. İmza: `signtool` + EV kod imzalama sertifikası (SmartScreen uyarısı çıkmasın diye).
8. **Duman testi** aynı runner'da: sessiz kurulum (`/VERYSILENT /SUPPRESSMSGBOXES`
   + yanıt dosyası) → sağlık → `sitekeep capacity --quick` → kaldırma.
9. Sürüm etiketiyle GitHub Release'e yükle; Linux için aynı adımlar `ubuntu-latest`
   + `fpm` ile `.deb`.

### 10.8 Windows'ta kodda değişecekler

| Konu | Bugün | Exe için |
|---|---|---|
| Disk okuma | `statfs` | Windows'ta da çalışır (Node 22); sürücü kökü verilir |
| cgroup | Linux | Windows'ta dosyalar yok; kod zaten yok sayar |
| Yollar | POSIX varsayımı olan yerler | `path.join` taraması, uzun yol (`\\?\`) testi |
| Veritabanı | Docker'da `postgres:17` | yerel `pg_ctl`; `DATABASE_URL` aynı |
| Ofis | Docker profilleri | Windows ONLYOFFICE veya kapalı |
| Yedek | `pg_dump` konteynerde | pakette gelen `pgsql\bin\pg_dump.exe` |
| Servis sinyali | `SIGTERM` | WinSW durdurma → `SIGINT`/`process.on("message")`; düzgün kapanış testi |

### 10.9 Bu özellik pakete nasıl girer (özet)

| Yer | Kapasite |
|---|---|
| Kurulum öncesi | `capacity-tiers.json` ile donanım uyarısı (§10.4-1) |
| Kurulum sonu | ilk Hızlı Kontrol + rapor (§10.4-8) |
| Günlük | Sistem Durumu kartı, Yeni Kullanıcı uyarısı |
| Ayda bir | zamanlanmış Hızlı Kontrol, kırmızıysa e-posta (§9.5) |
| Bakım penceresi | Tam Yük Testi (ekrandan veya `sitekeep capacity --load`) |
| Destek | `sitekeep doctor` paketinde son kapasite raporu |

---

## 11. Karar bekleyenler

1. **Kullanıcı sınırı aşılınca** yalnız uyarı mı (bugün öyle), yoksa lisansa bağlı
   **engel** mi? Lisansta koltuk sayısı olacak mı?
2. **Eşzamanlılık oranı** %15 mi? Müşteri tipine göre (şantiye / ofis) ayarlansın mı?
3. **Tam Yük Testi canlıda**: bakım penceresi dışında tamamen kapalı mı?
4. **7D'ye gönderim** yalnız elle indirilen paket mi (öneri), destek sözleşmesinde
   onaylı otomatik gönderim de olsun mu?
5. **Exe hedefi**: Windows Server (öneri ana yol), Linux veya ikisi?
6. **Sertifika**: pakette Caddy mi, yoksa müşterinin IIS / proxy'si mi varsayılan?

---

## 12. Yol haritası

| Faz | İş | Durum |
|---|---|---|
| 1 | Ekran, tablo, kurallar, uyarılar, örnek motor, rapor, testler | **bitti** (bu sürüm) |
| 2 | `QuickCheckEngine` + `cpu` örnekleyici + `capacity_runs` | 1–2 hafta |
| 3 | `LoadTestEngine` (runner süreci, test projesi, gerçek trafik koruması) | 2–3 hafta |
| 4 | Laboratuvar: referans VM'ler, k6 karşılaştırması, tabloyu ölçülmüş sayıyla güncelle | 1–2 hafta (2–3 ile paralel) |
| 5 | E-posta, zamanlanmış kontrol, üst renk | 1 hafta |
| 6 | Exe: paket, servisler, sihirbaz, `sitekeep.exe`, CI, imza | 3–5 hafta |
