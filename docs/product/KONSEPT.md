# SiteKeep — Ürün konsepti: yerel yapay zekâlı, sade CDE

Tarih: 10.10.2026

## Konumlandırma (11.10.2026)

**Slogan: "OpenCDE uyumlu, gizlilik öncelikli CDE platformu."** Her karar bu iki ilkeye göre verilir:

- **OpenCDE uyumlu:** veri kilitli değildir. Sorunlar BCF ile, dosyalar Documents API ile, kimlik Foundation API + OAuth2 ile standart biçimde alınıp verilir. Müşteri istediği an verisini başka bir CDE'ye taşıyabilir.
- **Gizlilik öncelikli:**
  - Veri müşterinin sunucusunda kalır (on-prem). Uygulama dışarıya kendiliğinden hiçbir şey göndermez; telemetri yoktur.
  - Yapay zekâ varsayılan olarak yereldir (`local_only`). Dış sağlayıcı yalnız yönetici açarsa ve proje izin verirse kullanılır; giden veri en aza indirilir ve kaydı tutulur.
  - Her dış bağlantı (yapay zekâ, e-posta, ofis düzenleyici, MCP, OAuth uygulaması) Yönetim'de görünür ve tek yerden kapatılabilir.
  - Yetki, onay ve erişim her işlemde denetlenir ve kayıt altındadır (KVKK).

## Sorun

Forma / BIM 360 / Aconex gibi CDE'ler güçlü ama **hantal**:

- **Çok modül:** Docs, Reviews, Transmittals, RFIs, Submittals, Issues, Forms. Her birinin ayrı ekranı, ayrı ayarı, ayrı numarası, ayrı bildirimi var.
- **Derin klasör ağaçları ve yetki matrisleri:** 50–100 klasör, her biri için ayrı yetki tanımı.
- **Kullanıcıdan kod ezberi isteyen isimlendirme:** `ZAVM-PAS-ZZ-S-B1-0204-RP-MC-0001`. Kullanıcı kodu bilmezse dosya yüklenemez.
- **Bilgiye ancak doğru yeri bilen ulaşır:** "Son onaylı elektrik paftası hangisi?" sorusunun cevabı üç ekran ötede.

PKF ve MBE gibi iyi kurulmuş projelerde bile bu yükü proje BIM yöneticisi taşıyor.

## İlke

> **Kullanıcı yapıyı öğrenmez; yapı kullanıcıyı anlar.**
> Kurallar (yetki, naming, onay akışı) arka planda kesin çalışır. Yerel yapay zekâ kullanıcının dilini bu kurallara çevirir.

Veri ve model müşterinin sunucusunda kalır. Yapay zekâ önerir, kesin kurallar karar verir, insan onaylar.

## Altı sadeleştirme

### 1. Tek kutu: "İşler"
Review, RFI, submittal kalemi, transmittal, issue ve yazışma ayrı modül değildir. Hepsi aynı **İş** kaydının tipleridir:

- tek liste, tek detay ekranı, tek numara formatı motoru
- tek iş akışı motoru (adımlar, kişi/firma, süre, sonuç)
- tek bildirim akışı

Tipler şablondur. "RFI" = numara formatı `PAS_CNS_{D}_RFI_{001}` + CNS → HLL → ZRT akışı + RFI alanları. Yeni tip eklemek ayar işidir, kod gerektirmez.

Kullanıcının ana ekranı **"Bugün"**: bana atananlar, terminine 2 gün kalanlar, yeni versiyonlar ve özetleri.

### 2. Bırak, gerisini o yapsın (akıllı yükleme)
Dosyayı projenin herhangi bir yerine bırakırsınız. Yerel model şunları okur:

- PDF başlık bloğu (metin katmanı, gerekirse OCR)
- IFC proje bilgisi
- dosyanın kendi adı

Bunlardan **naming standard'a uygun adı, klasörü, disiplini, öznitelikleri ve revizyonu önerir**. Kullanıcı tek tıkla onaylar. Kod ezberi biter. Kesin doğrulayıcı (`validateName`) yine son sözü söyler; model yanlış kod öneremez, çünkü öneriler yalnızca standarttaki değerlerden seçilir.

### 3. Sığ klasör + akıllı görünümler
Klasör ağacı yalnızca **yetki sınırı** için vardır ve sığ tutulur:

- seviye 1: firma veya disiplin alanı
- seviye 2: durum (WIP / Shared / Published / Archived)

Disiplin, kat, tip ve durum **öznitelik** olarak tutulur. Kullanıcı bunları **görünüm** olarak görür: "Elektrik · Onaylı · Son versiyon", "Bu hafta Hill'den dönenler". Görünümler kaydedilir ve paylaşılır. Bir görünüm, 30 klasörlük bir ağacın yerine geçer.

