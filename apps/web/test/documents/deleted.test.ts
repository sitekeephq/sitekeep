import { describe, expect, it } from "vitest";
import { timeAgo } from "../../src/features/documents/pages/Deleted";

describe("timeAgo", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  it("speaks in minutes, hours and days, then falls back to the date", () => {
    expect(timeAgo("2026-10-17T11:59:30Z", now)).toBe("az önce");
    expect(timeAgo("2026-10-17T11:45:00Z", now)).toBe("15 dk önce");
    expect(timeAgo("2026-10-17T09:00:00Z", now)).toBe("3 saat önce");
    expect(timeAgo("2026-10-12T12:00:00Z", now)).toBe("5 gün önce");
    expect(timeAgo("2026-07-01T12:00:00Z", now)).not.toContain("önce");
  });
});
