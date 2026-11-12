import { describe, expect, it } from "vitest";
import { safeOAuthNext } from "../../src/shared/api/api-oauth";

const ORIGIN = "https://cde.firma.local";

describe("return address after signing in for an OAuth request", () => {
  it("allows only this server's /oauth2/authorize", () => {
    expect(safeOAuthNext("/oauth2/authorize?client_id=cde-1&state=x", ORIGIN)).toBe("/oauth2/authorize?client_id=cde-1&state=x");
    expect(safeOAuthNext(null, ORIGIN)).toBeNull();
    expect(safeOAuthNext("/projects", ORIGIN)).toBeNull();
    expect(safeOAuthNext("https://evil.test/oauth2/authorize", ORIGIN)).toBeNull();
    expect(safeOAuthNext("//evil.test/oauth2/authorize", ORIGIN)).toBeNull();
    expect(safeOAuthNext("/\evil.test/oauth2/authorize", ORIGIN)).toBeNull();
    expect(safeOAuthNext("/oauth2/authorize/../../x", ORIGIN)).toBeNull();
    expect(safeOAuthNext("javascript:alert(1)", ORIGIN)).toBeNull();
  });
});
