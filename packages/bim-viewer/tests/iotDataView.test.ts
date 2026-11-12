import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureIotProfile,
  IoTDataView,
  configureIotApi,
  placeSensorsOnBox,
  placeSensorsOnPath,
} from "../src/scan/iot/dataView";
import type { IotSensorMeta } from "../src/scan/iot/dataView";

const payload = {
  sensors: {
    s1: { name: "A", groupName: "hat", km: 281, metre: 0, location: { x: 0, y: 0, z: 0 }, _trackOrder: 1 },
    s2: { name: "B", groupName: "hat", km: 281, metre: 25, location: { x: 0, y: 0, z: 0 }, _trackOrder: 2 },
  },
  channels: {
    cant: { name: "Cant", unit: "mm", limits: { AL: { min: -5, max: 5 } } },
  },
  samples: {
    timestamps: ["2024-01-01T00:00:00Z", "2025-01-01T00:00:00Z"],
    data: {
      s1: { cant: [1.2, 2.4] },
      s2: { cant: [null, 8] },
    },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  configureIotApi(null);
});

describe("IoTDataView", () => {
  it("loads the live API and maps sensors onto a box", async () => {
    configureIotApi("http://iot.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/sensors")) return new Response(JSON.stringify(payload.sensors));
        if (String(url).endsWith("/channels")) return new Response(JSON.stringify(payload.channels));
        if (String(url).endsWith("/samples")) return new Response(JSON.stringify(payload.samples));
        return new Response(null, { status: 404 });
      }),
    );
    const view = new IoTDataView();
    await view.init();
    expect(view.source).toBe("live");
    expect(view.getSample("s1", "cant", 2024)).toBe(1.2);
    const sensors = view.toSceneSensors({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 2, z: 10 } }, "cant", 2024, true);
    expect(sensors).toHaveLength(2);
    expect(sensors[0]?.status).toBe("ok");
    expect(sensors[1]?.name).toMatch(/281\+/);
  });

  it("uses the bundled sample without any network call when no live API is configured", async () => {
    const fetch = vi.fn(async (url: string) =>
      String(url) === "/iot-sample.json" ? new Response(JSON.stringify(payload)) : new Response(null, { status: 404 }),
    );
    vi.stubGlobal("fetch", fetch);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const view = new IoTDataView();
    await view.init();
    expect(view.source).toBe("sample");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/iot-sample.json"]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("makes every surveyed position a point with one value per year when the host has a survey", async () => {
    const profile = {
      channels: { gauge: { name: "Ekartman", unit: "mm", limits: { AL: { min: -7, max: 25 } } } },
      years: {
        "2023": { km: [281, 281, 281], metre: [66, 66.25, 66.5], values: { gauge: [1, 2, 30] } },
        "2024": { km: [281, 281], metre: [66, 66.25], values: { gauge: [4, 5] } },
      },
    };
    const fetch = vi.fn(async (url: string) =>
      String(url) === "/iot-profile.json" ? new Response(JSON.stringify(profile)) : new Response(null, { status: 404 }),
    );
    vi.stubGlobal("fetch", fetch);
    configureIotProfile("/iot-profile.json");
    const view = new IoTDataView();
    await view.init();
    configureIotProfile(null);
    expect(view.source).toBe("survey");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/iot-profile.json"]);
    expect(view.sensors.size).toBe(3);
    expect(view.samples?.timestamps.map((t) => t.getFullYear())).toEqual([2023, 2024]);
    expect(view.samples?.data["km-281-m-066.50"]?.gauge).toEqual([30, null]);
    const path = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }];
    const sensors = view.toSceneSensors({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 1, z: 1 } }, "gauge", 2023, true, path);
    expect(sensors.map((s) => s.name)).toEqual(["281+066.00", "281+066.25", "281+066.50"]);
    expect(sensors.map((s) => s.status)).toEqual(["ok", "ok", "warn"]);
    expect(sensors[2]?.series).toEqual([30, null]);
  });

  it("falls back to the bundled sample when a configured live API fails", async () => {
    configureIotApi("http://iot.test/");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url) === "/iot-sample.json") return new Response(JSON.stringify(payload));
        return new Response(null, { status: 503 });
      }),
    );
    const view = new IoTDataView();
    await view.init();
    expect(view.source).toBe("sample");
  });
});

describe("sensor placement", () => {
  const sensors = new Map<string, IotSensorMeta>([
    ["a", { location: { x: 0, y: 0, z: 0 }, km: 1, metre: 0, _trackOrder: 1 }],
    ["b", { location: { x: 0, y: 0, z: 0 }, km: 1, metre: 25, _trackOrder: 2 }],
  ]);

  it("spaces sensors along a path and a box", () => {
    const onPath = placeSensorsOnPath(sensors, [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
    ]);
    expect(onPath.get("a")?.location.x).toBeCloseTo(0);
    expect(onPath.get("b")?.location.x).toBeCloseTo(10);
    const onBox = placeSensorsOnBox(sensors, { min: { x: 0, y: 0, z: 0 }, max: { x: 8, y: 2, z: 8 } }, true);
    expect(onBox.get("a")?.location.x).toBe(0);
    expect(onBox.get("b")?.location.x).toBe(8);
  });
});
