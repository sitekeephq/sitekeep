/**
 * Version numbers for the update notice (docs/features/PRIVACY.md → Update Check): semantic versioning,
 * compared numerically (1.0.10 is newer than 1.0.9), pre-releases (1.1.0-rc1) below their release.
 */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers ("rc", 1); empty for a release. */
  pre: (string | number)[];
}

const SEMVER = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;
/** `git describe` output (1.0.1-5-gabc1234, with an optional -dirty): a build between releases, not a release. */
const GIT_DESCRIBE = /-\d+-g[0-9a-f]{4,}(?:-dirty)?$/;

/** Reads a version; null when it is not semantic versioning (or a git describe string). */
export function parseSemver(input: string | null | undefined): Semver | null {
  const text = input?.trim();
  if (!text || GIT_DESCRIBE.test(text)) return null;
  const m = SEMVER.exec(text);
  if (!m) return null;
  const pre = m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

/** Negative when a < b, 0 when equal, positive when a > b (semver.org §11). */
export function compareSemver(a: Semver, b: Semver): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] - b[k];
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length; // a release is above its pre-release
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "number") return -1; // numeric identifiers are below alphanumeric ones
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** The plain "x.y.z" of a release tag ("v1.0.2" → "1.0.2"); null for a pre-release or anything else. */
export function releaseVersion(tag: string | null | undefined): string | null {
  const v = parseSemver(tag);
  return v && !v.pre.length ? `${v.major}.${v.minor}.${v.patch}` : null;
}

/**
 * Whether `latest` is a release newer than the running `current`. A build without a release version
 * (development, git describe) never claims an update.
 */
export function isNewerRelease(latest: string | null | undefined, current: string | null | undefined): boolean {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  return !!l && !!c && !l.pre.length && compareSemver(l, c) > 0;
}
