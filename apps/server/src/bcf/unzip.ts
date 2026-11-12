/**
 * Reads an untrusted .bcfzip into memory with hard limits (nothing is written to disk):
 * - zip-slip: absolute paths, drive letters, "..", backslashes, NUL and symlink entries are refused;
 * - zip bomb: entry count, per-entry and total uncompressed bytes and the compression ratio are
 *   checked against the headers and again while inflating (headers can lie);
 * - only BCF parts are inflated (bcf.version, project.bcfp, extensions.xml, markup.bcf, *.bcfv,
 *   PNG / JPEG snapshots); other entries are listed and skipped.
 */
import yauzl from "yauzl";
import { DEFAULT_LANGUAGE, msg, render, type Msg } from "../i18n/index.js";

export const BCF_ZIP_LIMITS = {
  /** Compressed .bcfzip. */
  zipBytes: 100 * 1024 * 1024,
  entries: 5000,
  /** One inflated entry. */
  entryBytes: 20 * 1024 * 1024,
  /** All inflated entries. */
  totalBytes: 300 * 1024 * 1024,
  /** Inflated / compressed, for entries above 1 MB. */
  ratio: 200,
};

export class BcfZipError extends Error {
  /** The text for the reader (rendered in the request's language); `message` is the installation's language. */
  constructor(readonly msg: Msg) {
    super(render(DEFAULT_LANGUAGE, msg));
  }
}

const WANTED = /(^|\/)(bcf\.version|project\.bcfp|extensions\.xml|markup\.bcf)$|\.(bcfv|png|jpe?g)$/i;

/** True when an entry name could escape a target folder or is otherwise unsafe. */
export function unsafeEntryName(name: string): boolean {
  if (!name || name.length > 512) return true;
  if (name.includes("\0") || name.includes("\\")) return true;
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return true;
  return name.split("/").some((seg) => seg === "..");
}

export interface UnzippedBcf {
  /** Entry name → bytes (only the BCF parts). */
  files: Map<string, Buffer>;
  /** Names of entries that were not read (IFC files, PDFs, …). */
  skipped: string[];
}

export function readBcfZip(buf: Buffer, limits = BCF_ZIP_LIMITS): Promise<UnzippedBcf> {
  if (buf.length > limits.zipBytes) return Promise.reject(new BcfZipError(msg("bcf:zip.tooLarge", { mb: Math.round(limits.zipBytes / 1048576) })));
  return new Promise((resolve, reject) => {
    // strictFileNames: backslashes are an error, not silently turned into "/".
    yauzl.fromBuffer(buf, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true, strictFileNames: true }, (err, zip) => {
      if (err || !zip) return reject(new BcfZipError(msg("bcf:zip.notZip", { detail: err?.message ?? msg("bcf:zip.unreadable") })));
      const files = new Map<string, Buffer>();
      const skipped: string[] = [];
      let count = 0;
      let total = 0;
      let done = false;
      const fail = (e: Error) => {
        if (done) return;
        done = true;
        zip.close();
        // yauzl's own file name checks (absolute / "../" paths, backslashes) are zip-slip attempts too.
        if (!(e instanceof BcfZipError) && /relative path|absolute path|invalid characters/i.test(e.message)) {
          return reject(new BcfZipError(msg("bcf:zip.unsafePathDetail", { detail: e.message })));
        }
        reject(e instanceof BcfZipError ? e : new BcfZipError(msg("bcf:zip.readFailed", { detail: e.message })));
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (done) return;
        done = true;
        resolve({ files, skipped });
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        if (done) return;
        const name = entry.fileName;
        if (++count > limits.entries) return fail(new BcfZipError(msg("bcf:zip.tooManyEntries", { max: limits.entries })));
        if (unsafeEntryName(name)) return fail(new BcfZipError(msg("bcf:zip.unsafePath", { name: name.slice(0, 120) })));
        // Unix mode in the high 16 bits of the external attributes: 0o120000 = symlink.
        if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) return fail(new BcfZipError(msg("bcf:zip.symlink", { name })));
        if (name.endsWith("/")) return zip.readEntry();
        if (!WANTED.test(name)) {
          skipped.push(name);
          return zip.readEntry();
        }
        const size = entry.uncompressedSize;
        if (size > limits.entryBytes) return fail(new BcfZipError(msg("bcf:zip.entryTooLarge", { name })));
        if (size > 1024 * 1024 && size / Math.max(1, entry.compressedSize) > limits.ratio) return fail(new BcfZipError(msg("bcf:zip.suspiciousRatio", { name })));
        if (total + size > limits.totalBytes) return fail(new BcfZipError(msg("bcf:zip.totalTooLarge")));
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return fail(e ?? new BcfZipError(msg("bcf:zip.readFailed", { detail: msg("bcf:zip.streamFailed") })));
          const chunks: Buffer[] = [];
          let n = 0;
          stream.on("data", (c: Buffer) => {
            n += c.length;
            total += c.length;
            if (n > limits.entryBytes || total > limits.totalBytes) {
              stream.destroy();
              fail(new BcfZipError(msg("bcf:zip.limitExceeded", { name })));
              return;
            }
            chunks.push(c);
          });
          stream.on("error", fail);
          stream.on("end", () => {
            if (done) return;
            files.set(name, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}
