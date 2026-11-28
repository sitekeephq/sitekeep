import { describe, expect, it } from "vitest";
import { JOB_RETRY_BACKOFF_MS, MAX_JOB_ATTEMPTS, classifyJobError, formatJobError, retryDecision } from "../../src/jobs/errors.js";

const texts = { ifcReader: "The model could not be read (IFC reader error).", unknown: "Unknown." };

function wasmException(): unknown {
  const W = WebAssembly as unknown as { Tag: new (d: object) => object; Exception: new (tag: object, payload: unknown[]) => unknown };
  return new W.Exception(new W.Tag({ parameters: [] }), []);
}

describe("formatJobError", () => {
  it("replaces a WebAssembly.Exception (not an Error, String() = [object WebAssembly.Exception]) with a readable message and keeps the detail", () => {
    const err = wasmException();
    expect(String(err)).toContain("WebAssembly.Exception");
    const f = formatJobError(err, texts);
    expect(f.message).toBe(texts.ifcReader);
    expect(f.message).not.toContain("[object");
    expect(f.detail).toContain("WebAssembly.Exception");
  });

  it("recognises a RuntimeError, also as text from the worker thread", () => {
    expect(formatJobError(new WebAssembly.RuntimeError("memory access out of bounds"), texts).message).toBe(texts.ifcReader);
    expect(formatJobError(new Error("RuntimeError: unreachable"), texts).message).toBe(texts.ifcReader);
    expect(formatJobError(new Error("[object WebAssembly.Exception]"), texts).message).toBe(texts.ifcReader);
    expect(formatJobError("Aborted(OOM)", texts).message).toBe(texts.ifcReader);
  });

  it("keeps readable messages as they are", () => {
    const revit = "No 3D elements were found in the Revit file.";
    expect(formatJobError(new Error(revit), texts)).toEqual({ message: revit, detail: revit });
    expect(formatJobError("plain failure", texts).message).toBe("plain failure");
  });

  it("gives non-Error throws without a text a neutral message", () => {
    expect(formatJobError(undefined, texts).message).toBe(texts.unknown);
    expect(formatJobError({}, texts).message).toBe(texts.unknown);
    expect(formatJobError(new Error(""), texts).message).toBe(texts.unknown);
  });
});

describe("classifyJobError", () => {
  const withStatus = (status: number) => Object.assign(new Error("Autodesk request failed"), { status });
  const withCode = (code: string) => Object.assign(new Error("connect"), { code });
  const table: [string, unknown, "transient" | "permanent"][] = [
    ["fetch failed", new TypeError("fetch failed"), "transient"],
    ["fetch failed with cause", new TypeError("fetch failed", { cause: withCode("ECONNRESET") }), "transient"],
    ["ECONNRESET", withCode("ECONNRESET"), "transient"],
    ["ETIMEDOUT", new Error("connect ETIMEDOUT 1.2.3.4:443"), "transient"],
    ["ENOTFOUND", new Error("getaddrinfo ENOTFOUND developer.api.autodesk.com"), "transient"],
    ["EAI_AGAIN", new Error("getaddrinfo EAI_AGAIN host"), "transient"],
    ["socket hang up", new Error("socket hang up"), "transient"],
    ["status 429", withStatus(429), "transient"],
    ["status 502", withStatus(502), "transient"],
    ["status 503", withStatus(503), "transient"],
    ["status 504", withStatus(504), "transient"],
    ["text HTTP 503", new Error("Autodesk returned HTTP 503"), "transient"],
    ["text Bad Gateway", new Error("502 Bad Gateway"), "transient"],
    ["status 400", withStatus(400), "permanent"],
    ["status 401", withStatus(401), "permanent"],
    ["status 404", withStatus(404), "permanent"],
    ["status 500", withStatus(500), "permanent"],
    ["a number in a message", new Error("Line 503 of the file is invalid"), "permanent"],
    ["IFC reader", wasmException(), "permanent"],
    ["corrupt file", new Error("Invalid IFC file: unexpected end"), "permanent"],
    ["unsupported format", new Error("No module converts .xyz files"), "permanent"],
    ["validation", new Error("Version not found"), "permanent"],
    ["disk full", Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }), "permanent"],
    ["disk full over a network word", new Error("fetch failed: no space left on device"), "permanent"],
    ["own conversion timeout", new Error("The IFC conversion timed out."), "permanent"],
    ["string throw", "boom", "permanent"],
    ["undefined", undefined, "permanent"],
  ];
  it.each(table)("%s", (_name, err, expected) => expect(classifyJobError(err)).toBe(expected));
});

describe("retryDecision", () => {
  const net = new TypeError("fetch failed");
  it("retries transient errors of repeatable kinds with the configured backoff, at most 3 runs", () => {
    expect(MAX_JOB_ATTEMPTS).toBe(3);
    expect(retryDecision("autodesk_sync", 1, net)).toEqual({ retry: true, delayMs: JOB_RETRY_BACKOFF_MS[0] });
    expect(retryDecision("autodesk_sync", 2, net)).toEqual({ retry: true, delayMs: JOB_RETRY_BACKOFF_MS[1] });
    expect(retryDecision("autodesk_sync", 3, net)).toEqual({ retry: false });
  });
  it("never retries a permanent error or a kind that is not repeatable", () => {
    expect(retryDecision("ifc_to_frag", 1, wasmException())).toEqual({ retry: false });
    expect(retryDecision("project_import", 1, net)).toEqual({ retry: false });
    expect(retryDecision("autodesk_file_import", 1, net)).toEqual({ retry: false });
  });
});
