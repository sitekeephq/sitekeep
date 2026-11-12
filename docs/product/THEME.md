# SiteKeep — Theme and Brand Alignment

> **Logo and product name:** the SiteKeep logo, colours and rules are in the [Brand guide](../brand/README.md) (10.11.2026). The 7Dimensions / AEC Pilot palette below is the source of the interface's colour and component theme; the old "7D" icon is no longer used.

Date: 2026-10-10
Sources: https://7dimensions.eu (→ https://www.7dimensions.eu/en) and https://aecpilot.com (→ https://www.aecpilot.com/tr).
Both sites run on Odoo Website; the brand layer is applied with custom CSS written on top of the Odoo theme. The values were taken verbatim from the CSS files and in-page `<style>` blocks listed below.

| Source | Content |
|---|---|
| https://www.7dimensions.eu/en (in-page `<style>` ×3: top menu, footer, `.o_7d_v2` page style) | 7D colour variables `--d7-*`, buttons, cards, logo/wordmark |
| https://www.7dimensions.eu/web/assets/3/0766ba9/web.assets_frontend.min.css | Odoo theme palette (old/base), font definition |
| https://www.aecpilot.com/web/content/307030/aecpilot-native.css | AEC Pilot brand layer `--aec-*`, card/form/button styles |
| https://www.aecpilot.com/web/assets/10/1749eda/web.assets_frontend.min.css | Odoo theme palette `--o-color-1..5`, `.btn-primary` |

---

## 1. Findings

### 1.1 Colours

**Shared brand core (same on both sites):**

| Role | Hex | Where |
|---|---|---|
| Navy (main brand) | `#021E45` | Top menu background (both), AEC `--aec-navy`, AEC Odoo `--o-color-1` / `.btn-primary` bg, 7D `--d7-navy-2` |
| Dark navy | `#041530` (7D `--d7-navy`), `#01163A` (AEC `--o-color-5`) | Lower end of the dark section/footer gradient |
| Ink (headings/text) | `#111827` | 7D `--d7-ink`, AEC card title |
| Secondary text | `#374151` | AEC `--aec-ink-2`, body text |
| Muted text | `#6B7280` | 7D `--d7-muted` |
| Line / border | `#E5E7EB` | 7D `--d7-line`, AEC `--aec-line` |
| Light background | `#F6F7F9` | 7D `--d7-soft`, AEC `--o-color-3` |
| Card image background | `#F7F8FA` | AEC `.o_card_img_wrapper` |
| Menu hover background | `#EEF3FB` | 7D dropdown item hover |

**7Dimensions accents:**

| Role | Hex |
|---|---|
| Blue (CTA) | `#4285F4` (`--d7-blue`), hover `#5A95F5` |
| Light blue | `#7FB2FF` (`--d7-blue-2`), `#9CC4FF` |
| Purple (gradient end) | `#A78BFA`, `#8B5CF6` |
| Dark section text | `#C9D4E5` (lead), `#B8C4D6` (paragraph), `#E6EDF7` (pill) |
| Category colours (`--k-*`) | AI `#22D3EE`, Training `#4285F4`, BIM `#34D399`, Code `#A78BFA`, ERP `#FBBF24` |
| Icon gradients | blue `#3B82F6→#021E45`, teal `#34D399→#065F46`, amber `#FBBF24→#92400E`, purple `#A78BFA→#4C1D95` |

**AEC Pilot accents:**

| Role | Hex |
|---|---|
| Mid blue | `#3B6FB5` (`--o-color-2`; icon box and form button gradient, focus border) |
| Light blue | `#5B9BF0` (gradient end) |
| Code background | `#EEF2F8` (code bg, text `#021E45`) |
| Terminal | bg `#0A1830`, text `#CFE0FF` |
| Success | `#16A34A` (`#7DD3A3` on dark backgrounds) |
| Error | `#B91C1C`, `#DC2626` |
| Star/warning | `#E8A000`, background `#FFF7E6` |
| Input border | `#D8DEE8`, input bg `#F9FAFC` |

**Gradients:**
- Dark hero/footer (7D): `radial-gradient(1200px 500px at 15% -10%, rgba(66,133,244,.22), transparent 60%), linear-gradient(180deg, #041530, #021E45)` + `rgba(255,255,255,.045)` grid lines spaced 56px apart.
- 7D wordmark letter "7": `linear-gradient(135deg, #9CC4FF, #4285F4 60%, #8B5CF6)`.
- 7D heading underline: `linear-gradient(90deg, #4285F4, #7FB2FF)`; footer h5 line `#4285F4 → #A78BFA`.
- AEC progress/edge: `linear-gradient(90deg, #021E45, #3B6FB5 55%, #5B9BF0)`; AEC primary form button `linear-gradient(135deg, #021E45, #3B6FB5)`.

