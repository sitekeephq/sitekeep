/** Runs the pdf.js text-layer worker (pdf-worker.ts) in a worker thread. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { HttpError } from "../core/platform/http.js";
import { DEFAULT_LANGUAGE, msg, render, type Msg } from "../i18n/index.js";
import type { WorkerOutput } from "./pdf-worker.js";

export type { WorkerItem, WorkerOutput, WorkerPage } from "./pdf-worker.js";

function workerPath(): string {
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), `pdf-worker${path.extname(here)}`);
}

/**
 * A PDF that cannot be read. `message` is in the installation's default language (logs, stored
 * job errors); `msg` lets a route show it in the reader's language.
 */
export class PdfReadError extends Error {
  constructor(readonly msg: Msg) {
    super(render(DEFAULT_LANGUAGE, msg));
  }
}

/** The message of an error in a language (PdfReadError and HttpError translated, others as they are). */
export function pdfErrorText(err: unknown, lang: string = DEFAULT_LANGUAGE): string {
  if (err instanceof PdfReadError) return render(lang, err.msg);
  if (err instanceof HttpError && err.msg) return render(lang, err.msg);
  return err instanceof Error ? err.message : String(err);
}

export interface ExtractOptions {
  /** Pages read from the start (default 1: title blocks). */
  maxPages?: number;
  timeoutMs?: number;
}

/** Text items with positions for the first `maxPages` pages of a PDF. */
export function extractPdfText(input: { filePath: string } | { data: Uint8Array }, opts: ExtractOptions = {}): Promise<WorkerOutput> {
  return new Promise((resolve, reject) => {
    const data = "data" in input ? input.data : undefined;
    const worker = new Worker(workerPath(), {
      workerData: { filePath: "filePath" in input ? input.filePath : undefined, data, maxPages: opts.maxPages ?? 1 },
      resourceLimits: { maxOldGenerationSizeMb: 2048 },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => reject(new PdfReadError(msg("docintel:errors.pdfTimeout")))), opts.timeoutMs ?? 120_000);
    worker.on("message", (m: { type: string; out?: WorkerOutput; message?: string; code?: "password" | "invalid" }) => {
      if (m.type === "done") finish(() => resolve(m.out!));
      else if (m.type === "error")
        finish(() =>
          reject(
            m.code === "password"
              ? new PdfReadError(msg("docintel:errors.pdfPassword"))
              : m.code === "invalid"
                ? new PdfReadError(msg("docintel:errors.pdfInvalid"))
                : new Error(m.message),
          ),
        );
    });
    worker.on("error", (err) => finish(() => reject(err)));
    worker.on("exit", (code) => finish(() => reject(new PdfReadError(msg("docintel:errors.pdfWorkerExit", { code })))));
  });
}
