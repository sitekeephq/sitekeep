import { describe, expect, it } from "vitest";
import { addScriptNonce, buildReportSrcdoc, reportHtmlWarnings } from "../src/index.js";

const base = {
  html: `<h1>Panel</h1><script>CDE.onData(function (d) {});</script><script nonce="x">1</script>`,
  data: {},
  project: { id: "p", code: "GZL", name: "Gizlilik" },
  generatedAt: "2026-10-11T10:00:00Z",
};

describe("report iframe under the page CSP", () => {
  it("every script of the srcdoc carries the page nonce (the frame inherits the page policy)", () => {
    const doc = buildReportSrcdoc({ ...base, nonce: "abc123+/=" });
    const scripts = doc.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBe(4);
    expect(scripts.filter((s) => s.includes('nonce="abc123+/="'))).toHaveLength(3);
    expect(scripts).toContain('<script nonce="x">');
    expect(doc).toContain("Content-Security-Policy");
  });

  it("without a nonce (development) or with a malformed one the document is unchanged", () => {
    expect(buildReportSrcdoc(base)).not.toContain("nonce=\"abc");
    expect(addScriptNonce("<script>1</script>", 'a" onload="x')).toBe("<script>1</script>");
  });

  it("warns about inline event attributes", () => {
    expect(reportHtmlWarnings('<button onclick="go()">Git</button>').join(" ")).toMatch(/addEventListener/);
    expect(reportHtmlWarnings("<button id=\"go\">Git</button>")).toEqual([]);
  });
});