**Note — old Odoo theme palette:** the Odoo base theme of 7dimensions.eu still defines the `#00203F / #ADEFD1 (mint) / #F0F3F5 / #14212E` palette and the `Inter Tight` font, but every visible part of the page is overridden by the `#021E45 / #4285F4` layer above. Mint green is no longer part of the brand; do not use it.

### 1.2 Fonts

| Font | Weight | Use | Loading |
|---|---|---|---|
| **Inter** | 400, 500, 600, 700, 800 | Body and heading font on both sites (Odoo `--font-sans-serif: "Inter"`) | Google Fonts (`fonts.googleapis.com/css2?family=Inter...`) |
| **Sora** | 700 | Only the "7Dimensions" wordmark (21px, letter-spacing -.01em) | Google Fonts |
| **JetBrains Mono** | 400, 500 | 7D eyebrows/labels (`--d7-mono`, .72rem, uppercase, letter-spacing .14em) | Google Fonts |
| IBM Plex Mono | — | Defined as AEC `--aec-mono` but not loaded on the site (falls back to the system mono) | — |

Headings use tight letter spacing: h1/h2 `letter-spacing: -.02em … -.035em`, weight 700–800.

### 1.3 Logo and favicon URLs

| Asset | URL |
|---|---|
| 7D favicon (SVG, responds to light/dark mode) | https://www.7dimensions.eu/web/image/308063-70a7d541/7d-7d-favicon.svg |
| 7D emblem for dark backgrounds (SVG, white) | https://www.7dimensions.eu/web/image/308059-41caa60a/7d-7d-mark-dark.svg |
| 7D emblem 512px PNG (schema.org logo) | https://www.7dimensions.eu/web/image/308049-38510cec/7d-7d-mark-512.png |
| 7D OG image | https://www.7dimensions.eu/web/image/308048-8bfeafc9/7d-7d-og.png |
| 7D Odoo favicon (ICO) | https://www.7dimensions.eu/web/image/website/3/favicon |
| AEC Pilot favicon (PNG embedded in SVG; two images, light/dark) | https://www.aecpilot.com/web/image/308064-9db8e530/7d-aec-favicon.svg |
| AEC Pilot header logo (511×102, white) | https://www.aecpilot.com/web/image/website/10/logo/AEC%20Pilot |
| AEC Pilot wordmark white PNG | https://www.aecpilot.com/web/content/307031/aec-logo-wordmark-white.png (on the 7D site: https://www.7dimensions.eu/web/image/308060-3db9cf34/7d-aec-wordmark-white.png) |

**How the 7D emblem is drawn:** a slanted (isometric) hexagon with a point at the top — the silhouette of a cube seen from above. The hexagon is drawn with a thick single-colour line (stroke, no fill) and is not closed: the lines break and turn inwards like circuit board traces. Two lines extend out from the top left and one from the bottom right, each ending in a hollow ring (a circuit "pad"); in the middle there is a trace curling into the hexagon and a small ring. The shape reads as "cube + circuit", a combination of 3D/BIM and software. The colour is a gradient running from top left to bottom right:
- on light backgrounds `#000000` (offset .22) → `#225AA5` (offset .80),
- on dark backgrounds (`prefers-color-scheme: dark` in the favicon) `#FFFFFF` → `#CDE1FF`,
- `mark-dark.svg` white → very light blue for the dark menu.

**7D wordmark:** emblem (40px high) + 13px gap + "**7**Dimensions" (Sora 700, 21px, white; only the letter "7" uses gradient text `#9CC4FF → #4285F4 → #8B5CF6`) + below it a 7-segment bar 3px high ("seven dimensions"): segments `#7FB2FF`, opacity in turn .22 / .34 / .46 / .58 / .70 / .84, the last one a `#7FB2FF → #A78BFA` gradient; on hover all become 1.

**Suggested redraw as inline SVG (for SiteKeep `.brand-mark`, 28×28):**
- `viewBox="0 0 32 32"`, `fill="none"`, `stroke="url(#g7d)"`, `stroke-width="2.4"`, `stroke-linecap="round"`, `stroke-linejoin="round"`.
- Hexagon corners approximately: (16,3) (27,9.5) (27,22.5) (16,29) (5,22.5) (5,9.5); leave the top-left edge open and extend two short traces (one horizontal, one at 30°) to the top left from there, ending each in an `r=2` ring (`circle` stroke, no fill).
- A short trace to the right from the bottom-right corner ending in a ring; inside the hexagon, a trace curling towards the centre and a small ring.
- Gradient: `<linearGradient id="g7d" x1="0" y1="0" x2="1" y2="1">` in light mode `#021E45 → #3B6FB5` (brand navy instead of pure black, matching the CDE palette), in dark mode `#FFFFFF → #CDE1FF`. For theme switching, `stop-color: var(--...)` can be used.
- The "SiteKeep" text next to the emblem: Inter 700 (if Sora is wanted, `Sora:wght@700` must additionally be loaded from Google Fonts for this text only).
- The logo file was not downloaded or committed; the SVG must be drawn by hand, or the source SVG obtained separately with permission to use it.

