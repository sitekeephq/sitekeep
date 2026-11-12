/**
 * Office integration: the configured converter (office → PDF for previews, markups, compare)
 * and the configured browser editor (WOPI discovery, cached).
 */
import { createHash, randomBytes } from "node:crypto";
import { writeFile, rm, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  officeConverterLabel,
  officeEditorLabel,
  type OfficeCheckStep,
  type OfficeStatusDto,
  type OfficeTestResultDto,
} from "@sitekeep/shared";
import type { Db } from "../db/index.js";
import { ConverterTimeoutError, ConverterUnavailableError, type Converters } from "../previews/converters.js";
import {
  CollaboraConverter,
  GotenbergConverter,
  LocalSofficeConverter,
  OnlyofficeConverter,
  assertSize,
  type OfficeConverter,
} from "./converters.js";
import { extensionsWith, parseDiscovery, toPublicUrl, type Discovery } from "./discovery.js";
import { getStoredOfficeSettings, resolveOfficeConfig, type OfficeConfig } from "./settings.js";
import { outboundFetch, outboundRefusal } from "../privacy/outbound.js";
import { DEFAULT_LANGUAGE, tFor } from "../i18n/index.js";

/** Converter and editor texts reach errors and previews: the installation's language. */
const t = tFor(DEFAULT_LANGUAGE);

export const OFFICE_CONVERTER_HINT = t("office:service.converterHint");

/** Conversion source tickets live this long (ONLYOFFICE downloads the file once). */
const SOURCE_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const DISCOVERY_RETRY_MS = 60 * 1000;

export interface OfficeIntegrationOptions {
  db: Db;
  secretKey: Buffer;
  /** Local process converters (soffice is the last-resort provider). */
  converters: Converters;
  env?: NodeJS.ProcessEnv;
  /** Delay between retries (tests use a few ms). */
  retryDelayMs?: number;
  pollIntervalMs?: number;
}

/** Interface the preview jobs use. */
export interface OfficePdf {
  officeToPdf(inputPath: string, extension: string, outPath: string): Promise<void>;
  /**
   * A converter is configured, so office PDFs (exact page layout) can be made. No network call:
   * cheap enough for every preview request. Office files are viewed in the browser without it.
   */
  canConvert(): Promise<boolean>;
}

class Gate {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  async run<T>(limit: number, fn: () => Promise<T>): Promise<T> {
    while (this.running >= Math.max(1, limit)) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

interface CachedDiscovery {
  url: string;
  at: number;
  discovery: Discovery | null;
  error: string | null;
}

export class OfficeIntegration implements OfficePdf {
  readonly db: Db;
  private readonly gate = new Gate();
  private readonly sources = new Map<string, { path: string; name: string; expires: number }>();
  private cache: CachedDiscovery | null = null;
  private loading: Promise<CachedDiscovery> | null = null;

  constructor(private readonly opts: OfficeIntegrationOptions) {
    this.db = opts.db;
  }

  get converters(): Converters {
    return this.opts.converters;
  }

  async config(): Promise<OfficeConfig> {
    return resolveOfficeConfig(await getStoredOfficeSettings(this.db), this.opts.secretKey, this.opts.env ?? process.env);
  }

  // ---- Converter -----------------------------------------------------------------------------

