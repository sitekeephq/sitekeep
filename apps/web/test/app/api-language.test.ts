import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "../../src/shared/api/client";
import { currentLanguage } from "../../src/i18n";

afterEach(() => vi.unstubAllGlobals());

describe("API requests carry the interface language", () => {
  it("sends X-SiteKeep-Language (wins over the profile on the server) and Accept-Language", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await get("/health");
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers["x-sitekeep-language"]).toBe(currentLanguage());
    expect(headers["accept-language"]).toBe(currentLanguage());
  });
});