**AEC Pilot logo:** white rhombus with rounded corners (a square rotated 45°) with a negative-space notch resembling an "S"/pilot route + a thin vertical divider + "AEC PILOT" in capitals, a widely spaced monospace-like typeface. Only the dark (navy) background variant is published.

### 1.4 Button, input, card

| Element | 7Dimensions | AEC Pilot |
|---|---|---|
| Primary button | Pill (`border-radius: 999px`), `padding: 12px 22px`, weight 600; blue `#4285F4` + `box-shadow: 0 8px 24px -8px rgba(66,133,244,.7)`, lifts 2px on hover | Odoo `.btn-primary` `#021E45`, radius `.5rem`; in dark sections pill + `0 4px 24px rgba(59,130,246,.35)` |
| Secondary button | White bg + `1px #E5E7EB` border, border `#4285F4` on hover | outline-light, pill, `backdrop-filter: blur(8px)` |
| Small in-app button | — | `border-radius: 8px`, `.38rem .8rem`, .82rem |
| Input | — | `border-radius: 10px`, border `#D8DEE8`, bg `#F9FAFC`; focus: bg `#FFF`, border `#3B6FB5`, `box-shadow: 0 0 0 4px rgba(59,111,181,.15)` |
| Card | `radius 18px`, `1px #E5E7EB`, padding 30px; hover border `rgba(66,133,244,.45)`, shadow `0 18px 40px -22px rgba(2,30,69,.35)` | `radius 12px`, `1px #E5E7EB`, shadow `0 2px 10px rgba(2,30,69,.05)`; hover `0 14px 30px rgba(2,30,69,.12)` |
| Dropdown | radius 14px, item radius 9px, shadow `0 25px 50px -12px rgba(2,30,69,.28)` | — |
| Label/pill | pill, mono .72rem, bg `rgba(127,178,255,.14)` | — |

Shadows are always navy-tinted (`rgba(2,30,69,…)`), not grey.

### 1.5 Overall tone

- **Structure:** the top menu, hero and footer are dark navy (`#021E45/#041530`), content sections are white / `#F6F7F9`. In short, "dark frame + light content".
- **Density:** as marketing sites they are airy (section padding 96px, large headings). SiteKeep is a business application; its density (14px body) must be kept, and only the colour/font/radius/shadow language should be adopted.
- **Details:** uppercase mono "eyebrow" labels, a fine grid pattern, blue→purple gradient accents, a slight lift on hover.
- **Dark mode:** the sites have **no** `prefers-color-scheme` support (only the two favicon SVGs change colour for the dark theme). The dark mode below was derived from the sites' dark sections (`.d7-dark`, `.o_cc4`, terminal).

---

## 2. Proposed token set for SiteKeep

File: `apps/web/src/theme.css` (only `:root` tokens + Inter `@import`).

### Light mode

| Token | Value | Source / rationale |
|---|---|---|
| `--bg` | `#F6F7F9` | 7D `--d7-soft` |
| `--surface` | `#FFFFFF` | |
| `--surface-2` | `#F7F8FA` | AEC card image background |
| `--border` | `#E5E7EB` | shared line |
| `--text` | `#111827` | shared ink |
| `--muted` | `#5B6472` | `#6B7280` gives 4.51 on `--bg` (borderline); darkened for AA margin |
| `--primary` | `#3B6FB5` | AEC `--o-color-2`, focus/gradient blue |
| `--primary-hover` | `#2D5A96` | between `#3B6FB5` and navy |
| `--primary-soft` | `#EEF3FB` | 7D menu hover |
| `--danger` / `--danger-soft` | `#B91C1C` / `#FEF2F2` | AEC error red |
| `--ok` / `--ok-soft` | `#15803D` / `#ECFDF3` | AEC `#16A34A` gives 3.3 on white → one shade darker for AA |
| `--warn` / `--warn-soft` | `#92400E` / `#FFF7E6` | 7D amber dark end / AEC warning background |
| `--radius` | `10px` | AEC input/form button |
| `--shadow` | `0 1px 2px rgba(2,30,69,.06), 0 2px 10px rgba(2,30,69,.05)` | AEC card shadow, navy tint |
| `font-family` | `"Inter", "Segoe UI", system-ui, -apple-system, Arial, sans-serif` | font of both sites |

### Dark mode (`@media (prefers-color-scheme: dark)`)

