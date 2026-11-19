/** #139: the cancel button of an RFI says "Cancel RFI", not "Cancel Letter". */
import { describe, expect, it } from "vitest";
import en from "../../src/i18n/locales/en/works.json" with { type: "json" };
import tr from "../../src/i18n/locales/tr/works.json" with { type: "json" };
import { cancelLabelKey } from "../../src/features/works/components/WorksBuild";

const text = (bundle: unknown, key: string) => key.split(".").reduce<unknown>((n, k) => (n as Record<string, unknown>)?.[k], bundle);

describe("cancel label by work type", () => {
  it("names the type, never a letter", () => {
    expect(text(en, cancelLabelKey("rfi"))).toBe("Cancel RFI");
    expect(text(en, cancelLabelKey("submittal"))).toBe("Cancel Submittal");
    expect(text(en, cancelLabelKey("submittal_package"))).toBe("Cancel");
    for (const c of ["rfi", "submittal", "submittal_package", "meeting"] as const) {
      expect(String(text(en, cancelLabelKey(c)))).not.toMatch(/letter/i);
      expect(text(tr, cancelLabelKey(c))).toBeTruthy();
    }
  });
});
