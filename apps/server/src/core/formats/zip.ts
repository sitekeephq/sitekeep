/** ZIP reader for office files (xlsx, docx, pptx): entries by name, inflated on demand. */
import { inflateRawSync } from "node:zlib";
import { defaultTranslate, type Translate } from "../../i18n/index.js";

const MAX_ENTRY_BYTES = 200 * 1024 * 1024;

export class XlsxError extends Error {}

/** ZIP entries by name (lazy inflate). ZIP64 archives are not supported. */
export function readZip(buf: Buffer, t: Translate = defaultTranslate()): Map<string, () => Buffer> {
  const out = new Map<string, () => Buffer>();
  let eocd = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 22 - 0xffff); p--) {
    if (buf.readUInt32LE(p) === 0x06054b50) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError(t("schedule:parse.notZip"));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError(t("schedule:parse.zipDirectoryCorrupt"));
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    out.set(name, () => {
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new XlsxError(t("schedule:parse.zipEntryCorrupt"));
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
      throw new XlsxError(t("schedule:parse.zipCompression", { method }));
    });
  }
  return out;
}
