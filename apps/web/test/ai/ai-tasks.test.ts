import { describe, expect, it } from "vitest";
import { aiTaskButtonMode, waitingText } from "../../src/shared/ai/ai-tasks";

describe("Yapay Zekâya Gönder button", () => {
  it("shows only when the queue is on and allowed; primary without a model", () => {
    expect(aiTaskButtonMode(null)).toBe("hidden");
    expect(aiTaskButtonMode({ enabled: false, allowed: false, reason: "kapalı", providerAvailable: false })).toBe("hidden");
    expect(aiTaskButtonMode({ enabled: true, allowed: false, reason: "Tam yerel mod", providerAvailable: false })).toBe("hidden");
    expect(aiTaskButtonMode({ enabled: true, allowed: true, reason: null, providerAvailable: false })).toBe("primary");
    expect(aiTaskButtonMode({ enabled: true, allowed: true, reason: null, providerAvailable: true })).toBe("secondary");
  });

  it("names the client while it works", () => {
    expect(waitingText({ status: "pending", clientName: null })).toContain("bekleyen SiteKeep görevlerini yap");
    expect(waitingText({ status: "claimed", clientName: "Claude Code" })).toContain("Claude Code");
  });
});
