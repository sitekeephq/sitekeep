/**
 * Recent server errors in memory (newest last), for the developer health check (cde_dev_health).
 * Filled from the Fastify logger (error and fatal levels), the HTTP error handler (500s) and the
 * job queue. Tokens, WOPI access tokens and conversion tickets are redacted before storing.
 */

export interface ServerErrorEntry {
  at: string;
  source: string;
  message: string;
  url?: string;
  stack?: string;
}

const CAPACITY = 100;
const entries: ServerErrorEntry[] = [];
const seen = new WeakSet<object>();

/**
 * Removes secrets from a log line: bearer / API / session / OAuth tokens, OAuth codes and client
 * secrets, WOPI access tokens, tickets.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1***")
    .replace(/(authorization["']?\s*[:=]\s*["']?basic\s+)[A-Za-z0-9+/=]+/gi, "$1***")
    .replace(/7dcde_([a-z]+)_[A-Za-z0-9_-]+/g, "7dcde_$1_***")
    .replace(/([?&](?:access_token|refresh_token|client_secret|code_verifier|code|token)=)[^&#\s"]*/gi, "$1***")
    .replace(/(\/wopi\/convert\/)[^/?#\s"]+/i, "$1***")
    .replace(/(x-api-key["']?\s*[:=]\s*["']?)[^"',\s]+/gi, "$1***");
}

function describe(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack?.split("\n").slice(1, 6).join("\n") };
  if (typeof err === "string") return { message: err };
  try {
    return { message: JSON.stringify(err).slice(0, 1000) };
  } catch {
    return { message: String(err) };
  }
}

/** Stores one error (an Error object is stored once even if several hooks report it). */
export function recordServerError(source: string, err: unknown, extra: { url?: string; message?: string } = {}): void {
  if (err && typeof err === "object") {
    if (seen.has(err)) return;
    seen.add(err);
  }
  const d = describe(err);
  const message = extra.message ? `${extra.message}: ${d.message}` : d.message;
  entries.push({
    at: new Date().toISOString(),
    source,
    message: redactSecrets(message).slice(0, 2000),
    ...(extra.url && { url: redactSecrets(extra.url) }),
    ...(d.stack && { stack: redactSecrets(d.stack) }),
  });
  if (entries.length > CAPACITY) entries.splice(0, entries.length - CAPACITY);
}

/** Newest first. */
export function recentServerErrors(limit = 20): ServerErrorEntry[] {
  return entries.slice(-limit).reverse();
}

export function clearServerErrors(): void {
  entries.length = 0;
}

/**
 * pino `hooks.logMethod` for the Fastify logger: error (50) and fatal (60) lines also go to the ring.
 * Arguments follow pino's call shapes: (obj, msg?) or (msg, ...args).
 */
export function logMethodHook(this: unknown, args: unknown[], method: (...a: unknown[]) => void, level: number): void {
  if (level >= 50) {
    try {
      const [first, second] = args;
      if (first instanceof Error) recordServerError("log", first, typeof second === "string" ? { message: second } : {});
      else if (first && typeof first === "object") {
        const o = first as { err?: unknown; req?: { url?: string }; msg?: string };
        recordServerError("log", o.err ?? (typeof second === "string" ? second : first), {
          url: o.req?.url,
          ...(o.err !== undefined && typeof second === "string" && { message: second }),
        });
      } else recordServerError("log", String(first));
    } catch {
      /* logging must never fail */
    }
  }
  method.apply(this, args);
}
