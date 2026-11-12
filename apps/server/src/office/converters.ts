/**
 * Office → PDF converter providers. Files go only to the address the administrator set.
 * - onlyoffice: ConvertService API (JSON, JWT); the server downloads the source from a
 *   one-time CDE URL, the PDF comes back as a download URL (asked again until endConvert)
 * - collabora: multipart POST /cool/convert-to/pdf
 * - gotenberg: multipart POST /forms/libreoffice/convert
 * - local: soffice on this server (last resort, only when a binary exists)
 */
import { randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConverterTimeoutError, ConverterUnavailableError, type Converters } from "../previews/converters.js";
import { signJwt } from "./jwt.js";
import { outboundFetch } from "../privacy/outbound.js";
import { DEFAULT_LANGUAGE, tFor, type MsgKey } from "../i18n/index.js";

/** Converter texts end up in errors, previews and the admin test: the installation's language. */
const t = tFor(DEFAULT_LANGUAGE);

export type OfficeConverterId = "onlyoffice" | "collabora" | "gotenberg" | "local";

export interface ConverterAvailability {
  ok: boolean;
  message: string;
}

export interface OfficeConverter {
  readonly id: OfficeConverterId;
  readonly label: string;
  available(): Promise<ConverterAvailability>;
  /** Converts the file at `input` (its name gives the format) and returns the PDF bytes. */
  toPdf(input: string, name: string): Promise<Buffer>;
}

/** The converter answered with an error status. */
export class ConverterHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface HttpConverterOptions {
  baseUrl: string;
  /** One conversion (all requests together). */
  timeoutMs: number;
  /** Retries after a network error, 429 or 5xx. */
  retries?: number;
  retryDelayMs?: number;
  /** Larger answers are rejected (default 512 MB). */
  maxOutputBytes?: number;
}

const MAX_OUTPUT = 512 * 1024 * 1024;

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return (m?.[1] ?? "bin").toLowerCase();
}

function isTimeout(err: unknown): boolean {
  const e = err as { name?: string; cause?: { name?: string } };
  return e?.name === "TimeoutError" || e?.name === "AbortError" || e?.cause?.name === "TimeoutError";
}

/** fetch failed before an answer (refused, DNS, reset). */
function isNetwork(err: unknown): boolean {
  return err instanceof TypeError && /fetch failed|network/i.test(err.message);
}

function netMessage(err: unknown, base: string): string {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  return t("office:converter.unreachable", { target: base, cause: cause?.code ?? cause?.message ?? (err as Error).message });
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) throw new ConverterHttpError(413, t("office:converter.outputTooLarge"));
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > max) throw new ConverterHttpError(413, t("office:converter.outputTooLarge"));
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function errorText(res: Response): Promise<string> {
  try {
    const t = (await res.text()).replace(/\s+/g, " ").trim();
    return t.length > 300 ? `${t.slice(0, 300)}…` : t;
  } catch {
    return "";
  }
}

function assertPdf(buf: Buffer, who: string): Buffer {
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error(t("office:converter.notPdf", { who }));
  return buf;
}

abstract class HttpConverter implements OfficeConverter {
  abstract readonly id: OfficeConverterId;
  abstract readonly label: string;
  protected readonly base: string;

  constructor(protected readonly opts: HttpConverterOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
  }

  abstract available(): Promise<ConverterAvailability>;
  protected abstract convertOnce(input: string, name: string, deadline: number): Promise<Buffer>;

  /** Time left until the deadline; throws when it passed. */
  protected left(deadline: number): number {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new ConverterTimeoutError(t("office:converter.timeout"));
    return ms;
  }

  protected async request(url: string, init: RequestInit, deadline: number): Promise<Response> {
    try {
      return await outboundFetch(`ofis:${this.id}`, url, { ...init, redirect: "error", signal: AbortSignal.timeout(this.left(deadline)) }, { connection: "office:converter" });
    } catch (err) {
      if (isTimeout(err)) throw new ConverterTimeoutError(t("office:converter.timeout"));
      throw err;
    }
  }

  protected async check(url: string, init: RequestInit = {}): Promise<Response> {
    return outboundFetch(`ofis:${this.id}`, url, { ...init, redirect: "error", signal: AbortSignal.timeout(Math.min(15_000, this.opts.timeoutMs)) }, { connection: "office:converter" });
  }

