import { describe, expect, it } from "vitest";
import {
  cleanExcerpt,
  formatSearchQuery,
  highlightParts,
  parseSearchQuery,
  searchParamsFromQuery,
  searchParamsToQuery,
  searchTerms,
  termLikePattern,
  type DocSearchParams,
} from "../src/index.js";

const f = (q: string) => formatSearchQuery(parseSearchQuery(q));

describe("search query language", () => {
  it("ANDs words and honours AND / OR / NOT and parentheses", () => {
    expect(f("kolon kiriş")).toBe("kolon AND kiriş");
    expect(f("kolon AND kiriş")).toBe("kolon AND kiriş");
    expect(f("kolon OR kiriş")).toBe("kolon OR kiriş");
    expect(f("a b OR c")).toBe("(a AND b) OR c");
    expect(f("a (b OR c)")).toBe("a AND (b OR c)");
    expect(f("statik NOT taslak")).toBe("statik AND NOT taslak");
    expect(f("NOT (a OR b)")).toBe("NOT (a OR b)");
    expect(f("kat VEYA bodrum DEĞİL çatı")).toBe("kat OR (bodrum AND NOT çatı)");
  });

  it("keeps lower-case operator words as words", () => {
    expect(f("kat or bodrum")).toBe("kat AND or AND bodrum");
    expect(f("ve")).toBe("ve");
  });

  it("keeps quoted phrases and wildcards", () => {
    expect(f('"zemin etüdü" rapor*')).toBe('"zemin etüdü" AND rapor*');
    expect(parseSearchQuery('"DOC-01-A"')).toEqual({ kind: "term", text: "DOC-01-A", phrase: true });
    expect(termLikePattern("P01*")).toBe("%p01%%");
    expect(termLikePattern("100%_x")).toBe("%100\\%\\_x%");
    expect(termLikePattern("KİRİŞ")).toBe("%kiriş%");
  });

  it("splits unquoted codes at separators", () => {
    expect(f("DOC-01-A")).toBe("DOC AND 01 AND A");
    expect(f("MBE_ARC.dwg")).toBe("MBE AND ARC AND dwg");
    expect(f("DOC-*")).toBe("DOC");
  });

  it("tolerates broken input", () => {
    expect(parseSearchQuery("")).toBeNull();
    expect(parseSearchQuery("   ()  ")).toBeNull();
    expect(f("a OR")).toBe("a");
    expect(f("(a b")).toBe("a AND b");
    expect(f("a ) b")).toBe("a AND b");
    expect(f("NOT")).toBe("");
    expect(f('"open phrase')).toBe('"open phrase"');
  });

  it("lists positive terms for highlighting", () => {
    expect(searchTerms(parseSearchQuery("kolon OR (kiriş NOT taslak) NOT NOT x"))).toEqual(["kolon", "kiriş", "x"]);
  });
});

describe("highlight and excerpts", () => {
  it("highlights Turkish-insensitive and wildcard pieces", () => {
    const parts = highlightParts("KİRİŞ detay kırış", ["kiriş"]);
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(["KİRİŞ", "kırış"]);
    expect(highlightParts("P01.02 rev", ["p0*02"]).filter((p) => p.hit).map((p) => p.text)).toEqual(["P0", "02"]);
    expect(highlightParts("abc", [])).toEqual([{ text: "abc", hit: false }]);
  });

  it("cleans tags and entities from excerpts", () => {
    expect(cleanExcerpt('<w:t xml:space="preserve">Zemin</w:t><w:t>&amp; temel</w:t>\f s')).toBe("Zemin & temel s");
    expect(cleanExcerpt("a < b and c > d")).toBe("a < b and c > d");
  });
});

describe("search parameters", () => {
  it("round-trips through the query string", () => {
    const p: DocSearchParams = {
      q: "kolon",
      content: false,
      folderIds: ["a", "b"],
      subfolders: false,
      ext: ["pdf", "dwg"],
      attrs: { Disiplin: "MİM" },
      states: ["wip", "published"],
      suitability: ["S2"],
      revision: "P01*",
      uploadedBy: ["u1"],
      companies: ["c1"],
      updatedFrom: "2026-01-01",
      updatedTo: "2026-02-01",
      addedFrom: "2026-01-05",
      version: "2-5",
      review: ["approved", "none"],
      locked: true,
      trash: true,
      sort: "date",
      dir: "desc",
      offset: 50,
      limit: 25,
    };
    const qs = searchParamsToQuery(p);
    expect(searchParamsFromQuery(Object.fromEntries(qs.entries()))).toEqual(p);
  });

  it("drops unknown enum values", () => {
    expect(searchParamsFromQuery({ state: "wip,bogus", review: "x", sort: "weird", ext: ".PDF" })).toEqual({ states: ["wip"], ext: ["pdf"] });
  });
});
