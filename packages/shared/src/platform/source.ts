/**
 * Where SiteKeep's source code is published. AGPL-3.0 §13: everyone who uses SiteKeep over a network is
 * offered the source of the version they use (About page, GET /api/v1/app-info). The one place for the
 * address: the server, the web app and tools/third-party-notices.mjs read it from here.
 */
export const SOURCE_REPOSITORY_URL = "https://github.com/sitekeephq/sitekeep";

/** The trademark policy (TRADEMARKS.md in the public repository). */
export const TRADEMARK_POLICY_URL = `${SOURCE_REPOSITORY_URL}/blob/main/TRADEMARKS.md`;

/**
 * A release version ("1.0.0", "v1.0.0-rc2"), as opposed to a development build's label (a git describe
 * such as "v1.0.0-3-gabc1234-dirty", a commit, a date). Releases are tagged v<version>.
 */
export function isReleaseVersion(version: string | null | undefined): version is string {
  if (!version) return false;
  const v = version.trim().replace(/^v/, "");
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+(-[0-9A-Za-z.]+)*)?$/.test(v) && !/-\d+-g[0-9a-f]{4,}/.test(v) && !/-dirty$/.test(v);
}

/** The source of this version: its release tag, or the repository's main page for any other build. */
export function sourceCodeUrl(version: string | null | undefined): string {
  return isReleaseVersion(version) ? `${SOURCE_REPOSITORY_URL}/tree/v${version.trim().replace(/^v/, "")}` : SOURCE_REPOSITORY_URL;
}
