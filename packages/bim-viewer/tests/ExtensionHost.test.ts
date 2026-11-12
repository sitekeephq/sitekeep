import { describe, expect, it, vi } from "vitest";
import { ExtensionHost } from "../src/extensions/ExtensionHost";
import type { ViewerExtensionContext } from "../src/extensions/types";

const context = {} as ViewerExtensionContext;

describe("ExtensionHost", () => {
  it("activates in declaration order and disposes in reverse order", async () => {
    const calls: string[] = [];
    const host = new ExtensionHost(context);

    await host.activateAll([
      {
        id: "first",
        activate: () => {
          calls.push("activate:first");
          return () => {
            calls.push("dispose:first");
          };
        },
      },
      {
        id: "second",
        activate: () => {
          calls.push("activate:second");
          return () => {
            calls.push("dispose:second");
          };
        },
      },
    ]);
    await host.dispose();

    expect(calls).toEqual([
      "activate:first",
      "activate:second",
      "dispose:second",
      "dispose:first",
    ]);
  });

  it("rejects duplicate ids and cleans up activated extensions", async () => {
    const cleanup = vi.fn();
    const host = new ExtensionHost(context);

    await expect(
      host.activateAll([
        { id: "tools", activate: () => cleanup },
        { id: "tools", activate: vi.fn() },
      ]),
    ).rejects.toThrow("Duplicate viewer extension id: tools");

    expect(cleanup).toHaveBeenCalledOnce();
  });
});
