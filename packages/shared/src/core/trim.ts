/**
 * Linear-time trims. `s.replace(/\/+$/, "")` and similar anchored-at-the-end patterns backtrack
 * quadratically on a long run of the character followed by something else (CodeQL js/polynomial-redos),
 * these loops do not.
 */

/** Removes every trailing "/" ("https://x///" → "https://x"). */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** Removes every leading and trailing "/" ("//a/b//" → "a/b"). */
export function trimSlashes(s: string): string {
  let start = 0;
  while (start < s.length && s.charCodeAt(start) === 47) start++;
  return trimTrailingSlashes(start ? s.slice(start) : s);
}

/** Removes the leading and trailing characters for which the predicates answer true (code points, not UTF-16 units). */
export function trimChars(s: string, leading: ((c: string) => boolean) | null, trailing: ((c: string) => boolean) | null): string {
  const chars = [...s];
  let start = 0;
  let end = chars.length;
  if (leading) while (start < end && leading(chars[start]!)) start++;
  if (trailing) while (end > start && trailing(chars[end - 1]!)) end--;
  return chars.slice(start, end).join("");
}