  async toPdf(input: string, name: string): Promise<Buffer> {
    const deadline = Date.now() + this.opts.timeoutMs;
    const retries = this.opts.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.convertOnce(input, name, deadline);
      } catch (err) {
        const retryable =
          isNetwork(err) || (err instanceof ConverterHttpError && (err.status === 429 || err.status >= 500));
        if (!retryable || attempt >= retries || Date.now() >= deadline) {
          if (isNetwork(err)) throw new ConverterUnavailableError(netMessage(err, this.label));
          throw err;
        }
        await new Promise((r) => setTimeout(r, (this.opts.retryDelayMs ?? 1000) * (attempt + 1)));
      }
    }
  }
}

// ---- ONLYOFFICE ------------------------------------------------------------------------------

/** Publishes a local file at a one-time URL the converter can download. */
export type SourcePublisher = (filePath: string, name: string) => { url: string; release(): void };

export interface OnlyofficeOptions extends HttpConverterOptions {
  jwtSecret: string | null;
  publish: SourcePublisher;
  pollIntervalMs?: number;
}

const ONLYOFFICE_ERRORS = {
  "-1": "office:converter.onlyoffice.codes.unknown",
  "-2": "office:converter.onlyoffice.codes.timeout",
  "-3": "office:converter.onlyoffice.codes.conversion",
  "-4": "office:converter.onlyoffice.codes.download",
  "-5": "office:converter.onlyoffice.codes.password",
  "-6": "office:converter.onlyoffice.codes.database",
  "-7": "office:converter.onlyoffice.codes.invalidRequest",
  "-8": "office:converter.onlyoffice.codes.invalidJwt",
  "-9": "office:converter.onlyoffice.codes.format",
  "-10": "office:converter.onlyoffice.codes.size",
} as const satisfies Record<string, MsgKey>;

interface ConvertAnswer {
  endConvert?: boolean;
  fileUrl?: string;
  percent?: number;
  error?: number | string;
}

function parseConvertAnswer(body: string): ConvertAnswer {
  const t = body.trim();
  if (t.startsWith("{")) return JSON.parse(t) as ConvertAnswer;
  // Older servers answer in XML: <FileResult><FileUrl>…</FileUrl><Percent>…</Percent><EndConvert>True</EndConvert></FileResult>
  const tag = (n: string) => new RegExp(`<${n}>([\\s\\S]*?)</${n}>`, "i").exec(t)?.[1]?.trim();
  const err = tag("Error");
  return {
    endConvert: /^true$/i.test(tag("EndConvert") ?? ""),
    fileUrl: tag("FileUrl")?.replace(/&amp;/g, "&"),
    percent: Number(tag("Percent") ?? 0),
    ...(err && { error: err }),
  };
}

export class OnlyofficeConverter extends HttpConverter {
  readonly id = "onlyoffice" as const;
  readonly label = "ONLYOFFICE";
  private endpoint: string | null = null;

  constructor(private readonly o: OnlyofficeOptions) {
    super(o);
  }

  async available(): Promise<ConverterAvailability> {
    try {
      const res = await this.check(`${this.base}/healthcheck`);
      const body = (await res.text()).trim();
      if (res.ok && body === "true") return { ok: true, message: t("office:converter.onlyoffice.running") };
      return { ok: false, message: `ONLYOFFICE healthcheck: HTTP ${res.status} ${body.slice(0, 80)}` };
    } catch (err) {
      return { ok: false, message: isTimeout(err) ? t("office:converter.onlyoffice.noAnswer") : netMessage(err, this.label) };
    }
  }

