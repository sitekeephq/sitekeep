export type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Row = Record<string, unknown>;

export const day = (iso: string | null | undefined): string | null => (iso ? iso.slice(0, 10) : null);
export const cut = (value: string | null | undefined, length: number): string | null =>
  value ? (value.length > length ? `${value.slice(0, length)}…` : value) : null;

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== null && value !== false && value !== "") query.set(key, value === true ? "1" : String(value));
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** Drops undefined / null / false / empty-array values (keeps 0). */
export function clean<T extends Row>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== false && !(Array.isArray(item) && !item.length)),
  ) as T;
}
