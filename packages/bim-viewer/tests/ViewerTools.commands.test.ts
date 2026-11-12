import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ViewerTools } from "../src/tools/tools";
import { fakeModel, makeEngineStub } from "./helpers/engine-stub";

describe("ViewerTools commands", () => {
  it("starts in orbit, toggles help / section placing / measure and escapes", async () => {
    const { engine } = makeEngineStub([fakeModel({ id: "arch" })]);
    const tools = new ViewerTools(engine);
    expect(tools.state.nav).toBe("orbit");
    expect(tools.state.helpOpen).toBe(false);
    await tools.run("help");
    expect(tools.state.helpOpen).toBe(true);
    await tools.run("section:plane");
    expect(tools.state.sectionPlacing).toBe(true);
    expect(tools.state.hint).toMatch(/çift tıklayın/);
    await tools.run("escape");
    expect(tools.state.helpOpen).toBe(false);
    await tools.run("escape");
    expect(tools.state.sectionPlacing).toBe(false);
    await tools.run("measure:length");
    expect(tools.state.measureTool).toBe("length");
    tools.dispose();
  });

  it("opens a section box around federated models and removes it on the second call", async () => {
    const { engine } = makeEngineStub([
      fakeModel({ id: "arch", box: new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 3, 2)) }),
      fakeModel({ id: "mep", box: new THREE.Box3(new THREE.Vector3(1, 0, 1), new THREE.Vector3(5, 4, 5)) }),
    ]);
    const tools = new ViewerTools(engine);
    await tools.run("section:box");
    expect(tools.state.box).toBe(true);
    expect(tools.sections.planes.filter((p) => p.kind === "box")).toHaveLength(6);
    await tools.run("section:box");
    expect(tools.state.box).toBe(false);
    tools.dispose();
  });

  it("enters plan without a storey list when no model is loaded", async () => {
    const { engine } = makeEngineStub([]);
    const onFit = vi.fn();
    const tools = new ViewerTools(engine, { onFit });
    await tools.run("nav:plan");
    expect(tools.state.nav).toBe("plan");
    await tools.run("fit");
    expect(onFit).toHaveBeenCalledOnce();
    await tools.run("nav:orbit");
    expect(tools.state.nav).toBe("orbit");
    tools.dispose();
  });

  it("walks after a start point and leaves on escape", async () => {
    const { engine } = makeEngineStub([fakeModel({ id: "arch" })]);
    const tools = new ViewerTools(engine);
    await tools.setNav("walk", { walkAt: new THREE.Vector3(0, 1.7, 0) });
    expect(tools.state.nav).toBe("walk");
    expect(tools.walk.active).toBe(true);
    await tools.run("escape");
    expect(tools.state.nav).toBe("orbit");
    expect(tools.walk.active).toBe(false);
    tools.dispose();
  });

  it("notifies subscribers and forgets storeys when models change", () => {
    const { engine } = makeEngineStub([fakeModel({ id: "arch" })]);
    const tools = new ViewerTools(engine);
    const seen: string[] = [];
    const off = tools.subscribe(() => seen.push(tools.state.nav));
    tools.setHelp(true);
    expect(seen.length).toBeGreaterThan(0);
    tools.modelsChanged();
    off();
    tools.dispose();
  });
});
