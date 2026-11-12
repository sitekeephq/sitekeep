# Raporlar: her modül için panel, canlı yenileme

Tarih: 10.10.2026 · Kod: `apps/server/src/reports/`, `apps/web/src/features/reports/pages/Reports.tsx`,
`apps/web/src/features/reports/pages/ReportView.tsx`, `apps/web/src/features/reports/components/ReportFrame.tsx`, `packages/cde-tools/src/tools/report.ts`

Kullanıcının sorusu: *"Yapay zekâ her modüle göre rapor üretebilmeli; kaydedilen rapor formatları veriler güncellendikçe
yenilenmeli."* Bu belge iki ihtiyacın nasıl karşılandığını, sınırları ve ölçümleri anlatır.

## 1. Özet

- **Her modülün veri kümesi var.** Yapay zekâ ve hazır şablonlar veriye SQL ile değil, adlandırılmış ve Türkçe etiketli
  **veri kümeleri** üzerinden erişir. Veri kümesi her sorguda **sorgulayanın yetkileriyle** yüklenir (modülün kendi
  listesindeki görünürlük kuralı aynen kullanılır). Yeni: işler, yazışmalar, bilgi talepleri, teknik onaylar, toplantılar,
  eylemler, gönderim formları, incelemeler, inceleme dosyaları, akış adımları, formlar, konumlar, iş programı faaliyetleri,
  çakışmalar, doküman karşılaştırmaları, şartname teknik onay listeleri (16 yeni; toplam 23).
- **Hazır şablonlar modül modül.** "Yeni panel → Şablondan" ekranı şablonları modüle göre gruplar. Şablonlar yapay zekâ
  istemez.
- **Her modül sayfasında "Rapor" düğmesi** var: rapor oluşturucuyu o modülle sınırlı açar (yapay zekâ yoksa modülün
  şablonlarını gösterir).
- **Yapay zekâya küçük istem.** İsteğe göre yalnızca gereken veri kümeleri (en çok 4) ve o modülün tek bir örnek şablonu
  gönderilir.
- **Kayıtlı paneller her zaman günceldir.** Panel her açılışta sorgularını o anki veriyle (dosyaların, iş programlarının
  ve modellerin en yeni versiyonlarıyla) çalıştırır; panel **açıkken** veri değişirse kendiliğinden yenilenir.
- **Kayıtlı sorgu bozulursa** (alanın adı değişti / alan kalktı) ilgili bölümde açık bir Türkçe mesaj çıkar; panel
  sahibi **"Yapay Zekâ ile Onar"** ile o sorguyu düzelttirebilir.
- **MCP ve Sor:** `cde_report_datasets`, `cde_reports_list`, `cde_report_run`; Sor "Yazışma raporunu göster" isteğini
  `cde_report_run` ile cevaplar.

## 2. Modüller → veri kümeleri → şablonlar

| Modül (Rapor düğmesi) | Veri kümeleri | Hazır şablonlar |
|---|---|---|
| Dokümanlar | `files`, `versions` | Doküman Yükleme Aktivitesi (haftalık) |
| Sorunlar | `issues` | Sorun Durumu (firma ve öncelik), Termin Aşımları |
| Tüm İşler | `works` | Açık İşler (sıradaki taraf) |
| Yazışmalar | `correspondence` | Yazışma Durumu (cevap bekleyenler, termini geçenler, firma bazında, aylık gelen/giden) |
| Bilgi Talepleri | `rfis` | Bilgi Talepleri (sıradaki taraf, açık gün, disiplin, ortalama cevap süresi) |
| Teknik Onaylar | `submittals` | Teknik Onay Listesi (sonuç dağılımı, revizyon sayısı, türe göre, gecikenler) |
| Toplantılar ve Eylemler | `meetings`, `actions` | Toplantılar ve Eylemler (açık eylemler, sorumlu firma, aylık toplantı) |
| Gönderim Formları | `transmittals` | (yapay zekâ ile) |
| İncelemeler | `reviews`, `review_files`, `workflow_steps` | İncelemeler (adım süreleri, gecikmeler, firma bazında bekleme) |
| Formlar | `forms` | Formlar (başarısız maddeler, konuma ve şablona göre, haftalık) |
| Konumlar | `locations` | (yapay zekâ ile; formlar şablonu konuma göre de gösterir) |
| İş Programı | `schedule_activities` | İş Programı (gecikme, kritik yol, S-eğrisi) |
| Çakışmalar (Koordinasyon) | `clash_results` | Çakışmalar (açık çakışma, sınıf çiftleri, firma, kat) |
| Doküman Karşılaştırmaları | `doc_comparisons` | Doküman Karşılaştırmaları (değişen sayfa, antet, revizyon uyarısı) |
| Şartname Analizi | `spec_registers` | (yapay zekâ ile) |
| Modeller | `models`, `model_elements` | Model Eleman Dağılımı |
| Proje ve Aktivite | `activity` (yalnız proje yöneticisi), `members` | (yapay zekâ ile) |

