/**
 * What a job's error looks like to people (formatJobError) and whether running the job again could help
 * (classifyJobError, retryDecision). Pure: no database, no i18n catalogue (the caller passes its `t`), so
 * both are unit-tested as tables and the same text is used wherever a job error is recorded.
 */

/** Technical text of anything thrown, for logs (never shown to people). */
export function thrownText(err: unknown): string {
  if (err instanceof Error) return err.name && err.name !== "Error" ? `${err.name}: ${err.message}` : err.message;
  return String(err);
}

const IFC_READER_PATTERNS = [
  /WebAssembly\.(Exception|RuntimeError)/i,
  /\bRuntimeError\b/,
  /memory access out of bounds/i,
  /^\s*(RuntimeError: )?unreachable/i,
  /\bAborted\(/,
  /\[object [^\]]*Exception\]/,
];

/** web-ifc (WebAssembly) failures: a thrown WebAssembly.Exception, a RuntimeError, an emscripten abort. */
export function isIfcReaderError(err: unknown): boolean {
  if (typeof WebAssembly !== "undefined") {
    const wa = WebAssembly as unknown as { Exception?: new (...a: never[]) => object; RuntimeError?: new (...a: never[]) => object };
    if (wa.Exception && err instanceof wa.Exception) return true;
    if (wa.RuntimeError && err instanceof wa.RuntimeError) return true;
  }
  if (err instanceof Error && err.name === "RuntimeError") return true;
  // The worker thread hands errors over as text, so the same shapes are recognised there.
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  return IFC_READER_PATTERNS.some((p) => p.test(text));
}

/** The two texts formatJobError may substitute, in the language of the caller (jobs:queue.ifcReaderError, jobs:queue.unknownError). */
export interface JobErrorTexts {
  ifcReader: string;
  unknown: string;
}

/**
 * `message` is what is stored on the job and shown to people; `detail` is the technical text for the server
 * log. Errors that already read well (translated messages, the Revit "no 3D elements" one) pass unchanged;
 * only unreadable ones (WebAssembly exceptions, non-Error throws) are replaced.
 */
export function formatJobError(err: unknown, texts: JobErrorTexts): { message: string; detail: string } {
  const detail = thrownText(err);
  if (isIfcReaderError(err)) return { message: texts.ifcReader, detail };
  if (err instanceof Error) return { message: err.message || texts.unknown, detail };
  if (typeof err === "string" && err.trim()) return { message: err, detail };
  return { message: texts.unknown, detail };
}

/** Job kinds that may be run again (automatically and from the failed-jobs view): re-running changes nothing twice. */
export const RETRYABLE_JOB_KINDS: ReadonlySet<string> = new Set([
  // Derivatives are rebuilt from the stored file and replace the old one; the status goes back to "processing".
  "ifc_to_frag",
  "ifc_index",
  // Connect module: records are upserted by (connection, kind, external id), watermarks only advance on success.
  "autodesk_sync",
]);

/** Total runs of a job including the first (so two automatic retries). */
export const MAX_JOB_ATTEMPTS = 3;
/** Wait before run 2 and run 3. */
export const JOB_RETRY_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000];

const NETWORK_CODES = /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b|fetch failed|socket hang up/i;
const NEVER_RETRY = /\b(ENOSPC|EDQUOT)\b|no space left/i;
const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);
const STATUS_TEXT = /\b(?:HTTP|status(?: code)?)[\s:=]*(429|502|503|504)\b|\b(429|502|503|504)\s+(?:Too Many Requests|Bad Gateway|Service Unavailable|Gateway Time-?out)|\b(?:Too Many Requests|Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i;

function chain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur != null; i++) {
    out.push(cur);
    cur = typeof cur === "object" ? (cur as { cause?: unknown }).cause : undefined;
  }
  return out;
}

/**
 * Transient = the same job may succeed a little later: network failures and HTTP 429/502/503/504 from an
 * outbound call. Everything else (unreadable or unsupported file, validation, other 4xx, full disk, timeouts of
 * our own conversion) is permanent: running it again gives the same result.
 */
export function classifyJobError(err: unknown): "transient" | "permanent" {
  const parts = chain(err);
  const texts = parts.map((p) => (p instanceof Error ? `${p.message} ${(p as { code?: unknown }).code ?? ""}` : typeof p === "object" ? String((p as { code?: unknown }).code ?? "") : String(p)));
  if (texts.some((s) => NEVER_RETRY.test(s))) return "permanent";
  if (parts.some((p) => isIfcReaderError(p))) return "permanent";
  for (const p of parts) {
    if (typeof p !== "object") continue;
    const o = p as { status?: unknown; statusCode?: unknown };
    const status = Number(o.status ?? o.statusCode);
    if (Number.isInteger(status) && status >= 400) return TRANSIENT_STATUS.has(status) ? "transient" : "permanent";
  }
  return texts.some((s) => NETWORK_CODES.test(s) || STATUS_TEXT.test(s)) ? "transient" : "permanent";
}

/** After a failed run: run again after `delayMs`, or fail for good. `attempts` counts the run that just failed. */
export function retryDecision(kind: string, attempts: number, err: unknown): { retry: true; delayMs: number } | { retry: false } {
  if (!RETRYABLE_JOB_KINDS.has(kind) || attempts >= MAX_JOB_ATTEMPTS || classifyJobError(err) !== "transient") return { retry: false };
  const delayMs = JOB_RETRY_BACKOFF_MS[Math.min(attempts, JOB_RETRY_BACKOFF_MS.length) - 1] ?? JOB_RETRY_BACKOFF_MS[JOB_RETRY_BACKOFF_MS.length - 1]!;
  return { retry: true, delayMs };
}
