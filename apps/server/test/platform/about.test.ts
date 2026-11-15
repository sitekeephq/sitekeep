import { describe, expect, it } from "vitest";
import { isReleaseVersion, sourceCodeUrl, SOURCE_REPOSITORY_URL } from "@sitekeep/shared";
import { appVersion, noticesPath, sourceInfo } from "../../src/app/about.js";

describe("version and source link (About page, AGPL-3.0 §13)", () => {
  it("links a release to its tag and any other build to the repository", () => {
    expect(SOURCE_REPOSITORY_URL).toBe("https://github.com/sitekeephq/sitekeep");
    expect(sourceInfo("1.0.0")).toEqual({ version: "1.0.0", sourceUrl: `${SOURCE_REPOSITORY_URL}/tree/v1.0.0` });
    expect(sourceInfo("v1.0.0-rc2")).toEqual({ version: "1.0.0-rc2", sourceUrl: `${SOURCE_REPOSITORY_URL}/tree/v1.0.0-rc2` });
    expect(sourceInfo(undefined)).toEqual({ version: null, sourceUrl: SOURCE_REPOSITORY_URL });
    expect(sourceInfo("  ")).toEqual({ version: null, sourceUrl: SOURCE_REPOSITORY_URL });
    // Development builds (git describe, a commit, a date) keep their label but link to the main page.
    expect(sourceInfo("v1.0.0-3-gabc1234-dirty")).toEqual({ version: "1.0.0-3-gabc1234-dirty", sourceUrl: SOURCE_REPOSITORY_URL });
    expect(sourceCodeUrl("abc1234")).toBe(SOURCE_REPOSITORY_URL);
    expect(sourceCodeUrl("20261115")).toBe(SOURCE_REPOSITORY_URL);
  });

  it("knows release versions", () => {
    expect(["1.0.0", "v2.10.3", "1.0.0-rc.1", "0.0.9-test"].filter(isReleaseVersion)).toHaveLength(4);
    expect(["", null, undefined, "1.0", "1.0.0-4-g1a2b3c4", "1.0.0-dirty", "main"].filter(isReleaseVersion)).toEqual([]);
    expect(appVersion("v1.2.3")).toBe("1.2.3");
  });

  it("finds THIRD_PARTY_NOTICES.md at the repository root in development", () => {
    expect(noticesPath()).toMatch(/THIRD_PARTY_NOTICES\.md$/);
    expect(noticesPath("/nonexistent/notices.md")).toBeNull();
  });
});
