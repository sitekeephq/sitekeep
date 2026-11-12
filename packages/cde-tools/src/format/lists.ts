/** First n items plus how many were left out. */
export function capList<T>(list: T[], n: number): { items: T[]; more?: number } {
  return list.length > n ? { items: list.slice(0, n), more: list.length - n } : { items: list };
}
