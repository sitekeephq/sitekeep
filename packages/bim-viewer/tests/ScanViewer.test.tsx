import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScanViewer } from "../src/react/scan/ScanViewer";
import { ViewerEngine as Engine } from "../src/core/ViewerEngine";
import { configureScanAssets } from "../src/scan/assets";
import { configureIotApi } from "../src/scan/iot/dataView";
import { fakeModel, makeEngineStub } from "./helpers/engine-stub";
import { stubScanFetch } from "./helpers/scan-fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureScanAssets();
  configureIotApi(null);
});

describe("ScanViewer", () => {
  it("mounts, loads LAS + güzergah and shows scan chrome", async () => {
    const { engine } = makeEngineStub([fakeModel({ id: "arch" })]);
    const create = vi.spyOn(Engine, "create").mockResolvedValue(engine);
    vi.stubGlobal("fetch", vi.fn(stubScanFetch()));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: () => undefined,
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      stroke: () => undefined,
      fill: () => undefined,
      fillText: () => undefined,
      rect: () => undefined,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      font: "",
      textAlign: "center",
      textBaseline: "middle",
    } as unknown as CanvasRenderingContext2D);

    render(<ScanViewer fragmentRoutes={["/models/sample-wall.frag"]} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText("Katmanlar")).toBeTruthy();
    }, { timeout: 4_000 });
    expect(create).toHaveBeenCalledOnce();
    expect(screen.getByRole("toolbar", { name: "IoT araçları" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
    expect(screen.getByText(/Balıkesir Susurluk/)).toBeTruthy();
    expect(screen.queryByText("Sahne hazırlanıyor")).toBeNull();

    await act(async () => {
      screen.getByRole("button", { name: /LAS/ }).click();
      screen.getByRole("button", { name: "Liste" }).click();
    });
    await waitFor(() => {
      expect(screen.getByText("IoT Sensors")).toBeTruthy();
    });
    create.mockRestore();
  });
});
