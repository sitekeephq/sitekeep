import { currentLanguage } from "../../i18n";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export type RequestOptions = {
  signal?: AbortSignal;
};

export async function request<T>(
  method: string,
  url: string,
  body?: unknown,
  options: RequestOptions | AbortSignal = {},
): Promise<T> {
  const signal = options instanceof AbortSignal ? options : options.signal;
  const response = await fetch(`/api/v1${url}`, {
    method,
    credentials: "same-origin",
    // The server answers in this language where it can (error messages, docs/architecture/i18n.md).
    headers: {
      "accept-language": currentLanguage(),
      ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  const data = text ? safeJson(text) : null;
  if (!response.ok && !(response.status === 400 && method === "POST" && url.endsWith("/files"))) {
    const message = (data as { message?: string } | null)?.message ?? `HTTP ${response.status}`;
    if (response.status === 401 && !url.startsWith("/auth/")) {
      window.dispatchEvent(new Event("cde:unauthorized"));
    }
    throw new ApiError(response.status, message, data);
  }
  return data as T;
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const get = <T>(url: string, options?: RequestOptions) => request<T>("GET", url, undefined, options);
export const post = <T>(url: string, body?: unknown, options?: RequestOptions) =>
  request<T>("POST", url, body ?? {}, options);
export const put = <T>(url: string, body: unknown, options?: RequestOptions) =>
  request<T>("PUT", url, body, options);
export const patch = <T>(url: string, body: unknown, options?: RequestOptions) =>
  request<T>("PATCH", url, body, options);
export const del = <T>(url: string, options?: RequestOptions) =>
  request<T>("DELETE", url, undefined, options);

/** "?a=1&b=2" from the set values ("" when none). */
export const qs = (o: Record<string, string | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
};