Şablonlar `apps/server/src/reports/templates.ts` ve `templates-modules.ts` içindedir. Kullanıcı, kullanamadığı bir veri
kümesine dayanan şablonu görmez (ör. `activity` yalnız yöneticiye).

### Önemli alanlar

Her veri kümesinin alanları Türkçe etiketlidir; kod değerli alanların Türkçe karşılıkları (`values`) hem yapay zekâya hem
panele (grafik ve tablolarda Türkçe gösterim) gider. Kısa liste:

- **works / correspondence / rfis / submittals / actions / transmittals** (ortak): `number`, `title`, `status` (kod) ve
  `statusLabel`, `isOpen`, `fromCompany`, `toCompany`, `toCompanies`, `ballInCourt` (**sıradaki taraf**), `dueDate`,
  `overdue`, `daysOverdue`, `daysOpen` (gönderimden cevaba / kapanışa ya da bugüne), `sentAt`, `answeredAt`.
- **works**: `category`, `replyRequired`, `awaitingReply`, `deliveryChannel`, `deliveryStatus`, `mailSent`, `letterLanguage`,
  `discipline`, `parent`.
- **correspondence**: `direction` (gelen/giden), `counterparty` (karşı firma), `letterDate`, cevap/teslim/dil alanları.
- **rfis**: `discipline`, `rfiCategory`, `priority`, `costImpact`, `scheduleImpact`, `answered`, `revisionCount`.
- **submittals**: `rev`, `outcome` (son karar kodu) / `outcomeLabel`, `decided`, `sectionCode` / `sectionTitle` (şartname
  bölümü), `kind`, `package`, `reviewDays`.
- **meetings**: `kind`, `date`, `attendeeCount`, `presentCount`, `minutesItemCount`, `actionCount`, `openActionCount`.
- **actions**: `responsibleCompany`, `assignee`, `meeting`, `meetingTitle`, `meetingDate`.
- **reviews**: `status`, `currentStep`, `stepNo`, `stepDueAt`, `overdue`, `daysInStep`, `totalDays`, dosya sonuç sayıları,
  `targetFolder`, `gated` (hedef klasör kapılı mı).
- **review_files**: inceleme × dosya; `outcome` / `outcomeLabel`, `decided`, `decidedAt`, `stoppedAtStep`, `copied`.
- **workflow_steps** ("kim ne kadar bekletti"): incelemeler, bilgi talepleri, teknik onaylar ve formların akışlarındaki her
  adım geçişi; `responsible`, `responsibleCompany`, `startedAt`, `endedAt`, `days` (ondalıklı), `dueAt`, `late`, `outcome`.
- **forms**: `template`, `status`, `location`, `locationTop`, `formDate`, `score`, `failedCount`, `hasFailures`, `outcome`.
- **locations**: ağaç yolu ve seviye, km, bağlı form / açık form / başarısız madde / sorun sayıları.
- **schedule_activities**: her iş programı serisinin **en yeni versiyonu**; temel plan (seri temel planından), gerçekleşen,
  `percentComplete`, `critical`, `late`, `status`, `finishVarianceDays`, iş kırılımı (`wbs`, `wbsTop`), `summary`.
