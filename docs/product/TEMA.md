# SiteKeep — Tema ve Marka Uyumu

> **Logo ve ürün adı:** SiteKeep logosu, renkleri ve kuralları [Marka rehberi](../brand/README.md)'ndedir (10.11.2026). Aşağıdaki 7Dimensions / AEC Pilot paleti arayüzün renk ve bileşen temasının kaynağıdır; eski "7D" simgesi artık kullanılmaz.

Tarih: 2026-10-10
Kaynaklar: https://7dimensions.eu (→ https://www.7dimensions.eu/en) ve https://aecpilot.com (→ https://www.aecpilot.com/tr).
İki site de Odoo Website üzerinde çalışıyor; marka katmanı Odoo temasının üstüne yazılmış özel CSS ile veriliyor. Değerler aşağıdaki CSS dosyalarından ve sayfa içi `<style>` bloklarından birebir alındı.

| Kaynak | İçerik |
|---|---|
| https://www.7dimensions.eu/en (sayfa içi `<style>` ×3: üst menü, footer, `.o_7d_v2` sayfa stili) | 7D renk değişkenleri `--d7-*`, butonlar, kartlar, logo/wordmark |
| https://www.7dimensions.eu/web/assets/3/0766ba9/web.assets_frontend.min.css | Odoo tema paleti (eski/taban), font tanımı |
| https://www.aecpilot.com/web/content/307030/aecpilot-native.css | AEC Pilot marka katmanı `--aec-*`, kart/form/buton stilleri |
| https://www.aecpilot.com/web/assets/10/1749eda/web.assets_frontend.min.css | Odoo tema paleti `--o-color-1..5`, `.btn-primary` |

---

## 1. Bulgular

### 1.1 Renkler

**Ortak marka çekirdeği (iki sitede aynı):**

| Rol | Hex | Nerede |
|---|---|---|
| Lacivert (ana marka) | `#021E45` | Üst menü zemini (ikisi de), AEC `--aec-navy`, AEC Odoo `--o-color-1` / `.btn-primary` bg, 7D `--d7-navy-2` |
| Koyu lacivert | `#041530` (7D `--d7-navy`), `#01163A` (AEC `--o-color-5`) | Koyu bölüm/footer gradyanının alt ucu |
| Mürekkep (başlık/metin) | `#111827` | 7D `--d7-ink`, AEC kart başlığı |
| İkincil metin | `#374151` | AEC `--aec-ink-2`, gövde metni |
| Soluk metin | `#6B7280` | 7D `--d7-muted` |
| Çizgi / border | `#E5E7EB` | 7D `--d7-line`, AEC `--aec-line` |
| Açık zemin | `#F6F7F9` | 7D `--d7-soft`, AEC `--o-color-3` |
| Kart görsel zemini | `#F7F8FA` | AEC `.o_card_img_wrapper` |
| Menü hover zemini | `#EEF3FB` | 7D dropdown item hover |

**7Dimensions vurguları:**

| Rol | Hex |
|---|---|
| Mavi (CTA) | `#4285F4` (`--d7-blue`), hover `#5A95F5` |
| Açık mavi | `#7FB2FF` (`--d7-blue-2`), `#9CC4FF` |
| Mor (gradyan ucu) | `#A78BFA`, `#8B5CF6` |
| Koyu bölüm metni | `#C9D4E5` (lead), `#B8C4D6` (paragraf), `#E6EDF7` (pill) |
| Kategori renkleri (`--k-*`) | AI `#22D3EE`, Eğitim `#4285F4`, BIM `#34D399`, Kod `#A78BFA`, ERP `#FBBF24` |
| İkon gradyanları | mavi `#3B82F6→#021E45`, teal `#34D399→#065F46`, amber `#FBBF24→#92400E`, mor `#A78BFA→#4C1D95` |

**AEC Pilot vurguları:**

| Rol | Hex |
|---|---|
| Orta mavi | `#3B6FB5` (`--o-color-2`; ikon kutusu ve form-butonu gradyanı, focus border) |
| Açık mavi | `#5B9BF0` (gradyan ucu) |
| Kod zemini | `#EEF2F8` (code bg, metin `#021E45`) |
| Terminal | bg `#0A1830`, metin `#CFE0FF` |
| Başarı | `#16A34A` (koyu zeminde `#7DD3A3`) |
| Hata | `#B91C1C`, `#DC2626` |
| Yıldız/uyarı | `#E8A000`, zemin `#FFF7E6` |
| Input border | `#D8DEE8`, input bg `#F9FAFC` |