  /** The /converter endpoint (8.x), else the legacy /ConvertService.ashx. */
  private async post(body: Record<string, unknown>, deadline: number): Promise<ConvertAnswer> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    const payload: Record<string, unknown> = { ...body };
    if (this.o.jwtSecret) {
      payload.token = signJwt(body, this.o.jwtSecret);
      headers.Authorization = `Bearer ${signJwt({ payload: body }, this.o.jwtSecret)}`;
    }
    const paths = this.endpoint ? [this.endpoint] : ["/converter", "/ConvertService.ashx"];
    let last: Response | null = null;
    for (const p of paths) {
      const res = await this.request(`${this.base}${p}`, { method: "POST", headers, body: JSON.stringify(payload) }, deadline);
      if (res.status === 404 && p !== paths[paths.length - 1]) {
        await res.body?.cancel();
        continue;
      }
      last = res;
      if (res.ok) this.endpoint = p;
      break;
    }
    if (!last) throw new ConverterHttpError(404, t("office:converter.onlyoffice.serviceNotFound"));
    if (!last.ok) throw new ConverterHttpError(last.status, `ONLYOFFICE HTTP ${last.status}: ${await errorText(last)}`);
    return parseConvertAnswer(await last.text());
  }

  /** The result URL is fetched from the configured server only (its path, our origin). */
  private resultUrl(fileUrl: string): string {
    const u = new URL(fileUrl, `${this.base}/`);
    const b = new URL(this.base);
    if (u.origin === b.origin) return u.href;
    const prefix = b.pathname.replace(/\/+$/, "");
    const p = prefix && !u.pathname.startsWith(`${prefix}/`) ? `${prefix}${u.pathname}` : u.pathname;
    return `${b.origin}${p}${u.search}`;
  }

  protected async convertOnce(input: string, name: string, deadline: number): Promise<Buffer> {
    const source = this.o.publish(input, name);
    try {
      // Synchronous: ONLYOFFICE answers when the PDF is ready (≈1 s faster than polling on arm64);
      // a long conversion still comes back with endConvert: false and is asked again below.
      const body = {
        async: false,
        filetype: extensionOf(name),
        key: randomUUID(),
        outputtype: "pdf",
        title: name,
        url: source.url,
      };
      let answer = await this.post(body, deadline);
      while (!answer.error && !answer.endConvert) {
        await new Promise((r) => setTimeout(r, Math.min(this.o.pollIntervalMs ?? 1000, this.left(deadline))));
        answer = await this.post(body, deadline);
      }
      if (answer.error !== undefined && String(answer.error) !== "0") {
        const code = String(answer.error);
        const err = new ConverterHttpError(code === "-6" || code === "-1" ? 502 : 422, t("office:converter.onlyoffice.failed", {
            reason: code in ONLYOFFICE_ERRORS ? t(ONLYOFFICE_ERRORS[code as keyof typeof ONLYOFFICE_ERRORS]) : t("office:converter.onlyoffice.errorCode", { code }),
          }));
        throw err;
      }
      if (!answer.fileUrl) throw new Error(t("office:converter.onlyoffice.noResultUrl"));
      const res = await this.request(this.resultUrl(answer.fileUrl), {}, deadline);
      if (!res.ok) throw new ConverterHttpError(res.status, t("office:converter.onlyoffice.resultDownload", { status: res.status }));
      return assertPdf(await readCapped(res, this.opts.maxOutputBytes ?? MAX_OUTPUT), "ONLYOFFICE");
    } finally {
      source.release();
    }
  }
}

// ---- Collabora -------------------------------------------------------------------------------

export class CollaboraConverter extends HttpConverter {
  readonly id = "collabora" as const;
  readonly label = "Collabora Online";
  private prefix: "cool" | "lool" | null = null;

  async available(): Promise<ConverterAvailability> {
    try {
      const res = await this.check(`${this.base}/hosting/capabilities`);
      if (res.ok) {
        const caps = (await res.json().catch(() => ({}))) as { "convert-to"?: { available?: boolean }; productVersion?: string };
        if (caps["convert-to"] && caps["convert-to"].available === false)
          return { ok: false, message: t("office:converter.collabora.convertToOff") };
        return { ok: true, message: caps.productVersion ? t("office:converter.collabora.runningVersion", { version: caps.productVersion }) : t("office:converter.collabora.running") };
      }
      const disc = await this.check(`${this.base}/hosting/discovery`);
      if (disc.ok && (await disc.text()).includes("wopi-discovery")) return { ok: true, message: t("office:converter.collabora.running") };
      return { ok: false, message: `Collabora: HTTP ${disc.status}` };
    } catch (err) {
      return { ok: false, message: isTimeout(err) ? t("office:converter.collabora.noAnswer") : netMessage(err, this.label) };
    }
  }

