/**
 * Outbound connection registry: EVERY server-side call to another host goes through
 * outboundFetch() (HTTP) or outboundCall() (SMTP and other protocols). A test
 * (test/privacy.test.ts) fails when a raw fetch( appears elsewhere in src/.
 *
 * Each call:
 *   1. is refused when "Tüm Dış Bağlantıları Kapat" is on and the host is outside the network
 *      (private ranges + the "iç ağ" list), or when its connection is switched off in
 *      Gizlilik Merkezi → Dış Bağlantılar;
 *   2. is written to outbound_log: time, purpose, host, method, bytes out/in, status, duration,
 *      user and project when known (request context), and non-content details. NEVER content.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { eq, lt } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { outboundLog } from "../db/schema.js";
import { HttpError } from "../core/platform/http.js";
import { DEFAULT_LANGUAGE, msg, render, type Msg } from "../i18n/index.js";
import { isLanHost } from "../ai/hosts.js";
import { connectionDisabled, privacyState, refreshPrivacyState } from "./settings.js";

export interface OutboundContext {
  db?: Db | null;
  userId?: string | null;
  projectId?: string | null;
  /** What asked for the call, e.g. the route ("reports/generate") or a job name. */
  feature?: string | null;
}

export interface OutboundMeta {
  /** Registry connection id: "ai:<providerId>", "smtp", "office:editor", "office:converter", "ai:env". */
  connection?: string | null;
  /** Non-content details for the log (AI: feature, provider, characters sent, redaction counts). */
  details?: Record<string, unknown>;
  userId?: string | null;
  projectId?: string | null;
}

/** The call was refused before connecting (kill switch or a disabled connection). */
export class OutboundBlockedError extends HttpError {
  constructor(message: Msg | string) {
    super(403, "outbound_blocked", message);
    // Callers that pass the text on (AI provider errors) get the default language, not the log's English.
    this.message = render(DEFAULT_LANGUAGE, message);
  }
}

const store = new AsyncLocalStorage<OutboundContext>();
let defaultDb: Db | null = null;

/** Database of the log when no request context names one (background jobs). */
export function configureOutbound(opts: { db: Db }): void {
  defaultDb = opts.db;
}

/** Runs fn with request details (user, project, feature) the log rows of its calls carry. */
export function withOutboundContext<T>(ctx: OutboundContext, fn: () => T): T {
  return store.run({ ...(store.getStore() ?? {}), ...ctx }, fn);
}

export function outboundContext(): OutboundContext | undefined {
  return store.getStore();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | null | undefined) => (v && UUID.test(v) ? v : null);

/** host[:port] of a URL ("smtp://user:pw@mail.local:587" → "mail.local:587"); a bare host as is. */
export function hostOf(target: string | URL): string {
  try {
    return new URL(String(target)).host || String(target);
  } catch {
    return String(target);
  }
}

function hostnameOf(target: string | URL): string {
  try {
    return new URL(String(target)).hostname;
  } catch {
    return String(target).replace(/:\d+$/, "");
  }
}

/** Size of a fetch body in bytes (null for streams). */
export function bodySize(body: unknown): number | null {
  if (body == null) return 0;
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString());
  if (body instanceof FormData) {
    let n = 0;
    for (const [k, v] of body) n += Buffer.byteLength(k) + (typeof v === "string" ? Buffer.byteLength(v) : v.size);
    return n;
  }
  return null;
}

interface Row {
  purpose: string;
  connection: string | null;
  host: string;
  method: string;
  local: boolean;
  blocked: boolean;
  bytesOut: number | null;
  bytesIn: number | null;
  status: number | null;
  error: string | null;
  durationMs: number | null;
  userId: string | null;
  projectId: string | null;
  details: Record<string, unknown> | null;
}

function logDb(): Db | null {
  return store.getStore()?.db ?? defaultDb;
}

function baseRow(purpose: string, target: string | URL, method: string, meta: OutboundMeta): Row {
  const ctx = store.getStore();
  const feature = ctx?.feature ?? null;
  const details = meta.details || feature ? { ...(feature ? { feature } : {}), ...(meta.details ?? {}) } : null;
  return {
    purpose: purpose.slice(0, 120),
    connection: meta.connection ?? null,
    host: hostOf(target).slice(0, 255),
    method: method.toUpperCase(),
    local: isLanHost(hostnameOf(target)),
    blocked: false,
    bytesOut: null,
    bytesIn: null,
    status: null,
    error: null,
    durationMs: null,
    userId: uuidOrNull(meta.userId ?? ctx?.userId),
    projectId: uuidOrNull(meta.projectId ?? ctx?.projectId),
    details,
  };
}

/** Writes a log row; never throws (a log failure must not break the call). */
async function insert(row: Row): Promise<string | null> {
  const db = logDb();
  if (!db) return null;
  try {
    const [r] = await db.insert(outboundLog).values(row).returning({ id: outboundLog.id });
    return r?.id ?? null;
  } catch {
    return null;
  }
}