**Gradyanlar:**
- Koyu hero/footer (7D): `radial-gradient(1200px 500px at 15% -10%, rgba(66,133,244,.22), transparent 60%), linear-gradient(180deg, #041530, #021E45)` + 56px aralıklı `rgba(255,255,255,.045)` ızgara çizgileri.
- 7D wordmark "7" harfi: `linear-gradient(135deg, #9CC4FF, #4285F4 60%, #8B5CF6)`.
- 7D başlık alt çizgisi: `linear-gradient(90deg, #4285F4, #7FB2FF)`; footer h5 çizgisi `#4285F4 → #A78BFA`.
- AEC ilerleme/kenar: `linear-gradient(90deg, #021E45, #3B6FB5 55%, #5B9BF0)`; AEC birincil form butonu `linear-gradient(135deg, #021E45, #3B6FB5)`.

**Not — eski Odoo tema paleti:** 7dimensions.eu'nun Odoo taban teması hâlâ `#00203F / #ADEFD1 (mint) / #F0F3F5 / #14212E` paletini ve `Inter Tight` fontunu tanımlıyor, ama sayfanın görünen her yeri yukarıdaki `#021E45 / #4285F4` katmanıyla eziliyor. Mint yeşili artık markanın parçası değil; kullanmayın.

### 1.2 Fontlar