### 4. Rol paketleriyle yetki
Proje kurulurken firmaya bir **rol** atanır. Rol paketi klasör yetkilerini kendisi uygular; matris elle doldurulmaz.

| Rol | Paketin içeriği |
|---|---|
| İdare | Her şeyi görür, Published'ı onaylar |
| Müşavir | Shared'ı görür, review adımlarında onaylar |
| Tasarımcı | Kendi WIP alanında düzenler, Shared'a review ile gönderir |
| Yüklenici | Kendi alanında düzenler, RFI ve submittal açar |

"Bu dosyayı kim görebilir?" sorusu tek tıkla ve düz Türkçe cevaplanır. Cevabı kesin yetki motoru üretir.

### 5. "Sor" kutusu
Her ekranın üstünde Türkçe bir soru kutusu bulunur. Örnek sorular:

- "Elektrik paftalarının son onaylı versiyonları"
- "Termini geçen RFI'lar hangi firmada bekliyor?"
- "Bu IFC'de EI60 yangın kapısı kaç tane, hangi katlarda?"
- "Geçen haftadan beri statik projede ne değişti?"

Yerel model cevabı uydurmaz. CDE'nin kendi araçlarını çağırır: arama, öznitelik filtreleri, iş listeleri, IFC özellik sorguları, versiyon farkları. Bunlar MCP araçlarıyla aynı fonksiyonlardır ve **kullanıcının kendi yetkisiyle** çalışır. Cevapta kaynak dosya, iş ve elemanların bağlantıları verilir.

### 6. Her değişiklik okunur
- Her yeni versiyon için **değişiklik özeti** çıkarılır: IFC'de GlobalId farkı, PDF'de değişen bölgeler, metinde madde farkı.
- Review'da inceleyici önce "ne değişti" özetini görür.
- Transmittal ve revizyon notu otomatik doldurulur.
- Her kullanıcıya günlük özet gider.

## Mimari ekleri

```
                ┌──────────── SiteKeep sunucusu ─────────────┐
Tarayıcı ──────►│ REST API · yetki · naming · iş akışı       │
"Sor" kutusu ──►│ Asistan: araç çağıran döngü (kullanıcının │──► Yerel LLM (Ollama / vLLM,
AECPilot ──────►│   yetkisiyle) + CDE araçları              │    OpenAI uyumlu API)
Claude (MCP) ──►│ İçerik çıkarıcı: PDF metni, OCR, IFC      │
                │ Vektör indeksi: pgvector (PGlite'ta da)   │──► Embedding modeli (bge-m3)
                │ İş kuyruğu: özet, indeks, öneri           │
                └────────────────────────────────────────────┘
```

- **`AiProvider`:** varsayılanı yerel (OpenAI uyumlu uç); Claude API isteğe bağlı; kapatılabilir.
- **Araçlar:** tek araç seti. Aynı fonksiyonlar REST'te, MCP sunucusunda ve yerel asistanda kullanılır; her çağrı kullanıcının yetkisiyle yapılır.
- **Denetim:** her asistan çağrısı kaydedilir (kim, ne sordu, hangi araçlar, hangi kayıtlar okundu).
- **Donanım:**
  - geliştirme için bu bilgisayar (Snapdragon X Elite, 32 GB) 3–8B modeller için yeterli;
  - müşteri sunucusunda 16–24 GB VRAM'li bir GPU 14B modeller için yeterli.

## Atlanmaması gerekenler (eklenen başlıklar)

İlk konuşmalarda geçmeyen ama sahada ve resmi projelerde ihtiyaç duyulacak başlıklar.

