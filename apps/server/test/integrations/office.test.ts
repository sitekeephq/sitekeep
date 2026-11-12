/**
 * Office integration, pure parts and providers: discovery parsing (ONLYOFFICE and Collabora
 * fixtures), action URLs, WOPI proof keys, JWT, and the PDF converters against a mocked HTTP
 * server (success, timeout, bad status, retries, JWT header for ONLYOFFICE).
 */
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DbHandle } from "../../src/db/index.js";
import { putSetting } from "../../src/ai/settings.js";
import { Converters, ConverterTimeoutError, ConverterUnavailableError, type ProcessRunner } from "../../src/previews/converters.js";
import {
  CollaboraConverter,
  ConverterHttpError,
  GotenbergConverter,
  OnlyofficeConverter,
} from "../../src/office/converters.js";
import { buildActionUrl, extensionsWith, findAction, parseDiscovery, toPublicUrl } from "../../src/office/discovery.js";
import { signJwt, verifyJwt } from "../../src/office/jwt.js";
import {
  dateFromTicks,
  proofKeysFrom,
  publicKeyFromCspBlob,
  publicKeyFromModulus,
  signProof,
  ticksFromDate,
  verifyProof,
} from "../../src/office/proof.js";
import { OfficeIntegration } from "../../src/office/service.js";
import { OFFICE_SETTINGS_KEY } from "../../src/office/settings.js";
import { redactUrl } from "../../src/app/build-app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ONLYOFFICE_XML = readFileSync(path.join(here, "../fixtures/discovery-onlyoffice.xml"), "utf8");
const COLLABORA_XML = readFileSync(path.join(here, "../fixtures/discovery-collabora.xml"), "utf8");
const PDF = Buffer.from("%PDF-1.4\n% mock\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

// ---------------------------------------------------------------------------
// Mock HTTP server
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, body: Buffer, res: ServerResponse) => void | Promise<void>;
interface Mock {
  base: string;
  handler: Handler;
  requests: { method: string; url: string; headers: IncomingMessage["headers"]; body: Buffer }[];
  close(): Promise<void>;
}