| Font | Ağırlık | Kullanım | Yükleme |
|---|---|---|---|
| **Inter** | 400, 500, 600, 700, 800 | İki sitenin de gövde ve başlık fontu (Odoo `--font-sans-serif: "Inter"`) | Google Fonts (`fonts.googleapis.com/css2?family=Inter...`) |
| **Sora** | 700 | Yalnızca "7Dimensions" wordmark'ı (21px, letter-spacing -.01em) | Google Fonts |
| **JetBrains Mono** | 400, 500 | 7D eyebrow/etiketler (`--d7-mono`, .72rem, büyük harf, letter-spacing .14em) | Google Fonts |
| IBM Plex Mono | — | AEC `--aec-mono` olarak tanımlı ama sitede yüklenmiyor (sistem mono'ya düşüyor) | — |

Başlıklar sıkı harf aralıklı: h1/h2 `letter-spacing: -.02em … -.035em`, ağırlık 700–800.

### 1.3 Logo ve favicon adresleri

| Varlık | URL |
|---|---|
| 7D favicon (SVG, açık/koyu mod duyarlı) | https://www.7dimensions.eu/web/image/308063-70a7d541/7d-7d-favicon.svg |
| 7D amblem, koyu zemin için (SVG, beyaz) | https://www.7dimensions.eu/web/image/308059-41caa60a/7d-7d-mark-dark.svg |
| 7D amblem 512px PNG (schema.org logo) | https://www.7dimensions.eu/web/image/308049-38510cec/7d-7d-mark-512.png |
| 7D OG görseli | https://www.7dimensions.eu/web/image/308048-8bfeafc9/7d-7d-og.png |
| 7D Odoo favicon (ICO) | https://www.7dimensions.eu/web/image/website/3/favicon |
| AEC Pilot favicon (SVG içinde gömülü PNG; açık/koyu iki görüntü) | https://www.aecpilot.com/web/image/308064-9db8e530/7d-aec-favicon.svg |
| AEC Pilot header logosu (511×102, beyaz) | https://www.aecpilot.com/web/image/website/10/logo/AEC%20Pilot |
| AEC Pilot wordmark beyaz PNG | https://www.aecpilot.com/web/content/307031/aec-logo-wordmark-white.png (7D sitesinde: https://www.7dimensions.eu/web/image/308060-3db9cf34/7d-aec-wordmark-white.png) |

**7D amblemi nasıl çizilmiş:** Sivri ucu yukarıda, eğik (izometrik) bir altıgen — yani üstten bakılan bir küp silueti. Altıgen kalın, tek renkli bir çizgiyle (kontur, dolgu yok) çiziliyor ve kapalı değil: çizgiler devre kartı yolları gibi kırılıp içeri dönüyor. Sol üstten iki, sağ alttan bir çizgi dışarı uzanıyor ve her biri içi boş bir halka (devre "pad"i) ile bitiyor; ortada da altıgenin içine kıvrılan bir yol ve küçük bir halka var. Okunan şekil: "küp + devre", 3B/BIM ile yazılımın birleşimi. Renk, sol üstten sağ alta doğru giden bir gradyan:
- açık zeminde `#000000` (offset .22) → `#225AA5` (offset .80),
- koyu zeminde (favicon'daki `prefers-color-scheme: dark`) `#FFFFFF` → `#CDE1FF`,
- `mark-dark.svg` koyu menü için beyaz → çok açık mavi.

**7D wordmark:** amblem (40px yükseklik) + 13px boşluk + "**7**Dimensions" (Sora 700, 21px, beyaz; yalnız "7" harfi `#9CC4FF → #4285F4 → #8B5CF6` gradyanlı metin) + altında 7 parçalı, 3px yükseklikte bir çubuk ("yedi boyut"): parçalar `#7FB2FF`, opaklık sırayla .22 / .34 / .46 / .58 / .70 / .84, sonuncusu `#7FB2FF → #A78BFA` gradyanı; hover'da hepsi 1 olur.

**Inline SVG olarak yeniden çizim önerisi (SiteKeep `.brand-mark` için, 28×28):**
- `viewBox="0 0 32 32"`, `fill="none"`, `stroke="url(#g7d)"`, `stroke-width="2.4"`, `stroke-linecap="round"`, `stroke-linejoin="round"`.
- Altıgen köşeleri yaklaşık: (16,3) (27,9.5) (27,22.5) (16,29) (5,22.5) (5,9.5); sol üst kenarı açık bırakıp oradan iki kısa yol (biri yatay, biri 30° eğik) sol üste uzatın, uçlarına `r=2` halka (`circle` stroke, dolgusuz) koyun.
- Sağ alt köşeden sağa doğru kısa bir yol ve sonunda bir halka; altıgenin içinde merkeze doğru kıvrılan bir yol ve küçük bir halka.
- Gradyan: `<linearGradient id="g7d" x1="0" y1="0" x2="1" y2="1">` açık modda `#021E45 → #3B6FB5` (saf siyah yerine marka laciverti, CDE paletine uyar), koyu modda `#FFFFFF → #CDE1FF`. Tema değişimi için `stop-color: var(--...)` kullanılabilir.
- Amblemin yanında "SiteKeep" metni: Inter 700 (Sora istenirse yalnız bu yazı için Google Fonts'tan `Sora:wght@700` ek yükleme gerekir).
- Logo dosyası indirilmedi/commit edilmedi; SVG elle çizilmeli ya da kaynak SVG kullanım izniyle ayrıca alınmalı.

**AEC Pilot logosu:** beyaz, köşeleri yuvarlatılmış eşkenar dörtgen (45° döndürülmüş kare) içinde negatif alanla "S"/pilot rotası benzeri bir çentik + ince dikey ayraç + "AEC PILOT" büyük harf, geniş harf aralıklı monospace benzeri yazı. Yalnızca koyu (lacivert) zemin varyantı yayında.

### 1.4 Buton, input, kart

| Öğe | 7Dimensions | AEC Pilot |
|---|---|---|
| Birincil buton | Hap (`border-radius: 999px`), `padding: 12px 22px`, 600 ağırlık; mavi `#4285F4` + `box-shadow: 0 8px 24px -8px rgba(66,133,244,.7)`, hover'da 2px yukarı kalkma | Odoo `.btn-primary` `#021E45`, radius `.5rem`; koyu bölümde hap + `0 4px 24px rgba(59,130,246,.35)` |
| İkincil buton | Beyaz bg + `1px #E5E7EB` border, hover'da border `#4285F4` | outline-light, hap, `backdrop-filter: blur(8px)` |
| Uygulama içi küçük buton | — | `border-radius: 8px`, `.38rem .8rem`, .82rem |
| Input | — | `border-radius: 10px`, border `#D8DEE8`, bg `#F9FAFC`; focus: bg `#FFF`, border `#3B6FB5`, `box-shadow: 0 0 0 4px rgba(59,111,181,.15)` |
| Kart | `radius 18px`, `1px #E5E7EB`, padding 30px; hover border `rgba(66,133,244,.45)`, gölge `0 18px 40px -22px rgba(2,30,69,.35)` | `radius 12px`, `1px #E5E7EB`, gölge `0 2px 10px rgba(2,30,69,.05)`; hover `0 14px 30px rgba(2,30,69,.12)` |
| Dropdown | radius 14px, item radius 9px, gölge `0 25px 50px -12px rgba(2,30,69,.28)` | — |
| Etiket/pill | hap, mono .72rem, bg `rgba(127,178,255,.14)` | — |

Gölgeler her zaman lacivert tonlu (`rgba(2,30,69,…)`), gri değil.

### 1.5 Genel ton

- **Yapı:** Üst menü, hero ve footer koyu lacivert (`#021E45/#041530`), içerik bölümleri beyaz / `#F6F7F9`. Yani "koyu çerçeve + açık içerik".
- **Yoğunluk:** Pazarlama sitesi olduğu için ferah (bölüm padding 96px, büyük başlıklar). SiteKeep bir iş uygulaması; yoğunluğu (14px gövde) korunmalı, yalnız renk/font/radius/gölge dili alınmalı.
- **Detaylar:** Mono büyük harf "eyebrow" etiketleri, ince ızgara deseni, mavi→mor gradyan vurgular, hover'da hafif yükselme.
- **Koyu mod:** Sitelerin `prefers-color-scheme` desteği **yok** (sadece iki favicon SVG'si koyu temaya göre renk değiştiriyor). Aşağıdaki koyu mod, sitelerin koyu bölümlerinden (`.d7-dark`, `.o_cc4`, terminal) türetildi.

---

## 2. SiteKeep için önerilen token seti

Dosya: `apps/web/src/theme.css` (yalnızca `:root` token'ları + Inter `@import`).

### Açık mod

| Token | Değer | Kaynak / gerekçe |
|---|---|---|
| `--bg` | `#F6F7F9` | 7D `--d7-soft` |
| `--surface` | `#FFFFFF` | |
| `--surface-2` | `#F7F8FA` | AEC kart görsel zemini |
| `--border` | `#E5E7EB` | ortak line |
| `--text` | `#111827` | ortak ink |
| `--muted` | `#5B6472` | `#6B7280` `--bg` üzerinde 4.51 (sınırda); AA payı için koyulaştırıldı |
| `--primary` | `#3B6FB5` | AEC `--o-color-2`, focus/gradyan mavisi |
| `--primary-hover` | `#2D5A96` | `#3B6FB5` ile lacivert arası |
| `--primary-soft` | `#EEF3FB` | 7D menü hover |
| `--danger` / `--danger-soft` | `#B91C1C` / `#FEF2F2` | AEC hata kırmızısı |
| `--ok` / `--ok-soft` | `#15803D` / `#ECFDF3` | AEC `#16A34A` beyazda 3.3 → AA için bir ton koyu |
| `--warn` / `--warn-soft` | `#92400E` / `#FFF7E6` | 7D amber koyu ucu / AEC uyarı zemini |
| `--radius` | `10px` | AEC input/form butonu |
| `--shadow` | `0 1px 2px rgba(2,30,69,.06), 0 2px 10px rgba(2,30,69,.05)` | AEC kart gölgesi, lacivert ton |
| `font-family` | `"Inter", "Segoe UI", system-ui, -apple-system, Arial, sans-serif` | iki sitenin fontu |

### Koyu mod (`@media (prefers-color-scheme: dark)`)

| Token | Değer | Kaynak / gerekçe |
|---|---|---|
| `--bg` | `#041530` | 7D `--d7-navy` |
| `--surface` | `#0A1F3D` | AEC terminal `#0A1830`'un bir ton açığı |
| `--surface-2` | `#0F2748` | |
| `--border` | `#22395C` | `rgba(255,255,255,.1)` karşılığı |
| `--text` | `#F6F7F9` | koyu bölüm metni |
| `--muted` | `#B8C4D6` | 7D koyu bölüm paragrafı |
| `--primary` | `#5B9BF0` | AEC açık mavi |
| `--primary-hover` | `#7FB2FF` | 7D `--d7-blue-2` |
| `--primary-soft` | `#16305A` | |
| `--danger` / `--danger-soft` | `#F87171` / `#3A1620` | |
| `--ok` / `--ok-soft` | `#4ADE80` / `#0F3326` | |
| `--warn` / `--warn-soft` | `#FBBF24` / `#3A2E0F` | 7D ERP sarısı |
| `--shadow` | `0 1px 2px rgba(0,0,0,.4), 0 8px 24px -12px rgba(0,0,0,.55)` | |

### Kontrast kontrolleri (WCAG 2.x, AA eşiği normal metin 4.5:1)

Açık mod:

| Ön plan / zemin | Oran | Sonuç |
|---|---|---|
| `--text #111827` / `--bg #F6F7F9` | 16.55 | AA ✔ (AAA) |
| `--text` / `--surface #FFF` | 17.74 | AA ✔ |
| `--text` / `--primary-soft #EEF3FB` (seçili satır) | 15.92 | AA ✔ |
| `--muted #5B6472` / `--bg` | 5.58 | AA ✔ |
| `--muted` / `--surface` | 5.98 | AA ✔ |
| `--muted` / `--surface-2 #F7F8FA` | 5.63 | AA ✔ |
| `--primary #3B6FB5` / `--surface` (link) | 5.09 | AA ✔ |
| `--primary` / `--bg` | 4.75 | AA ✔ |
| `--primary` / `--primary-soft` (badge.info, aktif ağaç düğümü) | 4.57 | AA ✔ (sınıra yakın) |
| **Birincil buton: beyaz / `--primary #3B6FB5`** | **5.09** | AA ✔ |
| Beyaz / `--primary-hover #2D5A96` | 6.97 | AA ✔ |
| `--danger #B91C1C` / `--danger-soft` · `--bg` | 5.91 · 6.04 | AA ✔ |
| `--ok #15803D` / `--ok-soft` · `--bg` | 4.76 · 4.68 | AA ✔ |
| `--warn #92400E` / `--warn-soft` · `--bg` | 6.65 · 6.61 | AA ✔ |

Koyu mod:

| Ön plan / zemin | Oran | Sonuç |
|---|---|---|
| `--text #F6F7F9` / `--bg #041530` | 16.96 | AA ✔ |
| `--text` / `--surface #0A1F3D` | 15.35 | AA ✔ |
| `--text` / `--primary-soft #16305A` | 12.21 | AA ✔ |
| `--muted #B8C4D6` / `--bg` · `--surface` · `--surface-2` | 10.31 · 9.33 · 8.48 | AA ✔ |
| `--primary #5B9BF0` / `--bg` · `--surface` · `--surface-2` | 6.40 · 5.79 · 5.26 | AA ✔ |
| `--primary` / `--primary-soft` | 4.61 | AA ✔ |
| `--danger #F87171` / `--danger-soft` · `--surface` | 5.77 · 5.95 | AA ✔ |
| `--ok #4ADE80` / `--ok-soft` · `--surface` | 7.92 · 9.44 | AA ✔ |
| `--warn #FBBF24` / `--warn-soft` · `--surface` | 7.97 · 9.86 | AA ✔ |
| **Birincil buton: beyaz / `--primary #5B9BF0`** | **2.84** | **AA ✘** (aşağıya bakın) |
| Lacivert `#021E45` / `--primary #5B9BF0` | 5.80 | AA ✔ |
| Lacivert `#021E45` / `--primary-hover #7FB2FF` | 7.62 | AA ✔ |

### Koyu modda birincil buton sorunu (yapılması gereken küçük değişiklik)

`styles.css` içinde `button.primary { color: #fff; }` ve `.brand-mark { color: #fff; }` sabit. `--primary` aynı zamanda link, aktif sekme, badge ve ağaç düğümü metni olarak da kullanılıyor. Koyu zeminde bir renk hem metin olarak ≥4.5 hem de üzerinde beyaz yazı için ≥4.5 veremez (matematiksel olarak imkânsız: biri parlaklık ≥0.22, diğeri ≤0.18 istiyor). Bu yüzden koyu modda metin okunurluğu önceliklendirildi (`#5B9BF0`).

Önerilen çözüm (bu görevde dosyaya dokunulmadı):
1. Token ekle: açık modda `--on-primary: #ffffff`, koyu modda `--on-primary: #021E45`.
2. `styles.css`: `button.primary` ve `.brand-mark` içinde `color: #fff` → `color: var(--on-primary, #fff)`.

Bu yapılınca koyu modda buton metni 5.80 (hover 7.62) olur ve tüm çiftler AA'yı geçer. Mevcut `styles.css` koyu teması da (`#5B9BD5` + beyaz ≈ 2.9) aynı sorunu zaten taşıyor; yani yeni tema durumu kötüleştirmiyor.

### Devreye alma

1. `apps/web/src/main.tsx` içinde `import "./styles.css";` satırının **altına** `import "./theme.css";` ekleyin (sıra önemli: theme.css sonra gelmeli).
2. `theme.css` başındaki `@import` Google Fonts'tan Inter 400/500/600/700 yükler. Çevrimdışı/KVKK gerekçesiyle dış istek istenmiyorsa `@fontsource/inter` paketiyle self-host edin ve `@import` satırını kaldırın.
3. Opsiyonel uyumlar (styles.css'te sabit oldukları için theme.css ile değişmiyor): buton radius'u (`6px` sabit) → `var(--radius)` veya AEC uygulama butonu gibi `8px`; `code, .mono` fontu → `"JetBrains Mono", Consolas, monospace` (7D mono; Google Fonts'tan `JetBrains+Mono:wght@400;500` eklenir); input focus halkası → `box-shadow: 0 0 0 4px rgba(59,111,181,.15)`; üst bar zemini için 7D/AEC gibi lacivert `#021E45` + beyaz metin düşünülebilir (her iki modda da 16.48:1).