  /** Resolves the converter for the settings; null with a reason when there is none. */
  async converterFor(cfg: OfficeConfig): Promise<{ converter: OfficeConverter | null; auto: boolean; reason: string }> {
    const c = cfg.converter;
    let kind = c.kind;
    let url = c.url;
    const auto = kind === "auto";
    if (kind === "auto") {
      if (cfg.editor.kind !== "none" && cfg.editor.url) {
        kind = cfg.editor.kind;
        url = cfg.editor.url;
      } else {
        const local = new LocalSofficeConverter(this.opts.converters);
        return (await local.available()).ok
          ? { converter: local, auto, reason: "" }
          : { converter: null, auto, reason: OFFICE_CONVERTER_HINT };
      }
    }
    if (kind === "none") return { converter: null, auto, reason: t("office:service.converterOff") };
    if (kind === "local") return { converter: new LocalSofficeConverter(this.opts.converters), auto, reason: "" };
    if (!url && kind === cfg.editor.kind) url = cfg.editor.url;
    if (!url) return { converter: null, auto, reason: t("office:service.converterUrlMissing", { converter: officeConverterLabel(kind, DEFAULT_LANGUAGE) }) };
    // Gizlilik Merkezi: the converter connection is off, or the kill switch forbids its host.
    const refused = outboundRefusal(url, "office:converter", `ofis:${kind}`);
    if (refused) return { converter: null, auto, reason: refused };
    const http = {
      baseUrl: url,
      timeoutMs: c.timeoutSec * 1000,
      retries: c.retries,
      retryDelayMs: this.opts.retryDelayMs,
    };
    if (kind === "collabora") return { converter: new CollaboraConverter(http), auto, reason: "" };
    if (kind === "gotenberg") return { converter: new GotenbergConverter({ ...http, basicAuth: cfg.gotenbergAuth }), auto, reason: "" };
    if (!cfg.wopiBaseUrl)
      return {
        converter: null,
        auto,
        reason: t("office:service.onlyofficeNeedsWopiBase"),
      };
    const base = cfg.wopiBaseUrl;
    return {
      converter: new OnlyofficeConverter({
        ...http,
        jwtSecret: cfg.jwtSecret,
        pollIntervalMs: this.opts.pollIntervalMs,
        publish: (p, n) => this.publishSource(base, p, n),
      }),
      auto,
      reason: "",
    };
  }

  /** A converter is configured (the remote ones are not pinged; local soffice must exist). */
  async canConvert(): Promise<boolean> {
    const { converter } = await this.converterFor(await this.config());
    if (!converter) return false;
    return converter.id === "local" ? (await converter.available()).ok : true;
  }

  /** Preview jobs: office file → PDF at outPath. */
  async officeToPdf(inputPath: string, extension: string, outPath: string): Promise<void> {
    const cfg = await this.config();
    const { converter, reason } = await this.converterFor(cfg);
    if (!converter) throw new ConverterUnavailableError(reason);
    const name = `input.${extension.replace(/[^a-z0-9]/gi, "") || "bin"}`;
    if (converter.id !== "local") await assertSize(inputPath, cfg.converter.maxFileMb);
    // The local converter queues on its own (one soffice at a time).
    const pdf =
      converter.id === "local"
        ? await converter.toPdf(inputPath, name)
        : await this.gate.run(cfg.converter.concurrency, () => converter.toPdf(inputPath, name));
    await writeFile(outPath, pdf);
  }

  // ---- Conversion sources (ONLYOFFICE downloads the input from the CDE) ----------------------

  publishSource(baseUrl: string, filePath: string, name: string): { url: string; release(): void } {
    const now = Date.now();
    for (const [k, v] of this.sources) if (v.expires < now) this.sources.delete(k);
    const ticket = randomBytes(32).toString("base64url");
    const key = createHash("sha256").update(ticket).digest("hex");
    this.sources.set(key, { path: filePath, name, expires: now + SOURCE_TTL_MS });
    return {
      url: `${baseUrl.replace(/\/+$/, "")}/wopi/convert/${ticket}/${encodeURIComponent(name)}`,
      release: () => this.sources.delete(key),
    };
  }

  takeSource(ticket: string): { path: string; name: string } | null {
    const key = createHash("sha256").update(ticket).digest("hex");
    const s = this.sources.get(key);
    if (!s || s.expires < Date.now()) return null;
    return { path: s.path, name: s.name };
  }

  // ---- Editor discovery ----------------------------------------------------------------------

