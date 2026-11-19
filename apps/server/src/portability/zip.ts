/**
 * A ZIP written straight into the storage (never whole in memory) whose entries are hashed as they
 * are written: the checksum list of the project export (SHA256SUMS, manifest.json `checksums`).
 * Entries are produced lazily, in the order they were added, when yazl reaches them; so an entry
 * added last (the manifest) can list the checksums of everything before it.
 */
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { ZipFile } from "yazl";
import type { Storage, StoredObject } from "../core/platform/storage.js";

/** Already compressed formats are stored as they are (as the bulk download and the close-out archive do). */
export const STORED_EXTENSIONS = new Set(["zip", "ifczip", "7z", "rar", "gz", "png", "jpg", "jpeg", "mp4", "docx", "xlsx", "pptx", "rvz", "frag", "bcfzip"]);

export interface EntrySum {
  path: string;
  size: number;
  sha256: string;
}

export class HashedZip {
  private readonly zip = new ZipFile();
  private readonly out: Readable;
  private readonly stored: Promise<StoredObject>;
  /** Checksums of the entries written so far, in the order they were written. */
  readonly sums: EntrySum[] = [];

  constructor(storage: Storage, prefix: string) {
    this.out = this.zip.outputStream as Readable;
    this.stored = storage.put(this.out, prefix);
    // Observed in end(); keeps the promise from rejecting unobserved while entries are produced.
    this.stored.catch(() => undefined);
    this.zip.on("error", (err: Error) => this.out.destroy(err));
  }

  /**
   * Adds an entry whose bytes come from `open()` when yazl reaches it. `onDone` gets the SHA-256 and
   * size of the bytes written. A read error ends the whole ZIP with that error.
   */
  addStream(
    path: string,
    open: () => Readable | Promise<Readable>,
    opts: { mtime: Date; compress?: boolean; size?: number },
    onDone?: (sum: EntrySum) => void,
  ): void {
    this.zip.addReadStreamLazy(path, { mtime: opts.mtime, compress: opts.compress ?? true, ...(opts.size !== undefined && { size: opts.size }) }, (cb) => {
      Promise.resolve()
        .then(open)
        .then(
          (source) => {
            const hash = createHash("sha256");
            let size = 0;
            const sums = this.sums;
            const meter = new Transform({
              transform(chunk: Buffer | string, _enc, done) {
                const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
                hash.update(buf);
                size += buf.length;
                done(null, buf);
              },
              flush(done) {
                const sum = { path, size, sha256: hash.digest("hex") };
                sums.push(sum);
                onDone?.(sum);
                done();
              },
            });
            // yazl does not listen for read errors; unhandled, one would take the whole server down.
            source.on("error", (err) => this.out.destroy(err));
            cb(null, source.pipe(meter));
          },
          (err: unknown) => this.out.destroy(err instanceof Error ? err : new Error(String(err))),
        );
    });
  }

  /** Adds text or bytes made when yazl reaches the entry (after every entry added before it). */
  addLazy(path: string, make: () => string | Buffer | Promise<string | Buffer>, mtime: Date, compress = true): void {
    this.addStream(
      path,
      async () => {
        const data = await make();
        return Readable.from([typeof data === "string" ? Buffer.from(data, "utf8") : data], { objectMode: false });
      },
      { mtime, compress },
    );
  }

  /** Adds text produced piece by piece (large JSON and CSV parts). */
  addLines(path: string, lines: () => AsyncIterable<string>, mtime: Date): void {
    this.addStream(
      path,
      () =>
        Readable.from(
          (async function* () {
            for await (const l of lines()) yield Buffer.from(l, "utf8");
          })(),
          { objectMode: false },
        ),
      { mtime },
    );
  }

  /** Finishes the ZIP and waits until it is in the storage. */
  async end(): Promise<StoredObject> {
    this.zip.end();
    return this.stored;
  }

  /** Stops writing (an error elsewhere); the partial file is removed by the storage. */
  abort(err: Error): void {
    this.out.destroy(err);
  }
}

/** `sha256sum -c` format: "<hash>  <path>\n" per entry, sorted by path. */
export function sha256sums(sums: readonly EntrySum[]): string {
  return [...sums]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((s) => `${s.sha256}  ${s.path}\n`)
    .join("");
}

/** Parses SHA256SUMS; null when a line is not "<64 hex>  <path>". */
export function parseSha256sums(text: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/i.exec(raw);
    if (!m) return null;
    out.set(m[2]!, m[1]!.toLowerCase());
  }
  return out;
}
