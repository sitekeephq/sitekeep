/**
 * EU AI Act Art. 50(1) (#171): text a model wrote carries an "AI-generated" label in the reader's
 * language, with the model in its tooltip.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { setLanguage } from "../../src/i18n";
import { AiGeneratedLabel } from "../../src/shared/ai/AiBits";

describe("AI-generated label", () => {
  it("names AI output in Turkish and English, with the model in the tooltip", async () => {
    const tr = renderToStaticMarkup(createElement(AiGeneratedLabel, { model: "qwen3:8b" }));
    expect(tr).toContain("Yapay zekâ ile üretildi");
    expect(tr).toContain("qwen3:8b");
    expect(tr).toContain('data-testid="ai-generated"');
    await setLanguage("en", { persist: false });
    try {
      expect(renderToStaticMarkup(createElement(AiGeneratedLabel, {}))).toContain("AI-generated");
    } finally {
      await setLanguage("tr", { persist: false });
    }
  });
});
