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
  // The licensing service (22.11.2026, docs/onprem/licensing-online.md §6): signs online replies and the
  // licences in them. Private key: the sk-licensing Worker secret and the company vault.
  "worker-2026-12": { spki: "MCowBQYDK2VwAyEATiGb23fTfNyahE8zTNNfTe4RBGwM7ZiEGRvLtLgWX7o=" },
};