async function mockServer(): Promise<Mock> {
  const m: Mock = {
    base: "",
    requests: [],
    handler: (_req, _body, res) => {
      res.statusCode = 404;
      res.end();
    },
    close: async () => undefined,
  };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    m.requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    try {
      await m.handler(req, body, res);
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  m.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  m.close = () =>
    new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return m;
}

let mock: Mock;
let tmp: string;
let input: string;

beforeAll(async () => {
  mock = await mockServer();
  tmp = mkdtempSync(path.join(os.tmpdir(), "7dcde-office-"));
  input = path.join(tmp, "Rapor.docx");
  writeFileSync(input, "PK-fake-docx-content");
});

afterAll(async () => {
  await mock.close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  mock.requests.length = 0;
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("WOPI discovery", () => {
  it("parses ONLYOFFICE discovery: per-extension actions, placeholders, proof key", () => {
    const d = parseDiscovery(ONLYOFFICE_XML, "external-http");
    expect(d.zone).toBe("external-http");
    expect(extensionsWith(d, "edit")).toEqual(["csv", "docm", "docx", "odp", "ods", "odt", "pptm", "pptx", "rtf", "txt", "xlsm", "xlsx"]);
    // Legacy binary formats only have view (and convert, which needs PUT_RELATIVE).
    expect(findAction(d, "doc", "edit")).toBeNull();
    expect(findAction(d, "doc", "view")?.urlsrc).toContain("/hosting/wopi/word/view?");
    expect(findAction(d, "pdf", "view")?.app).toBe("WordPdf");
    const edit = findAction(d, ".DOCX", "edit")!;
    expect(edit).toMatchObject({ app: "Word", name: "edit", requires: ["locks", "update"] });
    expect(edit.urlsrc).toContain("<wopisrc=WOPI_SOURCE&>");
    expect(d.favIcons.Word).toContain("favicon.ico");
    expect(d.proofKeys.current).not.toBeNull();
    expect(d.proofKeys.old).not.toBeNull();

    const url = buildActionUrl(edit.urlsrc, "http://cde:8080/wopi/files/abc", { lang: "tr-TR" });
    expect(url).toBe(
      "http://onlyoffice/hosting/wopi/word/edit?rs=tr-TR&ui=tr-TR&wopisrc=http%3A%2F%2Fcde%3A8080%2Fwopi%2Ffiles%2Fabc",
    );
  });

  it("parses Collabora discovery: app and MIME-type actions, WOPISrc appended", () => {
    const d = parseDiscovery(COLLABORA_XML);
    const edit = extensionsWith(d, "edit");
    expect(edit).toEqual(expect.arrayContaining(["docx", "doc", "odt", "xlsx", "csv", "pptx", "ppt", "odp", "rtf"]));
    expect(edit).not.toContain("sxw");
    expect(findAction(d, "sxw", "view")?.name).toBe("view");
    expect(findAction(d, "vsdx", "view")).toBeNull();
    // MIME-type apps map to extensions.
    expect(d.actions.some((a) => a.app.startsWith("application/vnd.oasis.opendocument.text") && a.ext === "odt")).toBe(true);
    const a = findAction(d, "docx", "edit")!;
    const url = buildActionUrl(a.urlsrc, "https://cde.example.com/wopi/files/f1", { extra: { lang: "tr", closebutton: "1" } });
    expect(url).toBe(
      "http://localhost:9980/browser/1a2b3c4/cool.html?WOPISrc=https%3A%2F%2Fcde.example.com%2Fwopi%2Ffiles%2Ff1&lang=tr&closebutton=1",
    );
    // The editor reports itself as localhost: the browser gets the public address.
    expect(toPublicUrl(url, "http://collabora:9980", "https://office.example.com")).toMatch(
      /^https:\/\/office\.example\.com\/browser\/1a2b3c4\/cool\.html\?WOPISrc=/,
    );
    expect(toPublicUrl("http://collabora:9980/browser/x/cool.html?", "http://collabora:9980", "https://o.example.com/")).toBe(
      "https://o.example.com/browser/x/cool.html?",
    );
    expect(toPublicUrl(url, "http://collabora:9980", null)).toBe(url);
  });

  it("reads real discoveries (ONLYOFFICE Docs 9.4.0, Collabora CODE 26.04.5.1, arm64)", () => {
    const oo = parseDiscovery(readFileSync(path.join(here, "../fixtures/discovery-onlyoffice-9.4-real.xml"), "utf8"), "external-http");
    const ooEdit = extensionsWith(oo, "edit");
    expect(ooEdit).toEqual(expect.arrayContaining(["docx", "xlsx", "pptx", "odt", "ods", "odp", "csv", "rtf", "txt"]));
    // Legacy binary formats only offer view and convert-and-edit (PUT_RELATIVE, not offered by the CDE).
    for (const ext of ["doc", "xls", "ppt"]) {
      expect(findAction(oo, ext, "edit")).toBeNull();
      expect(findAction(oo, ext, "view")).not.toBeNull();
    }
    expect(oo.proofKeys.current).not.toBeNull();
    expect(buildActionUrl(findAction(oo, "docx", "edit")!.urlsrc, "http://cde/wopi/files/x")).toBe(
      "http://127.0.0.1:8085/hosting/wopi/word/edit?rs=tr-TR&ui=tr-TR&wopisrc=http%3A%2F%2Fcde%2Fwopi%2Ffiles%2Fx",
    );

    const col = parseDiscovery(readFileSync(path.join(here, "../fixtures/discovery-collabora-26.04-real.xml"), "utf8"));
    expect(extensionsWith(col, "edit")).toEqual(expect.arrayContaining(["docx", "doc", "xlsx", "xls", "pptx", "ppt", "odt"]));
    // The collabora/code image ships no /etc/coolwsd/proof_key: discovery has no proof-key.
    expect(col.proofKey).toBeNull();
    expect(col.proofKeys).toEqual({ current: null, old: null });
  });

  it("rejects what is not discovery XML", () => {
    expect(() => parseDiscovery("<html>nginx</html>")).toThrow(/discovery/);
  });

  it("reads the same key from modulus/exponent and from the CSP blob", () => {
    const pk = parseDiscovery(COLLABORA_XML).proofKey!;
    const a = publicKeyFromModulus(pk.modulus!, pk.exponent!).export({ format: "jwk" });
    const b = publicKeyFromCspBlob(pk.value!).export({ format: "jwk" });
    expect(b).toEqual(a);
  });
});

// ---------------------------------------------------------------------------
// Proof keys and JWT
// ---------------------------------------------------------------------------

describe("WOPI proof keys", () => {
  const cur = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const old = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = (k: typeof cur) => k.publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const attrs = {
    modulus: Buffer.from(jwk(cur).n, "base64url").toString("base64"),
    exponent: Buffer.from(jwk(cur).e, "base64url").toString("base64"),
    oldmodulus: Buffer.from(jwk(old).n, "base64url").toString("base64"),
    oldexponent: Buffer.from(jwk(old).e, "base64url").toString("base64"),
  };
  const keys = proofKeysFrom(attrs);
  const pem = (k: typeof cur) => k.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const token = "tok-123";
  const url = "https://cde.example.com/wopi/files/f1?access_token=tok-123";

  it("converts .NET ticks", () => {
    const d = new Date("2026-10-10T12:00:00.000Z");
    expect(dateFromTicks(ticksFromDate(d)).toISOString()).toBe(d.toISOString());
    expect(ticksFromDate(new Date(0))).toBe(621355968000000000n);
  });

  it("accepts current, old-proof and old-key signatures; rejects others", () => {
    const ticks = ticksFromDate(new Date());
    const ts = ticks.toString();
    const good = signProof(pem(cur), token, url, ticks);
    expect(verifyProof(keys, { accessToken: token, urls: [url], timestamp: ts, proof: good, proofOld: undefined })).toEqual({ ok: true });
    // The URL is compared in upper case.
    expect(verifyProof(keys, { accessToken: token, urls: [url.toUpperCase()], timestamp: ts, proof: good, proofOld: undefined }).ok).toBe(true);
    // Rotated keys: X-WOPI-ProofOld with the current key, or X-WOPI-Proof with the old key.
    expect(verifyProof(keys, { accessToken: token, urls: [url], timestamp: ts, proof: "AAAA", proofOld: good }).ok).toBe(true);
    const byOld = signProof(pem(old), token, url, ticks);
    expect(verifyProof(keys, { accessToken: token, urls: [url], timestamp: ts, proof: byOld, proofOld: undefined }).ok).toBe(true);
    // Another token, another URL, a stranger's key.
    expect(verifyProof(keys, { accessToken: "other", urls: [url], timestamp: ts, proof: good, proofOld: undefined }).ok).toBe(false);
    expect(verifyProof(keys, { accessToken: token, urls: [`${url}x`], timestamp: ts, proof: good, proofOld: undefined }).ok).toBe(false);
    const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const bad = signProof(pem(stranger), token, url, ticks);
    expect(verifyProof(keys, { accessToken: token, urls: [url], timestamp: ts, proof: bad, proofOld: undefined })).toMatchObject({ ok: false });
    // Several candidate URLs: one match is enough.
    expect(verifyProof(keys, { accessToken: token, urls: ["http://other/x", url], timestamp: ts, proof: good, proofOld: undefined }).ok).toBe(true);
  });

  it("rejects missing headers and stale timestamps", () => {
    const old20 = ticksFromDate(new Date(Date.now() - 21 * 60 * 1000));
    const sig = signProof(pem(cur), token, url, old20);
    expect(verifyProof(keys, { accessToken: token, urls: [url], timestamp: old20.toString(), proof: sig, proofOld: undefined })).toEqual({
      ok: false,
      reason: expect.stringContaining("20 dakika"),
    });
    expect(verifyProof(keys, { accessToken: token, urls: [url], timestamp: undefined, proof: sig, proofOld: undefined }).ok).toBe(false);
    expect(verifyProof(keys, { accessToken: token, urls: [url], timestamp: "1", proof: undefined, proofOld: undefined }).ok).toBe(false);
  });
});

describe("log redaction", () => {
  it("hides WOPI access tokens and conversion tickets", () => {
    expect(redactUrl("/wopi/files/f1/contents?access_token=abc.DEF-1&access_token_ttl=0")).toBe("/wopi/files/f1/contents?access_token=***&access_token_ttl=0");
    expect(redactUrl("/wopi/files/f1?x=1&ACCESS_TOKEN=abc")).toBe("/wopi/files/f1?x=1&ACCESS_TOKEN=***");
    expect(redactUrl("/wopi/convert/TICKET123/input.docx")).toBe("/wopi/convert/***/input.docx");
    expect(redactUrl("/api/v1/projects")).toBe("/api/v1/projects");
  });
});

describe("JWT (HS256)", () => {
  it("signs and verifies", () => {
    const t = signJwt({ payload: { a: 1 } }, "gizli");
    expect(verifyJwt(t, "gizli")).toMatchObject({ payload: { a: 1 } });
    expect(verifyJwt(t, "baska")).toBeNull();
    expect(verifyJwt(`${t}x`, "gizli")).toBeNull();
    expect(verifyJwt(signJwt({}, "gizli", -10), "gizli")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Converters (mocked HTTP server)
// ---------------------------------------------------------------------------

const multipartFile = (body: Buffer) => {
  const s = body.toString("latin1");
  return { field: /name="([^"]+)"; filename="([^"]+)"/.exec(s), hasContent: s.includes("PK-fake-docx-content") };
};

describe("Gotenberg converter", () => {
  it("posts the file as multipart and returns the PDF; sends basic auth", async () => {
    mock.handler = (req, body, res) => {
      if (req.url === "/forms/libreoffice/convert" && req.method === "POST") {
        const f = multipartFile(body);
        expect(f.field?.[1]).toBe("files");
        expect(f.field?.[2]).toBe("input.docx");
        expect(f.hasContent).toBe(true);
        res.setHeader("Content-Type", "application/pdf");
        res.end(PDF);
        return;
      }
      res.statusCode = 404;
      res.end();
    };
    const c = new GotenbergConverter({ baseUrl: `${mock.base}/`, timeoutMs: 5000, basicAuth: "cde:parola" });
    const out = await c.toPdf(input, "Rapor.docx");
    expect(out.subarray(0, 5).toString()).toBe("%PDF-");
    expect(mock.requests[0]!.headers.authorization).toBe(`Basic ${Buffer.from("cde:parola").toString("base64")}`);
  });

  it("reports health", async () => {
    mock.handler = (req, _b, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(req.url === "/health" ? { status: "up", details: { libreoffice: { status: "up" } } } : {}));
    };
    expect(await new GotenbergConverter({ baseUrl: mock.base, timeoutMs: 5000 }).available()).toMatchObject({ ok: true });
  });

  it("times out", async () => {
    mock.handler = () => new Promise(() => undefined); // never answers
    const c = new GotenbergConverter({ baseUrl: mock.base, timeoutMs: 300, retries: 0 });
    const t = Date.now();
    await expect(c.toPdf(input, "Rapor.docx")).rejects.toBeInstanceOf(ConverterTimeoutError);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("retries 5xx answers, then fails with the status; 4xx is not retried", async () => {
    mock.handler = (_req, _b, res) => {
      res.statusCode = 503;
      res.end("LibreOffice meşgul");
    };
    const c = new GotenbergConverter({ baseUrl: mock.base, timeoutMs: 5000, retries: 2, retryDelayMs: 5 });
    const err = await c.toPdf(input, "Rapor.docx").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConverterHttpError);
    expect((err as ConverterHttpError).status).toBe(503);
    expect((err as Error).message).toContain("LibreOffice meşgul");
    expect(mock.requests).toHaveLength(3);

    mock.requests.length = 0;
    mock.handler = (_req, _b, res) => {
      res.statusCode = 400;
      res.end("bad");
    };
    await expect(c.toPdf(input, "Rapor.docx")).rejects.toMatchObject({ status: 400 });
    expect(mock.requests).toHaveLength(1);
  });

  it("recovers when a retry succeeds", async () => {
    let n = 0;
    mock.handler = (_req, _b, res) => {
      if (n++ === 0) {
        res.statusCode = 502;
        res.end();
      } else res.end(PDF);
    };
    const c = new GotenbergConverter({ baseUrl: mock.base, timeoutMs: 5000, retries: 1, retryDelayMs: 5 });
    expect((await c.toPdf(input, "Rapor.docx")).length).toBe(PDF.length);
  });

  it("rejects an answer that is not a PDF", async () => {
    mock.handler = (_req, _b, res) => res.end("<html>proxy</html>");
    await expect(new GotenbergConverter({ baseUrl: mock.base, timeoutMs: 5000 }).toPdf(input, "Rapor.docx")).rejects.toThrow(/PDF/);
  });

  it("is unavailable when nothing listens", async () => {
    const dead = await mockServer();
    await dead.close();
    const c = new GotenbergConverter({ baseUrl: dead.base, timeoutMs: 2000, retries: 1, retryDelayMs: 5 });
    await expect(c.toPdf(input, "Rapor.docx")).rejects.toBeInstanceOf(ConverterUnavailableError);
    expect((await c.available()).ok).toBe(false);
  });
});

describe("Collabora converter", () => {
  it("posts to /cool/convert-to/pdf, falls back to /lool on old servers", async () => {
    mock.handler = (req, body, res) => {
      if (req.url === "/lool/convert-to/pdf") {
        const f = multipartFile(body);
        expect(f.field?.[1]).toBe("data");
        expect(f.hasContent).toBe(true);
        res.end(PDF);
        return;
      }
      res.statusCode = 404;
      res.end();
    };
    const c = new CollaboraConverter({ baseUrl: mock.base, timeoutMs: 5000 });
    expect((await c.toPdf(input, "Rapor.docx")).subarray(0, 5).toString()).toBe("%PDF-");
    expect(mock.requests.map((r) => r.url)).toEqual(["/cool/convert-to/pdf", "/lool/convert-to/pdf"]);
  });

  it("reads capabilities", async () => {
    mock.handler = (req, _b, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ "convert-to": { available: req.url === "/hosting/capabilities" }, productVersion: "24.04" }));
    };
    expect(await new CollaboraConverter({ baseUrl: mock.base, timeoutMs: 5000 }).available()).toEqual({
      ok: true,
      message: "Collabora Online çalışıyor (24.04).",
    });
  });
});

describe("ONLYOFFICE converter", () => {
  const secret = "onlyoffice-jwt-gizli";
  const sources = new Map<string, string>();
  const publish = (p: string) => {
    const id = String(sources.size + 1);
    sources.set(id, p);
    return { url: `${mock.base}/src/${id}`, release: () => sources.delete(id) };
  };

  it("signs the request (body token and Authorization header), polls and downloads from the configured server only", async () => {
    let calls = 0;
    let downloaded = "";
    mock.handler = async (req, body, res) => {
      if (req.url?.startsWith("/src/")) {
        res.end(readFileSync(sources.get(req.url.slice(5))!));
        return;
      }
      if (req.url === "/converter" && req.method === "POST") {
        const json = JSON.parse(body.toString()) as Record<string, unknown>;
        const header = verifyJwt(String(req.headers.authorization).replace(/^Bearer /, ""), secret);
        expect(header?.payload).toMatchObject({ filetype: "docx", outputtype: "pdf", title: "Rapor.docx", async: false });
        expect(verifyJwt(String(json.token), secret)).toMatchObject({ filetype: "docx", url: json.url });
        // The document server downloads the source from the CDE.
        downloaded = await (await fetch(String(json.url))).text();
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            ++calls < 2
              ? { endConvert: false, percent: 40 }
              : // Its own host name in the result URL: the CDE still asks the configured server.
                { endConvert: true, percent: 100, fileUrl: "http://documentserver.internal/cache/files/data/k1/output.pdf/output.pdf?md5=x&expires=1" },
          ),
        );
        return;
      }
      if (req.url?.startsWith("/cache/files/data/k1/output.pdf/output.pdf?md5=x")) {
        res.end(PDF);
        return;
      }
      res.statusCode = 404;
      res.end();
    };
    const c = new OnlyofficeConverter({ baseUrl: mock.base, timeoutMs: 5000, jwtSecret: secret, publish, pollIntervalMs: 10 });
    const out = await c.toPdf(input, "Rapor.docx");
    expect(out.subarray(0, 5).toString()).toBe("%PDF-");
    expect(downloaded).toBe("PK-fake-docx-content");
    expect(calls).toBe(2);
    expect(sources.size).toBe(0); // released
    expect(mock.requests.some((r) => r.url.startsWith("/cache/files/"))).toBe(true);
  });

  it("explains ONLYOFFICE error codes and uses the legacy endpoint on 404", async () => {
    mock.handler = (req, _b, res) => {
      if (req.url === "/ConvertService.ashx") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: -8 }));
        return;
      }
      res.statusCode = 404;
      res.end();
    };
    const c = new OnlyofficeConverter({ baseUrl: mock.base, timeoutMs: 5000, jwtSecret: "yanlis", publish, retries: 0 });
    await expect(c.toPdf(input, "Rapor.docx")).rejects.toThrow(/JWT/);
    expect(mock.requests.map((r) => r.url)).toEqual(["/converter", "/ConvertService.ashx"]);
  });

  it("reads XML answers of older servers and the healthcheck", async () => {
    mock.handler = (req, _b, res) => {
      if (req.url === "/healthcheck") return void res.end("true");
      if (req.url === "/converter") {
        res.setHeader("Content-Type", "text/xml");
        return void res.end(`<?xml version="1.0"?><FileResult><FileUrl>${mock.base}/out.pdf?a=1&amp;b=2</FileUrl><Percent>100</Percent><EndConvert>True</EndConvert></FileResult>`);
      }
      if (req.url === "/out.pdf?a=1&b=2") return void res.end(PDF);
      res.statusCode = 404;
      res.end();
    };
    const c = new OnlyofficeConverter({ baseUrl: mock.base, timeoutMs: 5000, jwtSecret: null, publish });
    expect((await c.toPdf(input, "Rapor.docx")).length).toBe(PDF.length);
    expect(mock.requests[0]!.headers.authorization).toBeUndefined();
    expect(await c.available()).toEqual({ ok: true, message: "ONLYOFFICE Docs çalışıyor." });
  });

  it("times out while the conversion never ends", async () => {
    mock.handler = (_req, _b, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ endConvert: false, percent: 1 }));
    };
    const c = new OnlyofficeConverter({ baseUrl: mock.base, timeoutMs: 300, jwtSecret: null, publish, pollIntervalMs: 20, retries: 0 });
    await expect(c.toPdf(input, "Rapor.docx")).rejects.toBeInstanceOf(ConverterTimeoutError);
  });
});

