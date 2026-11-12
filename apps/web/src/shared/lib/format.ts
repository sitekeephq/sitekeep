/**
 * Dates, numbers and sizes in the interface language's locale (i18n/languages: meta.json "intl").
 * Never pass "tr-TR" or "en-GB" by hand: use these, or `intlLocale()` for an Intl call of your own.
 */
import { currentIntlLocale } from "../../i18n";

/** The current language's Intl locale ("en-GB", "tr-TR"). */
export function intlLocale(): string {
  return currentIntlLocale();
}

/**
 * Locale of the DATA (codes, names, layer and folder names users typed): Turkish case and sort
 * rules ("i" → "İ") whatever the interface language, so a code typed in the English interface is
 * the same code. Interface text uses intlLocale().
 */
export function dataLocale(): string {
  return "tr-TR";
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(intlLocale(), options);
}

/** 0.42 → "42%" / "%42" (each language puts the sign where it belongs). */
export function formatPercent(ratio: number, digits = 0): string {
  return ratio.toLocaleString(intlLocale(), { style: "percent", maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${formatNumber(value, { maximumFractionDigits: 1 })} ${units[unit]}`;
}

/** "2026-10-24" → "24/10/2026" (en-GB), "24.10.2026" (tr): calendar dates, no time zone shift. */
export function formatDay(ymd: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return ymd;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString(intlLocale(), { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(intlLocale(), { dateStyle: "short", timeStyle: "short" });
}

/** "3 minutes ago" / "3 dakika önce", "in 2 hours" / "2 saat sonra". */
export function formatRelative(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: "auto" });
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86_400), "day");
}

/** A schedule date ("2026-10-24…") as a calendar day in the interface language; "—" when missing. */
export function trDate(d: string | null | undefined): string {
  return d ? formatDay(d.slice(0, 10)) : "—";
}

/** "1234567.8" → "1.234.568 ₺" (TRY) or "1.234.568 EUR". */
export function money(n: number | null | undefined, currency = "TRY"): string {
  if (n === null || n === undefined) return "—";
  const v = n.toLocaleString("tr-TR", { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 });
  return currency === "TRY" ? `${v} ₺` : `${v} ${currency}`;
}

export function qty(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString("tr-TR", { maximumFractionDigits: 3 });
}