  /** Discovery of the configured editor (cached for an hour; refresh: true skips the cache). */
  async discovery(cfg: OfficeConfig, refresh = false): Promise<Discovery> {
    if (cfg.editor.kind === "none" || !cfg.editor.url) throw new Error(t("office:service.editorNotConfigured"));
    // Gizlilik Merkezi: the editor connection is off, or the kill switch forbids its host.
    const refused = outboundRefusal(cfg.editor.url, "office:editor", `ofis:${cfg.editor.kind}`);
    if (refused) throw new Error(refused);
    const url = `${cfg.editor.url}/hosting/discovery`;
    const c = this.cache;
    const fresh = c && c.url === url && Date.now() - c.at < (c.discovery ? DISCOVERY_TTL_MS : DISCOVERY_RETRY_MS);
    const loaded = !refresh && fresh ? c : await this.loadDiscovery(url, cfg.editor.publicUrl, cfg.editor.kind);
    if (!loaded.discovery) throw new Error(loaded.error ?? t("office:service.discoveryFailed"));
    return loaded.discovery;
  }

  /**
   * Origins the browser opens the editor from: the public (else internal) editor address and the
   * action and icon addresses of the cached discovery. The page CSP allows only these in frame-src,
   * form-action and img-src (privacy/headers.ts).
   */
  async editorOrigins(): Promise<string[]> {
    const cfg = await this.config();
    if (cfg.editor.kind === "none" || !cfg.editor.url) return [];
    const out = new Set<string>();
    const add = (u: string | null | undefined) => {
      try {
        if (u) out.add(new URL(u).origin);
      } catch {
        /* not a URL */
      }
    };
    add(cfg.editor.publicUrl ?? cfg.editor.url);
    // Without a public address the editor may report its own host: warm the discovery in the
    // background so the next page load allows it too (a page never waits for the editor here).
    if (!cfg.editor.publicUrl && !this.cache && !this.loading) void this.discovery(cfg).catch(() => undefined);
    const d = this.cache?.discovery;
    if (d) {
      for (const a of d.actions) add(toPublicUrl(a.urlsrc, cfg.editor.url, cfg.editor.publicUrl));
      for (const f of Object.values(d.favIcons)) add(toPublicUrl(f, cfg.editor.url, cfg.editor.publicUrl));
    }
    return [...out];
  }

  /** Drops the cached discovery (settings changed, proof key rotated). */
  resetDiscovery(): void {
    this.cache = null;
  }