// ---------------------------------------------------------------------------
// Converter selection (settings)
// ---------------------------------------------------------------------------

describe("converter selection", () => {
  let handle: DbHandle;
  const key = Buffer.alloc(32, 7);
  const okRunner: ProcessRunner = async (_cmd, args) => {
    writeFileSync(path.join(args[args.indexOf("--outdir") + 1]!, "input.pdf"), PDF);
    return { code: 0, stdout: "", stderr: "" };
  };
  const withSoffice = new Converters({ sofficePath: "soffice", dwg2dxfPath: null, runner: okRunner, timeoutMs: 1000 });
  const without = new Converters({ sofficePath: null, dwg2dxfPath: null });

  beforeAll(async () => {
    handle = await openDb("memory://");
  });
  afterAll(async () => {
    await handle.close();
  });

  const integration = (converters: Converters, env: NodeJS.ProcessEnv = {}) =>
    new OfficeIntegration({ db: handle.db, secretKey: key, converters, env, retryDelayMs: 1 });

  it("auto: local soffice as the last resort, else unavailable with a hint", async () => {
    await putSetting(handle.db, OFFICE_SETTINGS_KEY, null, null);
    const a = integration(withSoffice);
    expect((await a.converterFor(await a.config())).converter?.id).toBe("local");
    const out = path.join(tmp, "a.pdf");
    await a.officeToPdf(input, "docx", out);
    expect(readFileSync(out).subarray(0, 5).toString()).toBe("%PDF-");

    const b = integration(without);
    const r = await b.converterFor(await b.config());
    expect(r.converter).toBeNull();
    expect(r.reason).toContain("Gotenberg");
    await expect(b.officeToPdf(input, "docx", out)).rejects.toBeInstanceOf(ConverterUnavailableError);
    const st = await b.status();
    expect(st.converter).toMatchObject({ kind: null, available: false, auto: true });
    expect(st.editor.configured).toBe(false);
  });

  it("auto uses the editor server; explicit providers need an address; env gives defaults", async () => {
    await putSetting(handle.db, OFFICE_SETTINGS_KEY, { editor: { kind: "collabora", url: mock.base } }, null);
    const a = integration(withSoffice);
    expect((await a.converterFor(await a.config())).converter?.id).toBe("collabora");

    await putSetting(handle.db, OFFICE_SETTINGS_KEY, { converter: { kind: "gotenberg" } }, null);
    expect((await a.converterFor(await a.config())).reason).toContain("adresi girilmemiş");

    await putSetting(handle.db, OFFICE_SETTINGS_KEY, { converter: { kind: "onlyoffice", url: mock.base } }, null);
    expect((await a.converterFor(await a.config())).reason).toContain("CDE'nin editörden görünen adresi");

    await putSetting(handle.db, OFFICE_SETTINGS_KEY, { converter: { kind: "none" } }, null);
    expect((await a.converterFor(await a.config())).converter).toBeNull();

    await putSetting(handle.db, OFFICE_SETTINGS_KEY, null, null);
    const e = integration(withSoffice, {
      CDE_OFFICE_CONVERTER: "gotenberg",
      CDE_OFFICE_CONVERTER_URL: `${mock.base}/`,
      CDE_CONVERT_TIMEOUT_MS: "60000",
    });
    const cfg = await e.config();
    expect(cfg.converter).toMatchObject({ kind: "gotenberg", url: mock.base, timeoutSec: 60 });
    expect(cfg.fromEnv).toEqual(["CDE_OFFICE_CONVERTER", "CDE_OFFICE_CONVERTER_URL"]);
    expect((await e.converterFor(cfg)).converter?.id).toBe("gotenberg");
    // Saved settings win over the environment.
    await putSetting(handle.db, OFFICE_SETTINGS_KEY, { converter: { kind: "local" } }, null);
    expect((await e.converterFor(await e.config())).converter?.id).toBe("local");
  });

  it("refuses files over the size limit before sending anything", async () => {
    await putSetting(handle.db, OFFICE_SETTINGS_KEY, { converter: { kind: "gotenberg", url: mock.base, maxFileMb: 1 } }, null);
    const big = path.join(tmp, "big.docx");
    writeFileSync(big, Buffer.alloc(1024 * 1024 + 1));
    await expect(integration(without).officeToPdf(big, "docx", path.join(tmp, "b.pdf"))).rejects.toThrow(/sınırı 1 MB/);
    expect(mock.requests).toHaveLength(0);
  });

  it("runs at most `concurrency` conversions at once", async () => {
    await putSetting(handle.db, OFFICE_SETTINGS_KEY, { converter: { kind: "gotenberg", url: mock.base, concurrency: 1 } }, null);
    let running = 0;
    let peak = 0;
    mock.handler = async (_req, _b, res) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 50));
      running--;
      res.end(PDF);
    };
    const o = integration(without);
    await Promise.all([1, 2, 3].map((i) => o.officeToPdf(input, "docx", path.join(tmp, `c${i}.pdf`))));
    expect(peak).toBe(1);
    expect(mock.requests).toHaveLength(3);
    await putSetting(handle.db, OFFICE_SETTINGS_KEY, null, null);
  });
});
