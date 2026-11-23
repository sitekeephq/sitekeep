import { describe, expect, it } from "vitest";
import { extractJson } from "../../src/ai/json.js";
import { stripThinking } from "../../src/ai/provider.js";
import { findStorey } from "../../src/model/rules.js";
import { toPublicUrl } from "../../src/office/discovery.js";

function fast<T>(fn: () => T, ms = 250): T {
  const t0 = performance.now();
  const out = fn();
  expect(performance.now() - t0).toBeLessThan(ms);
  return out;
}
const N = 100_000;

describe("reasoning blocks", () => {
  it("stripThinking removes finished blocks and an unfinished leading one", () => {
    expect(stripThinking("<think>a</think>\n  answer")).toBe("answer");
    expect(stripThinking("x <think>a</think> y <think>b</think> z")).toBe("x y z");
    expect(stripThinking("<think>never closed")).toBe("");
    expect(stripThinking("keep <think>never closed")).toBe("keep <think>never closed");
  });
  it("extractJson ignores reasoning, upper or lower case", () => {
    expect(extractJson('<THINK>{"x":0}</THINK>{"x":1}')).toEqual({ x: 1 });
    expect(extractJson('reasoning only</think>{"x":2}')).toEqual({ x: 2 });
  });
  it("are fast on many openers without a closer", () => {
    const bad = "<think>".repeat(N);
    expect(fast(() => stripThinking(bad + "tail"))).toBe("");
    expect(() => fast(() => extractJson(bad))).toThrow(/JSON/);
  });
  it("extractJson reads a fenced answer and is fast on many fences without a closer", () => {
    expect(extractJson('Here:\n```json\n{"x":3}\n```')).toEqual({ x: 3 });
    expect(extractJson('```\n{"x":4}\n``` trailing')).toEqual({ x: 4 });
    expect(() => fast(() => extractJson("```json".repeat(N) + " no object"))).toThrow(/JSON/);
  });
});

describe("storey question", () => {
  const vocab = { storeys: [{ name: "Kat 2", elevation: 6 }, { name: "Zemin", elevation: 0 }] } as never;
  it("finds the number before or after the word", () => {
    expect(findStorey("2. kat duvarlari", vocab)).toBe("Kat 2");
    expect(findStorey("kat 2 duvarlari", vocab)).toBe("Kat 2");
  });
  it("is fast on long digit and space runs", () => {
    expect(fast(() => findStorey("1".repeat(N) + " x", vocab))).toBeNull();
    expect(fast(() => findStorey("1 ".repeat(N), vocab))).toBeNull();
  });
});

describe("toPublicUrl", () => {
  it("ignores trailing slashes, however many", () => {
    expect(toPublicUrl("http://in:9980/hosting/x", "http://in:9980/", "https://pub/")).toBe("https://pub/hosting/x");
    fast(() => toPublicUrl("u", "a" + "/".repeat(N) + "b", "p" + "/".repeat(N) + "q"));
  });
});
