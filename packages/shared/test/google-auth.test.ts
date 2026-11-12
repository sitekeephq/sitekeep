import { describe, expect, it } from "vitest";
import { emailMatchesGoogleDomains, normalizeGoogleDomain } from "../src/index.js";

describe("normalizeGoogleDomain", () => {
  it("strips @ and a trailing dot, then lowercases", () => {
    expect(normalizeGoogleDomain(" @Ornek-Insaat.COM.TR. ")).toBe("ornek-insaat.com.tr");
  });

  it("rejects a single label, spaces and a wildcard", () => {
    expect(normalizeGoogleDomain("localhost")).toBeNull();
    expect(normalizeGoogleDomain("7 dimensions.eu")).toBeNull();
    expect(normalizeGoogleDomain("*.ornek-insaat.com.tr")).toBeNull();
    expect(normalizeGoogleDomain("")).toBeNull();
  });
});

describe("emailMatchesGoogleDomains", () => {
  it("matches the domain and a subdomain, not a lookalike host", () => {
    const domains = ["ornek-insaat.com.tr"];
    expect(emailMatchesGoogleDomains("ayse@ornek-insaat.com.tr", domains)).toBe(true);
    expect(emailMatchesGoogleDomains("Ayse@ORNEK-INSAAT.COM.TR", domains)).toBe(true);
    expect(emailMatchesGoogleDomains("a@mail.ornek-insaat.com.tr", domains)).toBe(true);
    expect(emailMatchesGoogleDomains("a@notornek-insaat.com.tr", domains)).toBe(false);
    expect(emailMatchesGoogleDomains("a@ornek-insaat.com.tr.evil.com", domains)).toBe(false);
    expect(emailMatchesGoogleDomains("a@gmail.com", domains)).toBe(false);
  });
});