  private loadDiscovery(url: string, publicUrl: string | null, kind: string): Promise<CachedDiscovery> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      let entry: CachedDiscovery;
      try {
        const res = await outboundFetch(`ofis:${kind}`, url, { redirect: "error", signal: AbortSignal.timeout(15_000) }, { connection: "office:editor" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const zone = publicUrl?.startsWith("https:") || url.startsWith("https:") ? "external-https" : "external-http";
        entry = { url, at: Date.now(), discovery: parseDiscovery(await res.text(), zone), error: null };
      } catch (err) {
        const cause = (err as { cause?: { code?: string } }).cause?.code;
        entry = { url, at: Date.now(), discovery: null, error: t("office:service.discoveryFailedAt", { url, cause: cause ?? (err as Error).message }) };
      }
      this.cache = entry;
      return entry;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  // ---- Status and test -----------------------------------------------------------------------

  /** Labels in `lang` (the requester's); messages from the converter in the installation's. */
  async status(lang: string = DEFAULT_LANGUAGE): Promise<OfficeStatusDto> {
    const cfg = await this.config();
    const editor: OfficeStatusDto["editor"] = {
      kind: cfg.editor.kind,
      label: officeEditorLabel(cfg.editor.kind, lang),
      configured: cfg.editor.kind !== "none" && !!cfg.editor.url,
      editExtensions: [],
      viewExtensions: [],
      proofKey: false,
      error: null,
    };
    if (editor.configured) {
      try {
        const d = await this.discovery(cfg);
        editor.editExtensions = extensionsWith(d, "edit");
        editor.viewExtensions = extensionsWith(d, "view");
        editor.proofKey = !!d.proofKeys.current;
      } catch (err) {
        editor.error = (err as Error).message;
      }
    }
    const { converter, auto, reason } = await this.converterFor(cfg);
    let available = false;
    let message = reason;
    if (converter) {
      const a = await converter.available();
      available = a.ok;
      message = a.message;
    }
    return {
      editor,
      converter: {
        kind: converter?.id ?? null,
        label: officeConverterLabel(converter?.id ?? cfg.converter.kind, lang),
        auto,
        available,
        message,
      },
    };
  }

  /**
   * "Bağlantıyı test et": editor discovery, converter health and one real conversion. Step names
   * and the test's own texts in `lang` (the requester's); converter answers in the installation's.
   */
  async test(lang: string = DEFAULT_LANGUAGE): Promise<OfficeTestResultDto> {
    const tl = tFor(lang);
    const started = Date.now();
    const cfg = await this.config();
    const steps: OfficeCheckStep[] = [];
    if (cfg.editor.kind !== "none") {
      if (!cfg.editor.url) steps.push({ name: tl("office:test.steps.editor"), ok: false, message: tl("office:test.editorUrlMissing") });
      else {
        try {
          const d = await this.discovery(cfg, true);
          const edit = extensionsWith(d, "edit");
          steps.push({
            name: tl("office:test.steps.discovery"),
            ok: edit.length > 0,
            message: edit.length
              ? tl("office:test.editableFormats", { count: edit.length, list: `${edit.slice(0, 12).join(", ")}${edit.length > 12 ? "…" : ""}` })
              : tl("office:test.noEditAction"),
          });
          steps.push({
            name: tl("office:test.steps.proofKey"),
            ok: !!d.proofKeys.current || !cfg.editor.verifyProof,
            message: d.proofKeys.current
              ? tl("office:test.proofKeyRead")
              : cfg.editor.verifyProof
                ? tl("office:test.proofKeyMissing")
                : tl("office:test.proofOff"),
          });
        } catch (err) {
          steps.push({ name: tl("office:test.steps.discovery"), ok: false, message: (err as Error).message });
        }
      }
      if (!cfg.wopiBaseUrl)
        steps.push({
          name: tl("office:test.steps.cdeAddress"),
          ok: true,
          message: tl("office:test.cdeAddressEmpty"),
        });
    }
    const { converter, reason } = await this.converterFor(cfg);
    if (!converter) steps.push({ name: tl("office:test.steps.pdfConverter"), ok: cfg.converter.kind === "none", message: reason });
    else {
      const a = await converter.available();
      steps.push({ name: tl("office:test.steps.converterStatus", { name: converter.label }), ok: a.ok, message: a.message });
      if (a.ok) {
        const dir = await mkdtemp(path.join(os.tmpdir(), "7dcde-office-test-"));
        const input = path.join(dir, "baglanti-testi.txt");
        try {
          await writeFile(input, `${tl("office:test.trialFileText")}\n`, "utf8");
          const t0 = Date.now();
          const pdf = await this.gate.run(cfg.converter.concurrency, () => converter.toPdf(input, "baglanti-testi.txt"));
          steps.push({ name: tl("office:test.steps.trial"), ok: true, message: tl("office:test.trialOk", { bytes: pdf.length, ms: Date.now() - t0 }) });
        } catch (err) {
          const msg =
            err instanceof ConverterTimeoutError
              ? tl("office:test.trialTimeout")
              : err instanceof ConverterUnavailableError
                ? err.hint
                : (err as Error).message;
          steps.push({ name: tl("office:test.steps.trial"), ok: false, message: msg });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    }
    if (!steps.length) steps.push({ name: tl("office:test.steps.settings"), ok: false, message: tl("office:test.allOff") });
    return { ok: steps.every((s) => s.ok), latencyMs: Date.now() - started, steps };
  }
}
