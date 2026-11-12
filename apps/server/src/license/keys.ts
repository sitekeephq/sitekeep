/**
 * Public keys that verify licence files (docs/onprem/lisanslama.md §4.2), by `kid`. Ed25519, SPKI DER in
 * base64. The private keys never live in this repository: production licences are signed by the
 * signing service (release plan C-2). Rotation: add the new kid, keep the old one for a release.
 */
export const LICENSE_KEYS: Record<string, { spki: string; devOnly?: boolean }> = {
  // Development and tests only (NODE_ENV !== "production"); its private key is
  // test/fixtures/license/dev-private.pem.
  dev: { spki: "MCowBQYDK2VwAyEAPyzBzZrWPKJVVWYZ/XIZgd7nef0Ixo9UEd7Y5O6+hN0=", devOnly: true },
  // Production (12.11.2026). Private key: the issuer's ~/.sitekeep/license-signing-2026-11.pem and the company
  // vault; licences: tools/license/issue.mjs.
  "2026-11": { spki: "MCowBQYDK2VwAyEAdh72zJ5O7MqbKOrnNPOlcw6Bq/RB5Z07u7qgmBzHU+k=" },
};