| Token | Value | Source / rationale |
|---|---|---|
| `--bg` | `#041530` | 7D `--d7-navy` |
| `--surface` | `#0A1F3D` | one shade lighter than AEC terminal `#0A1830` |
| `--surface-2` | `#0F2748` | |
| `--border` | `#22395C` | equivalent of `rgba(255,255,255,.1)` |
| `--text` | `#F6F7F9` | dark section text |
| `--muted` | `#B8C4D6` | 7D dark section paragraph |
| `--primary` | `#5B9BF0` | AEC light blue |
| `--primary-hover` | `#7FB2FF` | 7D `--d7-blue-2` |
| `--primary-soft` | `#16305A` | |
| `--danger` / `--danger-soft` | `#F87171` / `#3A1620` | |
| `--ok` / `--ok-soft` | `#4ADE80` / `#0F3326` | |
| `--warn` / `--warn-soft` | `#FBBF24` / `#3A2E0F` | 7D ERP yellow |
| `--shadow` | `0 1px 2px rgba(0,0,0,.4), 0 8px 24px -12px rgba(0,0,0,.55)` | |

### Contrast checks (WCAG 2.x, AA threshold for normal text 4.5:1)

Light mode:

| Foreground / background | Ratio | Result |
|---|---|---|
| `--text #111827` / `--bg #F6F7F9` | 16.55 | AA ✔ (AAA) |
| `--text` / `--surface #FFF` | 17.74 | AA ✔ |
| `--text` / `--primary-soft #EEF3FB` (selected row) | 15.92 | AA ✔ |
| `--muted #5B6472` / `--bg` | 5.58 | AA ✔ |
| `--muted` / `--surface` | 5.98 | AA ✔ |
| `--muted` / `--surface-2 #F7F8FA` | 5.63 | AA ✔ |
| `--primary #3B6FB5` / `--surface` (link) | 5.09 | AA ✔ |
| `--primary` / `--bg` | 4.75 | AA ✔ |
| `--primary` / `--primary-soft` (badge.info, active tree node) | 4.57 | AA ✔ (close to the threshold) |
| **Primary button: white / `--primary #3B6FB5`** | **5.09** | AA ✔ |
| White / `--primary-hover #2D5A96` | 6.97 | AA ✔ |
| `--danger #B91C1C` / `--danger-soft` · `--bg` | 5.91 · 6.04 | AA ✔ |
| `--ok #15803D` / `--ok-soft` · `--bg` | 4.76 · 4.68 | AA ✔ |
| `--warn #92400E` / `--warn-soft` · `--bg` | 6.65 · 6.61 | AA ✔ |

Dark mode:

| Foreground / background | Ratio | Result |
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
| **Primary button: white / `--primary #5B9BF0`** | **2.84** | **AA ✘** (see below) |
| Navy `#021E45` / `--primary #5B9BF0` | 5.80 | AA ✔ |
| Navy `#021E45` / `--primary-hover #7FB2FF` | 7.62 | AA ✔ |

### Primary button issue in dark mode (small change needed)

In `styles.css`, `button.primary { color: #fff; }` and `.brand-mark { color: #fff; }` are hard-coded. `--primary` is also used as the text colour for links, the active tab, badges and tree nodes. On a dark background, one colour cannot give both ≥4.5 as text and ≥4.5 for white text on top of it (mathematically impossible: one needs luminance ≥0.22, the other ≤0.18). So in dark mode, text legibility was given priority (`#5B9BF0`).

Proposed fix (the file was not touched in this task):
1. Add a token: `--on-primary: #ffffff` in light mode, `--on-primary: #021E45` in dark mode.
2. `styles.css`: in `button.primary` and `.brand-mark`, `color: #fff` → `color: var(--on-primary, #fff)`.

Once this is done, button text in dark mode reaches 5.80 (hover 7.62) and every pair passes AA. The current `styles.css` dark theme (`#5B9BD5` + white ≈ 2.9) already has the same problem, so the new theme does not make things worse.

### Rollout

1. In `apps/web/src/main.tsx`, add `import "./theme.css";` **below** the `import "./styles.css";` line (order matters: theme.css must come after).
2. The `@import` at the top of `theme.css` loads Inter 400/500/600/700 from Google Fonts. If external requests are not wanted for offline/KVKK (data protection) reasons, self-host with the `@fontsource/inter` package and remove the `@import` line.
3. Optional alignments (they do not change with theme.css because they are hard-coded in styles.css): button radius (`6px` fixed) → `var(--radius)` or `8px` like the AEC in-app button; `code, .mono` font → `"JetBrains Mono", Consolas, monospace` (7D mono; add `JetBrains+Mono:wght@400;500` from Google Fonts); input focus ring → `box-shadow: 0 0 0 4px rgba(59,111,181,.15)`; for the top bar background, navy `#021E45` + white text as on 7D/AEC could be considered (16.48:1 in both modes).
