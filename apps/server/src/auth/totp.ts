/**
 * TOTP (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), the authenticator-app URI, its QR code
 * (made here, no external service) and recovery codes (docs/features/SIGN_IN_SECURITY.md).
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import qrcode from "qrcode-generator";

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted either side of now (clock drift between the phone and the server). */
export const TOTP_DRIFT = 1;
export const RECOVERY_CODE_COUNT = 10;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = BASE32.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 20 random bytes (160 bits, as RFC 4226 recommends), base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD);
}

/** The code of a time step (RFC 4226 HOTP with the step as counter). */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * The time step a code belongs to (now ± drift), or null. Steps at or before `lastStep` are refused:
 * a code works once.
 */
export function verifyTotp(secret: string, code: string, lastStep: number | null, nowMs: number = Date.now()): number | null {
  const typed = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(typed)) return null;
  const now = totpStep(nowMs);
  let found: number | null = null;
  // Every candidate is compared (constant work whichever matches).
  for (let step = now - TOTP_DRIFT; step <= now + TOTP_DRIFT; step++) {
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(typed)) && found === null && (lastStep === null || step > lastStep)) found = step;
  }
  return found;
}

/** otpauth:// URI for authenticator apps (Google Authenticator, Microsoft Authenticator, 1Password…). */
export function otpauthUrl(secret: string, account: string, issuer = "SiteKeep"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD) });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/** The QR code of a text as an SVG data URL (drawn here: the secret never leaves the server). */
export function qrDataUrl(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const margin = 4;
  const size = n + margin * 2;
  let path = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + margin} ${r + margin}h1v1h-1z`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// ---- Recovery codes ------------------------------------------------------------------------------

const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** xxxx-xxxx-xxxx-xxxx from a 31-letter alphabet without look-alikes (about 79 bits). */
export function newRecoveryCode(): string {
  let out = "";
  for (let i = 0; i < 16; i++) {
    if (i && i % 4 === 0) out += "-";
    out += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  }
  return out;
}

export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(`recovery\u0000${normalizeRecoveryCode(code)}`).digest("hex");
}

export function newRecoveryCodes(): { plain: string[]; hashes: string[] } {
  const plain = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  return { plain, hashes: plain.map(hashRecoveryCode) };
}
