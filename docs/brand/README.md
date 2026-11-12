# SiteKeep brand files

The product name is always written **SiteKeep**: capital S, capital K, no space. Domain, package and command names use lower case: `sitekeep.org`, `@sitekeep/sdk`, `sitekeep`.

![Preview](preview.png)

## Mark

The mark stacks the four states of the ISO 19650 common data environment. From bottom to top:

| Layer | State | Colour |
|---|---|---|
| 1 | Work in Progress (WIP) | grey `#9AA5B1` |
| 2 | Shared | amber `#F2A33A` |
| 3 | Published | green `#3B9A6B` |
| 4 | Archived | navy `#2E5A8A` / `#1F3A5F` |

The keyhole in the top archive layer stands for "your data stays with you, safe".

## Files

The SVGs are in the application's static folder: [apps/web/public/brand](../../apps/web/public/brand); the application
serves them from `/brand/<file>` (tab icon `/brand/sitekeep-favicon.svg`). The mark and wordmark in the interface
are drawn by [BrandMark.tsx](../../apps/web/src/shared/ui/BrandMark.tsx) (same shapes; the favicon drawing below
48 px).

| File | Use |
|---|---|
| `sitekeep-logo-horizontal.svg` / `-dark.svg` | Main logo: website header, application top bar, documents |
| `sitekeep-logo-stacked.svg` / `-dark.svg` | Square areas: sign-in screen, social media profile |
| `sitekeep-logo-mono-navy.svg`, `-black.svg`, `-white.svg` | Single-colour print, stamp, document letterhead |
| `sitekeep-mark.svg` / `-dark.svg` | Mark only (48 px and above) |
| `sitekeep-favicon.svg` | 16–32 px: browser tab. Simplified version: three layers, no keyhole |

The `-dark` files include a dark background (`#14243A`).

## Colours

| Name | Light background | Dark background |
|---|---|---|
| "Site" text | `#1F3A5F` | `#FFFFFF` |
| "Keep" text | `#D9861C` | `#F2A33A` |
| Dark background | — | `#14243A` |

## Typeface

The text is converted to outlines from Liberation Sans Bold (SIL Open Font License 1.1, `apps/server/assets/fonts/`); the SVGs look the same without the font installed. This is the first version; it may be replaced with a custom typeface before the trademark is registered.

## Edition names

**SiteKeep Community** (core without modules) and **SiteKeep Enterprise** (with modules). The application determines
which one it is from the installed modules (MIMARI.md → Editions).

## Regenerating

The SVGs are generated from Liberation Sans with [make_brand.py](make_brand.py); it writes to the folder the application uses:

```bash
pip install fonttools
python docs/brand/make_brand.py . apps/web/public/brand
```

The preview (`preview.png`) is updated by hand.

## Rules

- Do not rotate or stretch the logo, change its colours or add shadows.
- Leave clear space around the logo of at least a quarter of the mark's height.
- Below 48 px, use `sitekeep-favicon.svg`.
