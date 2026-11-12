/**
 * Snapshot images from untrusted .bcfzip files: the type comes from the bytes (not the file name),
 * the structure is checked and the image is rebuilt from its essential parts only:
 * - PNG: IHDR, PLTE, tRNS, IDAT, IEND with valid CRCs; the image data must inflate to the size the
 *   header promises (bounded); text / metadata chunks and trailing bytes are dropped;
 * - JPEG: markers walked up to EOI; APP1–APP13, APP15 (Exif, XMP, ICC…) and comments are dropped.
 */
import { crc32, inflateSync } from "node:zlib";
import { DEFAULT_LANGUAGE, msg, render, type Msg } from "../i18n/index.js";

export const SNAPSHOT_LIMITS = { bytes: 5 * 1024 * 1024, side: 8000, rawBytes: 96 * 1024 * 1024 };

export interface CleanImage {
  type: "png" | "jpg";
  mime: "image/png" | "image/jpeg";
  data: Buffer;
  width: number;
  height: number;
}

export class ImageError extends Error {
  /** The text for the reader (rendered in the request's language); `message` is the installation's language. */
  constructor(readonly msg: Msg) {
    super(render(DEFAULT_LANGUAGE, msg));
  }
}

export function sanitizeSnapshot(buf: Buffer): CleanImage {
  if (buf.length > SNAPSHOT_LIMITS.bytes) throw new ImageError(msg("bcf:image.tooLarge"));
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return cleanPng(buf);
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return cleanJpeg(buf);
  throw new ImageError(msg("bcf:image.notPngJpeg"));
}

export function toDataUrl(img: CleanImage): string {
  return `data:${img.mime};base64,${img.data.toString("base64")}`;
}

const KEEP_PNG = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

function cleanPng(buf: Buffer): CleanImage {
  const out: Buffer[] = [buf.subarray(0, 8)];
  const idat: Buffer[] = [];
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitsPerPixel = 0;
  let interlaced = false;
  let first = true;
  let ended = false;
  while (pos + 12 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || length > buf.length - pos - 12) throw new ImageError(msg("bcf:image.badPngChunk"));
    const body = buf.subarray(pos + 8, pos + 8 + length);
    const crc = buf.readUInt32BE(pos + 8 + length);
    if (crc32(buf.subarray(pos + 4, pos + 8 + length)) !== crc) throw new ImageError(msg("bcf:image.badCrc", { type }));
    if (first) {
      if (type !== "IHDR" || length !== 13) throw new ImageError(msg("bcf:image.noIhdr"));
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8]!;
      const color = body[9]!;
      if (!DEPTHS[color]?.includes(depth) || body[10] !== 0 || body[11] !== 0 || body[12]! > 1) throw new ImageError(msg("bcf:image.badPngHeader"));
      bitsPerPixel = depth * CHANNELS[color]!;
      interlaced = body[12] === 1;
      first = false;
    }
    if (KEEP_PNG.has(type)) out.push(buf.subarray(pos, pos + 12 + length));
    if (type === "IDAT") idat.push(body);
    pos += 12 + length;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (first || !ended || !idat.length) throw new ImageError(msg("bcf:image.incompletePng"));
  checkSize(width, height);
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const expected = height * (1 + rowBytes);
  // Adam7 rows are shorter but more numerous: at most 7 extra filter bytes per row pass.
  const limit = interlaced ? expected + 7 * height + 7 : expected;
  if (limit > SNAPSHOT_LIMITS.rawBytes) throw new ImageError(msg("bcf:image.tooLarge"));
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: limit + 1 });
  } catch {
    throw new ImageError(msg("bcf:image.pngInflate"));
  }
  if (interlaced ? raw.length > limit || raw.length < rowBytes : raw.length !== expected) throw new ImageError(msg("bcf:image.pngDataShort"));
  return { type: "png", mime: "image/png", data: Buffer.concat(out), width, height };
}

/** Markers kept from a JPEG: APP0 (JFIF), APP14 (Adobe colour transform) and everything that is not an APPn / COM. */
function keepJpegMarker(m: number): boolean {
  if (m === 0xe0 || m === 0xee) return true;
  if (m >= 0xe0 && m <= 0xef) return false;
  return m !== 0xfe;
}

function cleanJpeg(buf: Buffer): CleanImage {
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let pos = 2;
  let width = 0;
  let height = 0;
  let scans = 0;
  for (;;) {
    // Fill bytes before a marker.
    while (pos < buf.length && buf[pos] === 0xff && buf[pos + 1] === 0xff) pos++;
    if (pos + 2 > buf.length || buf[pos] !== 0xff) throw new ImageError(msg("bcf:image.badJpegMarker"));
    const marker = buf[pos + 1]!;
    if (marker === 0xd9) {
      out.push(Buffer.from([0xff, 0xd9]));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xd8) throw new ImageError(msg("bcf:image.unexpectedJpegMarker"));
    if (pos + 4 > buf.length) throw new ImageError(msg("bcf:image.incompleteJpeg"));
    const length = buf.readUInt16BE(pos + 2);
    if (length < 2 || pos + 2 + length > buf.length) throw new ImageError(msg("bcf:image.badJpegSegment"));
    const segment = buf.subarray(pos, pos + 2 + length);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (length < 8) throw new ImageError(msg("bcf:image.badJpegHeader"));
      height = buf.readUInt16BE(pos + 5);
      width = buf.readUInt16BE(pos + 7);
    }
    if (keepJpegMarker(marker)) out.push(segment);
    pos += 2 + length;
    if (marker === 0xda) {
      scans++;
      // Entropy-coded data runs to the next marker that is not a stuffed 0x00 or a restart marker.
      const start = pos;
      while (pos + 1 < buf.length) {
        if (buf[pos] === 0xff) {
          const next = buf[pos + 1]!;
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break;
        }
        pos++;
      }
      if (pos + 1 >= buf.length) throw new ImageError(msg("bcf:image.noJpegEoi"));
      out.push(buf.subarray(start, pos));
    }
  }
  if (!scans) throw new ImageError(msg("bcf:image.noJpegData"));
  checkSize(width, height);
  return { type: "jpg", mime: "image/jpeg", data: Buffer.concat(out), width, height };
}

function checkSize(w: number, h: number) {
  if (!w || !h) throw new ImageError(msg("bcf:image.noSize"));
  if (w > SNAPSHOT_LIMITS.side || h > SNAPSHOT_LIMITS.side) throw new ImageError(msg("bcf:image.sizeTooLarge"));
}

/** Snapshot data URL (as stored in viewpoints) → bytes and BCF type; null when it is not PNG / JPEG. */
export function fromDataUrl(url: string | undefined | null): { type: "png" | "jpg"; data: Buffer } | null {
  const m = /^data:image\/(png|jpeg);base64,(.*)$/s.exec(url ?? "");
  if (!m) return null;
  return { type: m[1] === "png" ? "png" : "jpg", data: Buffer.from(m[2]!, "base64") };
}