- **clash_results**: `test`, `status`, `isOpen`, `classA`, `classB`, `classPair`, `storey`, `group`, `assignedCompany`,
  `daysOpen`.
- **doc_comparisons**: değişen sayfa/satır sayıları, `antetChanges`, revizyon uyarıları (`warningCount`, `warnings`).
- **spec_registers**: kalem başına bölüm, tür, disiplin, sayfa.

### Yetkiler (görünürlük)

| Veri kümesi | Kural (modülün listesiyle aynı) |
|---|---|
| İşler ve türevleri | `canSeeWork` (oluşturan, atanan, sahip/gönderen firma, taslak olmayan işlerde alıcı firmalar, proje yöneticisi) + akış katılımcıları |
| reviews, review_files | Proje yöneticisi, başlatan, herhangi bir adımın atanmışı |
| workflow_steps | Konusunu görebildiği akışlar (inceleme / iş / form) |
| forms, locations | Tüm proje üyeleri (Formlar ve Konumlar listeleriyle aynı) |
| schedule_activities | Tüm proje üyeleri |
| clash_results | Testin tüm model dosyalarını görebilenler |
| doc_comparisons | İki versiyonun dosyasını da görebilenler |
| spec_registers | Şartname dosyasını görebilenler |
| files, versions, models | Klasör yetkisi (görüntüleme veya yalnız-yükleme ile kendi dosyaları) |
| activity | Yalnız proje yöneticileri |

Paylaşılan bir panel her izleyiciye **kendi yetkisi kadarını** gösterir.

## 3. Yapay zekâ: küçük istem

Yerel model (Ollama `qwen3-8b-16k`, 16K bağlam, CPU) yavaş olduğu için istem küçük tutulur:

1. **Veri kümesi yönlendirici** (`reports/router.ts`): Türkçe istek ASCII'ye katlanır, anahtar kelime grupları eşleşir
   ("yazı, cevap bekle" → `correspondence`; "bilgi talebi" → `rfis`; "kim ne kadar bekletti, adım süresi" →
   `workflow_steps`; "konum, blok, kat" → `locations`; "iş programı, faaliyet, kritik yol, S-eğrisi" → `schedule_activities`
   …). Sıra: düzenlenen panelin veri kümeleri, açıkça istenenler, istekte geçiş sırasına göre eşleşenler, sonra
   modülün kendi veri kümeleri. Hiçbiri yoksa `works`, `issues`, `files`. En çok 4 veri kümesi.
2. **Modül kapsamı:** Modül sayfasındaki "Rapor" düğmesi `module` gönderir; o modülün veri kümeleri eklenir.
3. **Yalnız seçilen veri kümelerinin alanları** istemde yer alır; diğerlerinin yalnız adları bir satırda geçer.
4. **Tek örnek:** ilk veri kümesinin modülüne ait şablon örnek olarak verilir (modül başına bir örnek).
5. **Üst sınır:** sistem istemi en çok 4.500 tahmini token (karakter / 3). Aşarsa önce alan açıklamaları, sonra sondaki
   veri kümeleri düşer.

### Ölçümler (Ollama `prompt_eval_count`, qwen3-8b-16k, CPU)

