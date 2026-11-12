import { cleanup, act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelectedItem } from "../src/core/ViewerEngine";
import { PropertiesPanel, defaultClassLabel } from "../src/react/PropertiesPanel";
import { ViewerCanvas } from "../src/react/ViewerCanvas";
import { ViewerToolsHud } from "../src/react/ViewerToolsHud";
import type { ToolsState, ViewerTools } from "../src/tools/tools";
import { ViewerEngine as Engine } from "../src/core/ViewerEngine";
import { fakeModel, makeEngineStub } from "./helpers/engine-stub";

afterEach(() => cleanup());

const idleState: ToolsState = {
  nav: "orbit",
  walkSpeed: 1.4,
  pointerLocked: false,
  storeys: null,
  storeysLoading: false,
  storeyIndex: null,
  sectionPlacing: false,
  planes: [],
  box: false,
  edgesOn: true,
  edgeMode: null,
  measureTool: null,
  measurements: [],
  tapPending: false,
  xray: false,
  hasSelection: false,
  hidden: false,
  helpOpen: false,
  hint: null,
};

describe("defaultClassLabel", () => {
  it("strips Ifc / StandardCase for a host-facing class name", () => {
    expect(defaultClassLabel("IfcWallStandardCase")).toBe("Wall");
    expect(defaultClassLabel("IfcDoor")).toBe("Door");
  });
});

describe("ViewerCanvas", () => {
  it("creates the engine once and reports ready", async () => {
    const { engine } = makeEngineStub([fakeModel({ id: "arch" })]);
    const create = vi.spyOn(Engine, "create").mockResolvedValue(engine);
    const onReady = vi.fn();
    render(<ViewerCanvas onReady={onReady} workerUrl="/fragments-worker.mjs" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(create).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledWith(engine);
    expect(document.querySelector(".seven-dimensions-viewer")).toBeTruthy();
    create.mockRestore();
  });
});

describe("ViewerToolsHud", () => {
  it("shows the tool rail when a model is loaded", () => {
    const tools = {
      setNav: vi.fn(),
      setHelp: vi.fn(),
      screenshot: vi.fn(),
      setXray: vi.fn(),
      mountCube: vi.fn(),
    } as unknown as ViewerTools;
    render(
      <ViewerToolsHud
        tools={tools}
        state={idleState}
        panel={null}
        setPanel={() => undefined}
        loaded
      />,
    );
    expect(screen.getByRole("toolbar", { name: "Görüntüleme Araçları" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kesit" })).toBeTruthy();
  });
});

describe("PropertiesPanel", () => {
  it("renders the selected element and copies a value", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const selected: SelectedItem = {
      modelId: "arch",
      localId: 1,
      globalId: "2O2F",
      category: "IfcWall",
      name: "Duvar-01",
      storey: "Zemin",
      groups: [{ name: "Öznitelikler", rows: [["Name", "Duvar-01"]] }],
    };
    render(<PropertiesPanel selected={selected} onClose={() => undefined} />);
    expect(screen.getAllByText("Duvar-01").length).toBeGreaterThan(0);
    expect(screen.getByText("Wall")).toBeTruthy();
    await act(async () => {
      screen.getAllByTitle("Değeri kopyala")[0]?.click();
    });
    expect(writeText).toHaveBeenCalled();
  });
});
