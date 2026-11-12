import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Secrets at rest (AI provider API keys) are encrypted with AES-256-GCM.
 * Key source, in order:
 *   1. CDE_SECRET_KEY — 32 bytes as 64 hex characters or base64
 *   2. DATA_DIR/secret.key — generated once on first start (back it up together with the database)
 */
export function parseSecretKey(value: string): Buffer {
  const v = value.trim();
  const key = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (key.length !== 32) throw new Error("CDE_SECRET_KEY must be 32 bytes (64 hex characters or base64).");
  return key;
}

export function loadSecretKey(dataDir: string, envValue = process.env.CDE_SECRET_KEY): Buffer {
  if (envValue) return parseSecretKey(envValue);
  const file = path.join(dataDir, "secret.key");
  if (existsSync(file)) return parseSecretKey(readFileSync(file, "utf8"));
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  return key;
}

const PREFIX = "aesgcm1";

/** aesgcm1:<iv b64>:<tag b64>:<ciphertext b64> */
export function encryptSecret(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(key: Buffer, stored: string): string {
  const [prefix, iv, tag, ct] = stored.split(":");
  if (prefix !== PREFIX || !iv || !tag || ct === undefined) throw new Error("Unrecognised encrypted value format.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}
