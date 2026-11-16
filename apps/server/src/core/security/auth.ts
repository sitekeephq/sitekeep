import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PROVISION_PASSWORD } from "@sitekeep/shared";
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

let dummyHash: Promise<string> | null = null;

/**
 * Checks a password against no account, taking as long as a real check: a sign-in for an unknown
 * address answers in the same time as one with a wrong password (no account enumeration, G-1).
 */
export async function verifyNoPassword(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(password, await dummyHash);
  return false;
}

/**
 * Prefixed random secret: s = session, api = API token, oauth / refresh / code = OAuth access token,
 * refresh token and authorization code, secret = OAuth client secret, invite = invitation link. The "7dcde_" prefix lets the
 * logs redact every kind (error-ring.ts).
 */
export function newToken(prefix: "s" | "api" | "oauth" | "refresh" | "code" | "secret" | "invite"): string {
  return `7dcde_${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const MIN_PASSWORD_LENGTH = 10;

/**
 * Common and breached passwords (G-5): the 50,000 most frequent passwords of at least 10 characters
 * in SecLists' xato-net-10-million-passwords-1000000.txt (MIT, see THIRD_PARTY_NOTICES.md), in lower
 * case, one per line. Bundled with the server, so no network is needed.
 */
const COMMON_PASSWORDS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/passwords/common-passwords.txt");

let commonPasswords: Set<string> | null = null;

function commonPasswordList(): Set<string> {
  if (!commonPasswords) {
    try {
      const lines = readFileSync(COMMON_PASSWORDS_FILE, "utf8").split("\n");
      commonPasswords = new Set(lines.map((l) => l.trim()).filter(Boolean));
    } catch {
      // A missing list must not stop people from setting passwords; the other rules still apply.
      commonPasswords = new Set();
    }
  }
  return commonPasswords;
}

/** On the bundled list of common passwords (case does not matter). */
export function isCommonPassword(password: string): boolean {
  return commonPasswordList().has(password.toLowerCase());
}

/** Parts of the person's e-mail address and name (4 characters or more) a password must not contain. */
function personalWords(context: PasswordContext): string[] {
  const words = new Set<string>();
  const email = context.email?.trim().toLowerCase();
  if (email) {
    const local = email.split("@")[0] ?? "";
    for (const w of [local, ...local.split(/[^\p{L}\p{N}]+/u)]) if (w.length >= 4) words.add(w);
  }
  for (const w of context.name?.trim().toLowerCase().split(/[^\p{L}\p{N}]+/u) ?? []) if (w.length >= 4) words.add(w);
  return [...words];
}

export interface PasswordContext {
  email?: string | null;
  name?: string | null;
}

/**
 * Why a new password is refused, or null (G-5): shorter than 10 characters, a common or breached
 * password, or one containing the person's name or e-mail address. The provisioning password is left
 * to the callers: an administrator may set it with "change at first sign-in", people may not choose it.
 */
export function passwordProblem(password: string, context: PasswordContext = {}): Msg | null {
  if (password.length < MIN_PASSWORD_LENGTH) return msg("errors:passwordTooShort");
  if (password === PROVISION_PASSWORD) return null;
  if (isCommonPassword(password)) return msg("errors:passwordCommon");
  const lower = password.toLowerCase();
  if (personalWords(context).some((w) => lower.includes(w))) return msg("errors:passwordPersonal");
  return null;
}