| Başlık | Neden önemli | Nasıl | Öncelik |
|---|---|---|---|
| **Resmi yazışma: KEP + e-imza** | İBB, Zirve gibi kamu ve idare projelerinde resmi yazı ıslak imza, e-imza veya KEP ile gider | Yazışma tipi "İş": sayı, konu, ek, cevap zinciri. E-imza (PAdES) ile imzalı PDF. KEP sağlayıcısı ile gönder ve al | Yüksek (yazışmalar modülüyle birlikte) |
| **Onay damgası / filigran** | "Onaylıdır", "Uygulamaya esastır", "Bilgi içindir" damgası; dış paylaşımda filigran | Review sonucu onaylı PDF'e damga katmanı (tarih, kişi, firma, review no) | Yüksek |
| **Konum hiyerarşisi** | Metro ve raylı projelerde istasyon / kat / mahal veya km bazlı konum; issue ve İş'ler konuma bağlanır | Lokasyon ağacı + km (chainage) aralığı; IFC 4.3 hizalama (alignment) okunur | Yüksek (PKF ve MBE metro/raylı) |
| **Saha / mobil** | Şantiyede tablet ve telefondan issue, fotoğraf, form; zayıf bağlantı | PWA, çevrimdışı kuyruk, kamera, QR kod (mahal veya pafta → CDE bağlantısı) | Yüksek |
| **Toplantılar** | Koordinasyon toplantısı tutanağı ve aksiyon maddeleri | Toplantı = İş tipi; maddeler alt İş olur, sorumlu ve termin alır; tutanak taslağını yerel model hazırlar | Orta |
| **Dış paylaşım bağlantısı** | Üye olmayan kişiye süreli ve şifreli dosya gönderimi | Süreli bağlantı, indirme sayısı sınırı, filigran, denetim kaydı | Orta |
| **E-posta ile bildirim ve gelen kutusu** | Kullanıcı CDE'ye girmeden haberdar olur; e-postayla dosya alınır | SMTP bildirim ve günlük özet; proje e-posta adresine gelen ekler karantina klasörüne düşer | Orta |
| **Gösterge paneli ve raporlar** | Yöneticiye termin aşımları, onay döngü süreleri, firma bazlı bekleyen işler | Hazır paneller; Excel/PDF rapor dışa aktarımı; "Sor" kutusundan rapor | Orta |
| **Ofis ve DWG önizleme** | DOCX/XLSX/DWG dosyalarının indirilmeden görülmesi | Sunucuda LibreOffice ile PDF'e çevirme; DWG için lisanslı ODA ya da AECPilot'tan PDF/DXF yayınlama | Orta |
| **Teslim arşivi (handover)** | Proje sonunda idareye düzenli bilgi modeli teslimi | Published içeriğinin indeksli arşivi (ZIP + Excel liste + IFC + COBie); salt okunur arşiv modu | Orta |
| **Odoo entegrasyonu** | 7D'nin Odoo altyapısı var: proje, satın alma, hakediş | CDE projesi ↔ Odoo projesi; submittal malzeme onayı ↔ satın alma siparişi; İş terminleri ↔ Odoo aktiviteleri | Orta |
| **Metraj (QTO)** | Hakediş ve keşif için IFC'den miktar | IFC miktar setlerinden sınıf, kat ve malzeme bazlı tablo; Excel çıktısı | Düşük–Orta |
| **Point cloud / altyapı katmanları** | Raylı projelerde tarama ve güzergâh (OpenBIM-App'te var) | LAS/E57 önizleme katmanı, IoT ve heatmap katmanlarını viewer'a eklenti olarak taşıma | Düşük–Orta |
| **KVKK ve saklama politikası** | Kişisel veri, saklama süresi, silme talepleri | Saklama kuralları, yasal tutma (legal hold), kişisel veri dışa aktarma ve anonimleştirme, denetim raporu | Orta |
| **SSO / Active Directory** | Kurumsal müşteride tek giriş | LDAP/AD ve OIDC (Entra ID, Keycloak) | Orta |
| **Yedekleme, güncelleme, izleme** | Yerel kurulumda BT yükü bizde kalmasın | Yönetim ekranından yedek alma ve geri yükleme, sürüm güncelleme, disk ve iş kuyruğu sağlığı, depolama kotası | Yüksek (kurulum öncesi) |
| **Çoklu dil** | Yabancı ortaklı projeler | Arayüzde TR/EN; içerik dili serbest | Düşük |
| **@bahsetme ve takip** | Kişiyi bir İş'e, dosyaya veya markup'a çağırmak | Yorumlarda @kişi, @firma; takip et / bırak | Orta |

## Sıra

1. **AI temeli:**
   - `AiProvider` (yerel / Claude / kapalı)
   - içerik çıkarıcı (PDF metin katmanı, IFC özellikleri)
   - pgvector indeksi
   - testlerde sahte sağlayıcı
2. **Akıllı yükleme:** ad, klasör ve öznitelik önerisi (naming standard değerlerinden seçerek).
3. **"Sor" kutusu:** salt okuma araçlarıyla (arama, görünümler, iş listesi, IFC sorgusu).
4. **Tek "İşler" modeli:** iş akışı motorunun üstüne review, RFI, issue ve yazışma tipleri; "Bugün" ekranı.
5. **Değişiklik özetleri ve günlük özet.**
6. **Rol paketleri ve proje kurulum sihirbazı:** PKF/MBE şablonları veya 5 soruyla kurulum.

Bu konsept, docs/archive/YOL_HARITASI.md'deki (arşiv) modül listesinin **kullanıcıya görünen yüzünü** belirler. Altyapı (iş akışı motoru, öznitelikler, markup, IFC farkı) olduğu gibi kullanılır; ayrı modül ekranları yerine "İşler", "Görünümler" ve "Sor" üzerinden sunulur.