| İstem | Karakter | Token | İstem işleme süresi |
|---|---|---|---|
| **Önce:** eski istem, yerleşik 6 veri kümesinin hepsi | 10.690 | 3.325 | 211 sn |
| **Önce:** sunucudaki hâli (+ `model_elements`, 7 küme) | ~11.400 | ~3.550 (oranla) | — |
| **Önce, yönlendirme olmasaydı:** eski biçim, 23 veri kümesinin hepsi | 30.693 | ~9.600 (oranla; ölçüm 300 sn'yi aştı) | ~10 dk |
| **Sonra:** "Firmalara göre açık sorun sayısı" → `issues` | 7.957 | 2.348 | 136 sn |
| **Sonra:** "Cevap bekleyen yazılar firma bazında" → `correspondence` | 9.466 | 2.865 | 167 sn |
| **Sonra:** "İncelemelerde hangi firma ne kadar bekletti?" → `reviews`, `review_files`, `workflow_steps` | 10.975 | 3.367 | 202 sn |
| **Sonra:** "Geciken kritik faaliyetler…" → `schedule_activities` | 11.173 | 3.402 | 194 sn |
| **Sonra, en geniş:** dört modül adı geçen istek → 3 veri kümesi | 12.137 | 3.793 | 198 sn |

(İstemleri `planMessages` kurar; token sayısı Ollama'nın `prompt_eval_count` değeridir, ~3,2 karakter/token. İstem
işleme hızı bu makinede ~17 token/sn. Sonradan örnek HTML'deki girintiler de atıldı; istemler %3–5 daha kısa.)

Yorum: modül eklenmeden önceki istem ~3.300–3.550 token idi. Yönlendirme olmasaydı 23 veri kümesiyle ~9.600 token
olurdu (16K bağlamın %60'ı; düzenleme modunda mevcut panelin HTML'i de eklenince taşar, CPU'da yalnız istemi işlemek
~10 dakika). Yönlendirmeyle istek başına 2.350–3.800 token: eskisi kadar ya da daha az, üstelik 23 veri kümesinin
hepsine erişim var. İstemin ~%50'si sabit kurallar ve yardımcı açıklaması, ~%30'u örnek şablon, kalanı veri kümeleridir.

## 4. Kayıtlı panellerin canlı yenilenmesi

### Değişiklik damgası (sunucu)

En basit ve sağlam yol olarak **veritabanı tetikleyicileri** seçildi (migration `0020_report_stamps.sql`):

- `report_change_stamps (project_id, scope, counter, changed_at)` tablosu.
- Rapor veri kümelerinin dayandığı her tabloda **ifade düzeyinde** (FOR EACH STATEMENT) `INSERT / UPDATE / DELETE`
  tetikleyicileri; geçiş tabloları (transition tables) ile etkilenen satırların projesi bulunur ve proje × kapsam sayacı
  **ifade başına bir kez** artırılır.
- Kapsamlar: `files` (files, file_versions, folders, folder_grants), `issues`, `activity` (audit_log), `members`,
  `works` (works, work_types, work_revisions, work_receipts), `workflow` (workflow_instances, workflow_actions), `reviews`
  (reviews, review_files), `forms` (forms, form_templates), `locations` (locations, location_links), `schedule`
  (schedules, schedule_activities), `coordination` (model_sets, clash_tests, clashes, clash_groups, clash_runs),
  `doccompare`, `docintel` (spec_registers, doc_extractions).
- Neden tetikleyici: REST, MCP, Sor, arka plan işleri (IFC dönüşümü, çakışma çalıştırma), içe aktarımlar, WOPI… hangi yol
  yazarsa yazsın yakalanır; servislere tek tek kanca eklemek gerekmez, unutulan yazma yolu olmaz. Okumalar damgaya
  dokunmaz. Hiç satır değiştirmeyen ifadeler (ör. `INSERT … ON CONFLICT DO NOTHING`) sayacı artırmaz.
- Her veri kümesi okuduğu kapsamları bildirir (`sources`). Bir panelin damgası, veri kümelerinin kapsam sayaçları +
  **bugünün tarihi**dir (gecikme / açık gün gibi değerler gece yarısı değişir): ör.
  `members:4,works:17|2026-10-10`. Yani yalnız panelin kullandığı modüllere yazılınca değişir.

### İstemci

- `GET /reports/:id/data` sonucu damgayla gelir (damga sorgulardan **önce** okunur; çalışma sırasında gelen yazma bir
  sonraki kontrolde yakalanır).
- Açık panel her **25 saniyede** `GET /reports/:id/stamp` çağırır (tek indeksli okuma); damga farklıysa sorguları yeniden
  çalıştırır. Sekme gizliyken durur; pencere odak kazanınca veya sekme görünür olunca hemen kontrol eder. Düzenleme
  sırasında otomatik yenileme durur.
- Başlıkta **"Son güncelleme: ss:dd"**, otomatik yenilemede birkaç saniye **"Yenilendi"** görünür.
- Yeni veri, korumalı iframe'e **postMessage** ile gider; panel yeniden yüklenmez, grafikler yerinde yeniden çizilir
  (titreme yok, kaydırma konumu korunur).
- Kayıtlı paneller **anlık görüntü değildir**: her zaman güncel kayıtlar ve en yeni versiyonlar (model_elements gibi).
  Donmuş bir kopya için **"Anlık Görüntü Al (PDF)"** (tarayıcının yazdır → PDF olarak kaydet) kullanılır.
- Kaydedilmemiş taslaklar için `GET /reports/stamp?datasets=a,b` de var.

## 5. Kayıtlı sorguların geçerliliği ve "Yapay zekâ ile onar"

- Panel açılırken her sorgu güncel veri kümesi kaydına göre doğrulanır. Alan kaldırılmış / adı değişmişse sorgu
  çalışmaz, diğerleri çalışır; sonuçta `errorKinds[id] = "invalid"` ve kısa bir Türkçe mesaj döner:
  *"Kayıtlı sorgu güncel veri yapısına uymuyor (alan kaldırılmış veya adı değişmiş olabilir): 'correspondence' veri
  kümesinde 'karsiFirma' alanı yok."* Benzer bir alan varsa önerilir (`benzer alan: 'dueDate'`).
- Panelde o sorguyu kullanan grafik / tablo boş kalmaz; yerinde **"Bu bölüm gösterilemiyor"** ve mesaj görünür.
- Panel sahibi (veya proje yöneticisi) **"Yapay Zekâ ile Onar"** der: modele **yalnız bozuk sorgu, hata mesajı, eksik
  alanların adları ve o veri kümesinin alan listesi** gider (panel HTML'i ve diğer veri kümeleri gitmez). Model yalnız
  bir **alan eşlemesi** döndürür (`{"replace": {"karsiFirma": "counterparty"}}`, karşılığı yoksa `null`); eşleme kayıtlı
  sorguya uygulanır, böylece filtreler, gruplama, çıktı adları, sıralama ve satır sınırı aynen kalır. (Önce tam sorgu
  isteniyordu; yerel model bu durumda satır sınırını da değiştirdi, eşleme yöntemine geçildi. Tam sorgu cevabı hâlâ
  kabul edilir, kayıtlı satır sınırı korunur.) Önerilen sorgu gösterilir, "Uygula ve Kaydet" panelin yeni sürümünü
  kaydeder (eski sürüme Sürümler'den dönülebilir).
- Yapay zekâ yoksa: Düzenle → Gelişmiş bölümünden sorgu elle düzeltilir.

## 6. MCP ve Sor

- `cde_report_datasets` — veri kümeleri (modül, açıklama) veya bir veri kümesinin alanları.
- `cde_reports_list` — kayıtlı paneller ve modül şablonları.
- `cde_report_run` — kayıtlı paneli (id veya ad), şablonu (id veya ad) ya da serbest sorguları çalıştırır; sorgu başına
  satırlar (varsayılan 25) döner. Çağıranın yetkisiyle, güncel veriyle; hiçbir şey kaydedilmez. `POST /reports/query`
  salt-okunur erişim anahtarlarına açıldı.
- Sor: "rapor göster / panel / pano" ve "<modül> raporu" istekleri `reports` grubuna yönlenir; `cde_report_run`
  sonucu kaynak etiketi **P** (rapor) ile bağlantılanır (kayıtlı panel → `/reports/:id`, şablon → `/reports?template=…`).

## 7. Sınırlar

- Veri kümeleri proje ölçeğinde bellekte filtrelenir; sorgu başına en çok 5.000 satır, panel başına en çok 20 sorgu.
  Çok büyük projelerde (on binlerce iş / faaliyet) panel açılışı birkaç saniye sürebilir.
- Özel iş tiplerinin durum kodları değer listesinde yoksa kod gösterilir; satırlarda her zaman `statusLabel` vardır.
- `workflow_steps` adım sürelerini akış kayıtlarından (başlangıç, adım tamamlandı, iptal) hesaplar; geri gönderilen /
  yeniden açılan zincirlerde süreler yaklaşık olabilir.
- Konum yolu, Formlar ekranındaki gibi kodla başlar ("A A Blok / A2 Kat 2").
- Çakışma, karşılaştırma ve şartname veri kümeleri yalnız oluşturulmuş kayıtları gösterir (çalıştırılmamış test /
  karşılaştırma yoktur).
- Yerel modelle bir panel üretimi dakikalar sürer (istem işleme ~17 token/sn, üretim birkaç token/sn); bkz. ölçümler.
- Canlı yenileme yoklama ile çalışır (25 sn); SSE kullanılmadı. Gece yarısı tarih değiştiğinde de bir kez yenilenir.
- Kayıtlı bir panelin sorgusu bozuksa adını/paylaşımını değiştirmek için de önce sorgu düzeltilmelidir (kaydetme
  sorguları doğrular).

## 8. Gerçek yerel modelle denemeler (10.10.2026)

Ortam: yerel test sunucusu (PGlite), Ollama `qwen3-8b-16k` (`reasoning_effort: none`), CPU. Örnek veri: 4 firma, 7 yazı,
4 bilgi talebi (iş akışlı), 3 teknik onay, 1 toplantı / 3 eylem, 1 inceleme, konumlar, 4 form, 1 iş programı. Süreler
uçtan uca `POST /reports/generate` (istem işleme + üretim + doğrulama + sorgular).

| Modül | İstek | Seçilen veri kümeleri | Süre | Deneme | Sonuç |
|---|---|---|---|---|---|
| Yazışmalar (Rapor düğmesi) | "Cevap bekleyen yazılar, karşı firmaya göre dağılım ve en eski bekleyenler tablosu" | correspondence | 211 sn | 1 | Geçerli; 3 sorgu, KPI + çubuk + tablo, gerçek veriyle doğru (6 cevap bekleyen) |
| İncelemeler / bilgi talepleri | "İncelemelerde ve bilgi taleplerinde hangi firma ne kadar bekletti? Adım bazında ortalama süreleri de göster" | reviews, review_files, workflow_steps, rfis | 509 sn | 2 (bir onarım turu) | Geçerli; workflow_steps üzerinde firma ve adım bazında süre |
| İş Programı (Rapor düğmesi) | "İş programında geciken ve kritik faaliyetler, iş kırılımına göre gecikme sayıları" | schedule_activities (+ works: "iş kırılımı" işler grubuna da uyuyordu; düzeltildi) | 355 sn | 1 | Geçerli; 2 sorgu (örnek programda geciken yok, boş durum doğru) |
| Onarım | `karsiFirma` alanı kaldırılmış kayıtlı panel | correspondence | ~70 sn | 1 | `karsiFirma → counterparty`; uygulandı, panel v2 |

**Sor, "Yazışma raporunu göster":** 257 sn. Sor `cde_report_run` çağırdı, kayıtlı "Yazışma Durumu" panelini buldu,
cevap bekleyen 6 yazıyı tabloyla, firma ve ay dağılımını ve "5 yazının termini geçti" özetini verdi; panele [P1]
bağlantısı ekledi. İlk denemede (dosya araçları da teklif edilince) Sor'un 240 sn'lik model süresi doldu; rapor
isteklerinde dosya araçları artık teklif edilmiyor. Küçük kusur: sorgu kimliği ("awaiting") cevapta bir kez İngilizce
göründü.

## 9. Testler

- `apps/server/test/report-modules.test.ts`: veri kümeleri (yetki ve satır biçimi), yönlendirici ve istem üst sınırı,
  şablon betikleri, tüm şablonların örnek veride hatasız çalışması, değişiklik damgası (yazma artırır, okuma artırmaz,
  ilgisiz kapsam etkilemez, satır değiştirmeyen ifade artırmaz), yenileme uç noktası, bozuk alan mesajı ve onarım,
  modül kapsamlı üretim, MCP araçları ve Sor yönlendirmesi.
- `apps/server/test/reports.test.ts`: önceki rapor testleri (yeni şablonlar ve veri kümesi adları için güncellendi).
