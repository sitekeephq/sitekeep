import { describe, expect, it } from "vitest";
import {
  OAUTH_CLIENT_TYPE_LABELS_TR,
  OAUTH_SCOPE_LABELS_TR,
  OAUTH_SCOPES,
  isTitleCaseTr,
  normalizeOAuthScopes,
  oauthApiAccess,
  oauthClientTypeHint,
  oauthScopeHint,
  parseOAuthScopes,
} from "../src/index.js";

describe("OAuth scopes", () => {
  it("parses the space-separated scope parameter", () => {
    expect(parseOAuthScopes("bcf  documents\tbcf")).toEqual(["bcf", "documents"]);
    expect(parseOAuthScopes("")).toEqual([]);
    expect(parseOAuthScopes(undefined)).toEqual([]);
  });

  it("keeps known scopes in a fixed order", () => {
    expect(normalizeOAuthScopes(["write", "openid", "bcf"])).toEqual(["bcf", "write"]);
  });

  it("maps scopes to /api/v1 access: write includes read, OpenCDE-only scopes give none", () => {
    expect(oauthApiAccess(["bcf", "write"])).toBe("write");
    expect(oauthApiAccess(["read", "documents"])).toBe("read");
    expect(oauthApiAccess(["bcf", "documents"])).toBeNull();
  });

  it("has Title Case labels and a hint for every scope", () => {
    for (const s of OAUTH_SCOPES) {
      expect(isTitleCaseTr(OAUTH_SCOPE_LABELS_TR[s]), s).toBe(true);
      expect(oauthScopeHint(s).endsWith("."), s).toBe(true);
      expect(oauthScopeHint(s, "en").endsWith("."), s).toBe(true);
    }
    expect(Object.values(OAUTH_CLIENT_TYPE_LABELS_TR).every(isTitleCaseTr)).toBe(true);
    expect(oauthClientTypeHint("public")).toContain("PKCE (S256) zorunlu");
    expect(oauthClientTypeHint("public", "en")).toContain("PKCE (S256) required");
  });
});