function update(id: string | null, db: Db | null, patch: Partial<Row>): void {
  if (!id || !db) return;
  db.update(outboundLog)
    .set(patch)
    .where(eq(outboundLog.id, id))
    .catch(() => undefined);
}

/** Why a call to this target is refused right now (kill switch, disabled connection), or null. */
export function outboundRefusalMsg(target: string | URL, connection?: string | null, purpose?: string): Msg | null {
  const host = hostOf(target);
  if (!isLanHost(hostnameOf(target)) && privacyState().killSwitch.on) return msg("privacy:outbound.killSwitch", { host });
  if (connectionDisabled(connection)) return msg("privacy:outbound.connectionDisabled", { purpose: purpose ?? connection, host });
  return null;
}

/** outboundRefusalMsg() as text in the installation's default language (stored reasons, plain errors). */
export function outboundRefusal(target: string | URL, connection?: string | null, purpose?: string): string | null {
  const m = outboundRefusalMsg(target, connection, purpose);
  return m ? render(DEFAULT_LANGUAGE, m) : null;
}

/** Refuses (and logs) a call the kill switch or a disabled connection forbids; returns the log row. */
async function guard(purpose: string, target: string | URL, method: string, meta: OutboundMeta): Promise<Row> {
  await refreshPrivacyState(logDb());
  const row = baseRow(purpose, target, method, meta);
  const message = outboundRefusalMsg(target, row.connection, row.purpose);
  if (message) {
    await insert({ ...row, blocked: true, error: "blocked", durationMs: 0, bytesOut: 0 });
    throw new OutboundBlockedError(message);
  }
  return row;
}

function errorCode(err: unknown): string {
  const e = err as { name?: string; cause?: { name?: string; code?: string } };
  if (e?.name === "TimeoutError" || e?.cause?.name === "TimeoutError") return "timeout";
  if (e?.name === "AbortError") return "aborted";
  return String(e?.cause?.code ?? "network").slice(0, 40);
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** fetch() through the registry. purpose: "yapay_zeka:deepseek", "ofis:onlyoffice"… */
export async function outboundFetch(purpose: string, url: string | URL, init: RequestInit = {}, meta: OutboundMeta = {}): Promise<Response> {
  const method = init.method ?? "GET";
  const row = await guard(purpose, url, method, meta);
  row.bytesOut = bodySize(init.body);
  const db = logDb();
  const started = Date.now();
  let res: Response;
  try {
    // The one place in src/ that calls fetch (see the guard test).
    res = await globalThis.fetch(url, init);
  } catch (err) {
    await insert({ ...row, error: errorCode(err), durationMs: Date.now() - started });
    throw err;
  }
  const len = Number(res.headers.get("content-length"));
  const id = await insert({
    ...row,
    status: res.status,
    bytesIn: res.headers.has("content-length") && Number.isFinite(len) && len >= 0 ? len : null,
    durationMs: Date.now() - started,
  });
  if (!res.body || NULL_BODY.has(res.status)) return res;
  // Count the answer while the caller reads it; the row gets the real size and total time at the end.
  let n = 0;
  const counted = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        n += chunk.byteLength;
        ctl.enqueue(chunk);
      },
      flush() {
        update(id, db, { bytesIn: n, durationMs: Date.now() - started });
      },
    }),
  );
  const out = new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
  Object.defineProperty(out, "url", { value: res.url });
  Object.defineProperty(out, "redirected", { value: res.redirected });
  return out;
}

/**
 * Any other protocol (SMTP…) through the registry: the guard and one log row around fn.
 * `measure` reads sizes/status from the result (never content).
 */
export async function outboundCall<T>(
  purpose: string,
  target: string,
  meta: OutboundMeta & { method?: string; bytesOut?: number | null },
  fn: () => Promise<T>,
  measure?: (result: T) => { bytesOut?: number | null; bytesIn?: number | null; status?: number | null },
): Promise<T> {
  const row = await guard(purpose, target, meta.method ?? "CALL", meta);
  row.bytesOut = meta.bytesOut ?? null;
  const started = Date.now();
  try {
    const result = await fn();
    const m = measure?.(result) ?? {};
    await insert({
      ...row,
      bytesOut: m.bytesOut ?? row.bytesOut,
      bytesIn: m.bytesIn ?? null,
      status: m.status ?? null,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (err) {
    await insert({ ...row, error: errorCode(err), durationMs: Date.now() - started });
    throw err;
  }
}

// ---- Retention ------------------------------------------------------------------------------

/** Removes log rows older than the retention setting; returns the number removed. */
export async function cleanupOutboundLog(db: Db, now = new Date()): Promise<number> {
  const days = privacyState().settings.logRetentionDays;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const rows = await db.delete(outboundLog).where(lt(outboundLog.at, cutoff)).returning({ id: outboundLog.id });
  return rows.length;
}

/** Daily cleanup job (first run a minute after start). Returns a stop function. */
export function startOutboundCleanup(db: Db, opts: { log?: (m: string, e?: unknown) => void } = {}): () => void {
  const run = () =>
    void refreshPrivacyState(db)
      .then(() => cleanupOutboundLog(db))
      .catch((e) => opts.log?.("outbound log cleanup failed", e));
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
