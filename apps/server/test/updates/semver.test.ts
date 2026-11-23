import { describe, expect, it } from "vitest";
import { compareSemver, isNewerRelease, parseSemver, releaseVersion } from "../../src/updates/semver.js";

const cmp = (a: string, b: string) => Math.sign(compareSemver(parseSemver(a)!, parseSemver(b)!));

describe("semver", () => {
  it("compares numbers, not text", () => {
    expect(cmp("1.0.10", "1.0.9")).toBe(1);
    expect(cmp("1.10.0", "1.9.9")).toBe(1);
    expect(cmp("2.0.0", "1.99.99")).toBe(1);
    expect(cmp("1.0.1", "1.0.1")).toBe(0);
    expect(cmp("1.0.0", "1.0.1")).toBe(-1);
  });

  it("puts a pre-release below its release and orders pre-releases (semver.org §11)", () => {
    expect(cmp("1.1.0-rc1", "1.1.0")).toBe(-1);
    expect(cmp("1.1.0-rc2", "1.1.0-rc1")).toBe(1);
    expect(cmp("1.1.0-rc.10", "1.1.0-rc.9")).toBe(1);
    expect(cmp("1.1.0-1", "1.1.0-alpha")).toBe(-1);
    expect(cmp("1.1.0-alpha", "1.1.0-alpha.1")).toBe(-1);
    expect(cmp("1.1.0+build5", "1.1.0")).toBe(0);
  });

  it("reads tags and refuses what is not a version", () => {
    expect(releaseVersion("v1.0.2")).toBe("1.0.2");
    expect(releaseVersion("1.0.2")).toBe("1.0.2");
    expect(releaseVersion("v1.1.0-rc1")).toBeNull();
    for (const bad of ["", "latest", "1.0", "v1", "1.0.x", "1.0.1-5-gabc1234", "1.0.1-5-gabc1234-dirty", null, undefined]) expect(parseSemver(bad as string)).toBeNull();
  });

  it("offers a newer release only to a release build", () => {
    expect(isNewerRelease("1.0.2", "1.0.1")).toBe(true);
    expect(isNewerRelease("1.0.10", "1.0.9")).toBe(true);
    expect(isNewerRelease("1.0.1", "1.0.1")).toBe(false);
    expect(isNewerRelease("1.0.0", "1.0.1")).toBe(false);
    expect(isNewerRelease("1.1.0", "1.1.0-rc1")).toBe(true); // a release candidate is told about its release
    expect(isNewerRelease("1.1.0-rc1", "1.0.1")).toBe(false); // pre-releases are never offered
    // Development builds (no version, or a git describe string) never claim an update.
    expect(isNewerRelease("9.9.9", null)).toBe(false);
    expect(isNewerRelease("9.9.9", "dev")).toBe(false);
    expect(isNewerRelease("9.9.9", "1.0.1-3-g1a2b3c4")).toBe(false);
    expect(isNewerRelease("garbage", "1.0.1")).toBe(false);
  });
});
