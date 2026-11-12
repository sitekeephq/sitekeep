/**
 * The licence file (docs/onprem/lisanslama.md §4): `{ format, version, kid, payload, signature }`, the
 * payload base64url UTF-8 JSON signed with Ed25519 exactly as stored. Verification only; licences are
 * issued by 7Dimensions (Odoo → signing service), never here.
 */
import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { LICENSE_KEYS } from "./keys.js";

/** What a licence grants (lisanslama.md §4.1, adapted to SiteKeep editions: modules are Enterprise module ids). */
export const licensePayloadSchema = z.object({
  lid: z.string().min(1).max(64),
  customer: z.object({ id: z.string().max(100), name: z.string().min(1).max(200) }),
  /** The installation the licence belongs to (Yönetim → Lisans shows it); "*" for trials and our own installations. */
  installation: z.string().min(1).max(100),
  edition: z.enum(["enterprise", "trial"]),
  /** Active user accounts; null = unlimited. */
  seats: z.number().int().positive().nullable(),
  /** Enterprise modules the licence turns on (KNOWN_MODULES ids). */
  modules: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,30}$/)).max(50),
  issuedAt: z.iso.datetime(),
  validFrom: z.iso.datetime(),
  /** End of use; null = perpetual. */
  validUntil: z.iso.datetime().nullable(),
  /** Builds made after this date are not covered (lisanslama.md §5.4). */
  supportUntil: z.iso.datetime(),
  /** Full use after validUntil, then read-only. */
  graceDays: z.number().int().min(0).max(365).default(30),
  online: z.enum(["optional", "required", "off"]).default("optional"),
  hardware: z.array(z.string().max(100)).max(10).default([]),
  notes: z.string().max(2000).nullable().default(null),
});
export type LicensePayload = z.infer<typeof licensePayloadSchema>;

const fileSchema = z.object({
  format: z.literal("sitekeep-license"),
  version: z.literal(1),
  kid: z.string().min(1).max(40),
  payload: z.string().min(1).max(20_000),
  signature: z.string().min(1).max(200),
});

export type ParsedLicense = { ok: true; payload: LicensePayload; kid: string } | { ok: false; reason: "format" | "unknown_key" | "dev_key_in_production" | "signature" | "payload" };

/** Reads and verifies a licence file. `production` refuses the development key. */
export function parseLicense(text: string, opts: { production: boolean }): ParsedLicense {
  let file: z.infer<typeof fileSchema>;
  try {
    const parsed = fileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { ok: false, reason: "format" };
    file = parsed.data;
  } catch {
    return { ok: false, reason: "format" };
  }
  const key = LICENSE_KEYS[file.kid];
  if (!key) return { ok: false, reason: "unknown_key" };
  if (key.devOnly && opts.production) return { ok: false, reason: "dev_key_in_production" };
  const publicKey = createPublicKey({ key: Buffer.from(key.spki, "base64"), format: "der", type: "spki" });
  const data = Buffer.from(file.payload, "utf8");
  let good = false;
  try {
    good = verify(null, data, publicKey, Buffer.from(file.signature, "base64url"));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: "signature" };
  try {
    const payload = licensePayloadSchema.safeParse(JSON.parse(Buffer.from(file.payload, "base64url").toString("utf8")));
    if (!payload.success) return { ok: false, reason: "payload" };
    return { ok: true, payload: payload.data, kid: file.kid };
  } catch {
    return { ok: false, reason: "payload" };
  }
}
