// Writes a development licence (kid "dev") for local testing of Enterprise modules and licence states.
// Accepted only when NODE_ENV is not "production"; production licences come from the signing service.
//   node apps/server/scripts/license-dev.mjs --installation inst_… --modules cost,planning [--days 365] [--seats 50] > license.json
// Then Yönetim → Lisans (PUT /api/v1/admin/license), with SITEKEEP_LICENSE_ENFORCE=1 to see modules follow it.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const key = createPrivateKey(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures/license/dev-private.pem")));
const now = Date.now();
const days = Number(args.days ?? 365);
const payload = {
  lid: `LIC-DEV-${new Date(now).toISOString().slice(0, 10)}`,
  customer: { id: "dev", name: args.customer ?? "Geliştirme" },
  installation: args.installation ?? "*",
  edition: args.trial ? "trial" : "enterprise",
  seats: args.seats ? Number(args.seats) : null,
  modules: (args.modules ?? "field,coordinate,planning,cost,ai,manage,connect").split(",").map((s) => s.trim()).filter(Boolean),
  issuedAt: new Date(now).toISOString(),
  validFrom: new Date(now).toISOString(),
  validUntil: days > 0 ? new Date(now + days * 86_400_000).toISOString() : null,
  supportUntil: new Date(now + Math.max(days, 365) * 86_400_000).toISOString(),
  graceDays: Number(args.grace ?? 30),
  online: "off",
  hardware: [],
  notes: "development licence",
};
const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
const signature = sign(null, Buffer.from(encoded, "utf8"), key).toString("base64url");
process.stdout.write(JSON.stringify({ format: "sitekeep-license", version: 1, kid: "dev", payload: encoded, signature }, null, 2) + "\n");
