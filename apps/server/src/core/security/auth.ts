import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { msg, type Msg } from "../../i18n/index.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/** scrypt$<salt hex>$<hash hex> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltHex, hashHex] = stored.split("$");
  if (algo !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

/**
 * Prefixed random secret: s = session, api = API token, oauth / refresh / code = OAuth access token,
 * refresh token and authorization code, secret = OAuth client secret. The "7dcde_" prefix lets the
 * logs redact every kind (error-ring.ts).
 */
export function newToken(prefix: "s" | "api" | "oauth" | "refresh" | "code" | "secret"): string {
  return `7dcde_${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function passwordProblem(password: string): Msg | null {
  if (password.length < 10) return msg("errors:passwordTooShort");
  return null;
}
