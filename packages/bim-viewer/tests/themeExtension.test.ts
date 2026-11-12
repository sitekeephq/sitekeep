import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createThemeExtension } from "../src/extensions/themeExtension";
import { fakeModel, makeEngineStub } from "./helpers/engine-stub";

describe("createThemeExtension", () => {
  it("paints the scene from the host theme and listens for changes", async () => {
    const { engine, scene } = makeEngineStub([fakeModel({ id: "arch" })]);
    const ext = createThemeExtension({
      readTheme: () => "light",
      sceneBackgroundHex: (theme) => (theme === "dark" ? 0x111111 : 0xfafafa),
      themeChangeEvent: "cde-theme",
    });
    const cleanup = await ext.activate({ engine, container: document.body });
    expect((scene.background as THREE.Color).getHex()).toBe(0xfafafa);
    window.dispatchEvent(new CustomEvent("cde-theme", { detail: "dark" }));
    expect((scene.background as THREE.Color).getHex()).toBe(0x111111);
    cleanup?.();
  });
});