  protected async convertOnce(input: string, name: string, deadline: number): Promise<Buffer> {
    const ext = extensionOf(name);
    const prefixes: ("cool" | "lool")[] = this.prefix ? [this.prefix] : ["cool", "lool"];
    for (const p of prefixes) {
      const form = new FormData();
      form.append("data", await openAsBlob(input), `input.${ext}`);
      const res = await this.request(`${this.base}/${p}/convert-to/pdf`, { method: "POST", body: form }, deadline);
      if (res.status === 404 && p !== prefixes[prefixes.length - 1]) {
        await res.body?.cancel();
        continue;
      }
      if (!res.ok) throw new ConverterHttpError(res.status, t("office:converter.collabora.failed", { status: res.status, detail: await errorText(res) }).trim());
      this.prefix = p;
      return assertPdf(await readCapped(res, this.opts.maxOutputBytes ?? MAX_OUTPUT), "Collabora");
    }
    throw new ConverterHttpError(404, t("office:converter.collabora.notFound"));
  }
}

// ---- Gotenberg -------------------------------------------------------------------------------

export interface GotenbergOptions extends HttpConverterOptions {
  /** "user:password" for Gotenberg's basic auth (optional). */
  basicAuth?: string | null;
}

export class GotenbergConverter extends HttpConverter {
  readonly id = "gotenberg" as const;
  readonly label = "Gotenberg";

  constructor(private readonly g: GotenbergOptions) {
    super(g);
  }

  private auth(): Record<string, string> {
    return this.g.basicAuth ? { Authorization: `Basic ${Buffer.from(this.g.basicAuth).toString("base64")}` } : {};
  }

  async available(): Promise<ConverterAvailability> {
    try {
      const res = await this.check(`${this.base}/health`, { headers: this.auth() });
      const body = (await res.json().catch(() => ({}))) as { status?: string; details?: { libreoffice?: { status?: string } } };
      if (res.ok && body.status === "up") return { ok: true, message: t("office:converter.gotenberg.running") };
      const lo = body.details?.libreoffice?.status;
      return { ok: false, message: `Gotenberg: HTTP ${res.status}${lo ? `, LibreOffice ${lo}` : ""}` };
    } catch (err) {
      return { ok: false, message: isTimeout(err) ? t("office:converter.gotenberg.noAnswer") : netMessage(err, this.label) };
    }
  }

  protected async convertOnce(input: string, name: string, deadline: number): Promise<Buffer> {
    const form = new FormData();
    // Gotenberg picks the import filter from the file name.
    form.append("files", await openAsBlob(input), `input.${extensionOf(name)}`);
    const res = await this.request(`${this.base}/forms/libreoffice/convert`, { method: "POST", body: form, headers: this.auth() }, deadline);
    if (!res.ok) throw new ConverterHttpError(res.status, t("office:converter.gotenberg.failed", { status: res.status, detail: await errorText(res) }).trim());
    return assertPdf(await readCapped(res, this.opts.maxOutputBytes ?? MAX_OUTPUT), "Gotenberg");
  }
}

// ---- Local soffice ---------------------------------------------------------------------------

export class LocalSofficeConverter implements OfficeConverter {
  readonly id = "local" as const;
  readonly label = t("office:converter.localLabel");

  constructor(private readonly converters: Converters) {}

  async available(): Promise<ConverterAvailability> {
    const s = this.converters.status().soffice;
    return { ok: s.available, message: s.available ? `soffice: ${s.path}` : s.hint };
  }

  async toPdf(input: string, name: string): Promise<Buffer> {
    const out = path.join(os.tmpdir(), `7dcde-office-${randomUUID()}.pdf`);
    try {
      await this.converters.officeToPdf(input, extensionOf(name), out);
      return await readFile(out);
    } finally {
      await rm(out, { force: true });
    }
  }
}

/** Rejects files over the size limit before anything is sent. */
export async function assertSize(input: string, maxFileMb: number): Promise<void> {
  const size = (await stat(input)).size;
  if (size > maxFileMb * 1024 * 1024)
    throw new Error(t("office:converter.fileTooLarge", { size: Math.ceil(size / 1024 / 1024), limit: maxFileMb }));
}
