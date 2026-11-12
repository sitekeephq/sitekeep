import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ErrorOverlay, LoadingOverlay, scanStatusText } from "../src/react/scan/ScanChrome";
import { LayerVisibilityControl } from "../src/react/scan/LayerVisibilityControl";
import { ModelElementPanel } from "../src/react/scan/ModelElementPanel";
import { ScanIotToolbar } from "../src/react/scan/ScanIotToolbar";
import { ZoomHud } from "../src/react/scan/ZoomHud";
import { IoTExtensionPanel } from "../src/react/scan/IoTExtensionPanel";
import type { ScanElementSelection } from "../src/scan/selection/scanSelection";
import type { IotSensor } from "../src/scan/types";
import type { IoTDataView, IotProfile } from "../src/scan/iot/dataView";

afterEach(() => cleanup());

const sensor = (over: Partial<IotSensor> = {}): IotSensor => ({
  id: "s1",
  name: "Nokta A",
  groupName: "281",
  channel: "cant",
  channelLabel: "Cant",
  unit: "mm",
  value: 1.2,
  status: "ok",
  position: [0, 1, 0],
  km: 281,
  metre: 0,
  timestamps: [new Date("2024-01-01T00:00:00Z")],
  series: [1.2],
  limits: { AL: { min: -5, max: 5 } },
  ...over,
});

function dataView(profile: IotProfile | null = null): IoTDataView {
  return {
    loadProfile: async () => profile,
    sensors: new Map([["s1", { name: "Nokta A", location: { x: 0, y: 0, z: 0 }, km: 281, metre: 0 }]]),
    channels: new Map([["cant", { name: "Cant", unit: "mm", limits: { AL: { min: -5, max: 5 } } }]]),
    samples: {
      timestamps: [new Date("2024-01-01T00:00:00Z"), new Date("2025-01-01T00:00:00Z")],
      data: { s1: { cant: [1.2, 2.4] } },
    },
  } as unknown as IoTDataView;
}

describe("scanStatusText", () => {
  it("describes BIM vs scan load states", () => {
    expect(scanStatusText(false, "off")).toMatch(/IoT/);
    expect(scanStatusText(true, "off")).toMatch(/LAS \+ ölçüm/);
    expect(scanStatusText(true, "loading")).toMatch(/Güzergah modeli yükleniyor/);
    expect(scanStatusText(true, "ready")).toMatch(/Güzergah/);
    expect(scanStatusText(true, "error")).toMatch(/henüz hazır değil/);
  });
});

describe("scan chrome overlays", () => {
  it("portals a loading overlay with steps and hides when done", () => {
    const { rerender } = render(
      <LoadingOverlay
        show
        title="Yükleniyor..."
        detail="Fragments"
        steps={[
          { id: "las", label: "LAS", done: true },
          { id: "ifc", label: "Güzergah", done: false },
        ]}
      />,
    );
    expect(screen.getByText("Yükleniyor...")).toBeTruthy();
    expect(screen.getByText("LAS · hazır")).toBeTruthy();
    expect(screen.getByText("Güzergah")).toBeTruthy();
    rerender(<LoadingOverlay show={false} />);
    expect(screen.queryByText("Yükleniyor...")).toBeNull();
  });

  it("renders an error overlay only when a message is set", () => {
    const { rerender } = render(<ErrorOverlay message={null} />);
    expect(screen.queryByText(/Hata:/)).toBeNull();
    rerender(<ErrorOverlay message="ağ koptu" />);
    expect(screen.getByText("Hata: ağ koptu")).toBeTruthy();
  });
});

describe("scan HUD chrome", () => {
  it("toggles layer visibility", () => {
    const onModelVisible = vi.fn();
    const onLasVisible = vi.fn();
    render(
      <LayerVisibilityControl
        modelVisible
        lasVisible={false}
        onModelVisible={onModelVisible}
        onLasVisible={onLasVisible}
      />,
    );
    expect(screen.getByText("Katmanlar")).toBeTruthy();
    screen.getByRole("button", { name: /Model/ }).click();
    screen.getByRole("button", { name: /LAS/ }).click();
    expect(onModelVisible).toHaveBeenCalledWith(false);
    expect(onLasVisible).toHaveBeenCalledWith(true);
  });

  it("shows zoom MAX and reports slider / reset", () => {
    const onReset = vi.fn();
    const onZoomPercent = vi.fn();
    render(
      <ZoomHud
        visible
        status="Balıkesir Susurluk · LAS + ölçüm noktaları"
        zoom={{ ratio: 10, percent: 100, atMax: true, ready: true }}
        onReset={onReset}
        onZoomPercent={onZoomPercent}
      />,
    );
    expect(screen.getByText("Balıkesir Susurluk · LAS + ölçüm noktaları")).toBeTruthy();
    expect(screen.getByText("MAX")).toBeTruthy();
    screen.getByRole("button", { name: "Reset" }).click();
    expect(onReset).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("Yakınlaştırma oranı"), { target: { value: "40" } });
    expect(onZoomPercent).toHaveBeenCalledWith(40);
  });

  it("hides the zoom HUD when not visible", () => {
    render(
      <ZoomHud
        visible={false}
        zoom={{ ratio: 1, percent: 0, atMax: false, ready: true }}
        onReset={() => undefined}
        onZoomPercent={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("toggles IoT toolbar actions", () => {
    const onToggle = vi.fn();
    render(<ScanIotToolbar active={["list", "heatmap"]} onToggle={onToggle} />);
    expect(screen.getByRole("toolbar", { name: "IoT araçları" })).toBeTruthy();
    screen.getByRole("button", { name: "Liste" }).click();
    screen.getByRole("button", { name: "Km" }).click();
    expect(onToggle).toHaveBeenCalledWith("list");
    expect(onToggle).toHaveBeenCalledWith("range");
  });

  it("lists the selected güzergah element", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
    const mesh = new THREE.Mesh(geometry);
    mesh.name = "guzergah-sleepers";
    const selection: ScanElementSelection = {
      id: "sleepers-1",
      label: "Travers 1",
      part: "sleepers",
      elementIndex: 0,
      vertexStart: 0,
      vertexEnd: 4,
      mesh,
      box: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 0.4, 1)),
    };
    const onClose = vi.fn();
    render(
      <ModelElementPanel
        selection={selection}
        meta={{
          source: "guzergah.ifc",
          counts: { sleepers: 8, rails: 2 },
          parts: { sleepers: { file: "sleepers.bin", triangles: 12, bbox: { min: [0, 0, 0], max: [2, 1, 1] } } },
        }}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("Model bilgileri")).toBeTruthy();
    expect(screen.getByText("Travers 1")).toBeTruthy();
    expect(screen.getByText("guzergah.ifc")).toBeTruthy();
    screen.getByLabelText("Seçimi temizle").click();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("IoTExtensionPanel", () => {
  const sensors = [sensor(), sensor({ id: "s2", name: "Nokta B", value: 8, status: "alarm", metre: 25 })];
  const base = {
    sensors,
    selectedId: "s1" as string | null,
    dataView: dataView(),
    channelId: "cant",
    year: 2024,
    bimOn: true,
    pointCloudOn: false,
    heatmapFilter: "all" as const,
    onChannel: vi.fn(),
    onYear: vi.fn(),
    onToggleBim: vi.fn(),
    onTogglePointCloud: vi.fn(),
    onSelect: vi.fn(),
    onOpenDetail: vi.fn(),
    onHeatmapFilter: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: () => undefined,
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      stroke: () => undefined,
      fill: () => undefined,
      fillText: () => undefined,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      font: "",
      textAlign: "center",
      textBaseline: "middle",
    } as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => vi.restoreAllMocks());

  it("lists sensors and opens detail", () => {
    render(<IoTExtensionPanel {...base} view="list" />);
    expect(screen.getByText("IoT Sensors")).toBeTruthy();
    screen.getByText("Nokta B").closest("button")?.click();
    expect(base.onSelect).toHaveBeenCalledWith("s2");
    expect(base.onOpenDetail).toHaveBeenCalled();
  });

  it("renders detail, heatmap and range views", () => {
    const { rerender } = render(<IoTExtensionPanel {...base} view="detail" />);
    expect(screen.getByText("Sensor Detail")).toBeTruthy();
    expect(screen.getByText(/Cant/)).toBeTruthy();
    rerender(<IoTExtensionPanel {...base} view="heatmap" />);
    expect(screen.getByText("IoT Heatmaps")).toBeTruthy();
    expect(screen.getByText("BIM / güzergah")).toBeTruthy();
    rerender(<IoTExtensionPanel {...base} view="range" />);
    expect(screen.getByText("Km Aralığı Grafiği")).toBeTruthy();
    expect(screen.getByText(/ölçüm noktası/)).toBeTruthy();
  });

  it("km range over the 25 cm survey: km + metre bounds, cleared fields, other channels and years", async () => {
    // 281+066.00 … 281+090.00 every 25 cm (97 rows), two survey years.
    const metre = Array.from({ length: 97 }, (_, i) => 66 + i * 0.25);
    const km = metre.map(() => 281);
    const profile: IotProfile = {
      channels: {
        gauge: { name: "Ekartman", unit: "mm", limits: { AL: { min: -7, max: 25 } } },
        alignment_l: { name: "Alignment (Sol)", unit: "mm" },
      },
      years: {
        "2023": { km, metre, values: { gauge: metre.map(() => 1), alignment_l: metre.map(() => 2) } },
        "2024": { km: km.slice(0, 10), metre: metre.slice(0, 10), values: { gauge: metre.slice(0, 10).map(() => 3) } },
      },
    };
    render(<IoTExtensionPanel {...base} dataView={dataView(profile)} channelId="gauge" year={2023} view="range" />);
    expect(await screen.findByText(/97 ölçüm noktası · 281\+066\.00 – 281\+090\.00/)).toBeTruthy();
    // 10 m: 66.00 … 76.00, both ends included.
    fireEvent.change(screen.getByLabelText("Km Başlangıç m"), { target: { value: "66" } });
    fireEvent.change(screen.getByLabelText("Km Bitiş km"), { target: { value: "281" } });
    fireEvent.change(screen.getByLabelText("Km Bitiş m"), { target: { value: "76" } });
    expect(screen.getByText(/41 ölçüm noktası · 281\+066\.00 – 281\+076\.00/)).toBeTruthy();
    // The metre field can be emptied (no 0 coming back) and takes a decimal comma.
    const mFrom = screen.getByLabelText("Km Başlangıç m") as HTMLInputElement;
    fireEvent.change(mFrom, { target: { value: "" } });
    expect(mFrom.value).toBe("");
    expect(screen.getByText(/41 ölçüm noktası · 281\+066\.00/)).toBeTruthy();
    fireEvent.change(mFrom, { target: { value: "75,5" } });
    expect(screen.getByText(/3 ölçüm noktası/)).toBeTruthy();
    fireEvent.change(mFrom, { target: { value: "x" } });
    expect(mFrom.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(screen.getByRole("combobox", { name: /Yıl/ }), { target: { value: "2024" } });
    expect(screen.getByText(/10 ölçüm noktası/)).toBeTruthy();
  });

  it("km range: bounds can be cleared and typed as km, the points follow", () => {
    render(<IoTExtensionPanel {...base} view="range" />);
    const from = screen.getByLabelText("Başlangıç") as HTMLInputElement;
    // Empty fields cover every point; the first / last point show as placeholders.
    expect(from.value).toBe("");
    expect(from.placeholder).toBe("Nokta A");
    expect(screen.getByText("2 ölçüm noktası")).toBeTruthy();
    fireEvent.change(from, { target: { value: "281+010" } });
    expect(screen.getByText("1 ölçüm noktası")).toBeTruthy();
    fireEvent.change(from, { target: { value: "" } });
    expect(from.value).toBe("");
    expect(screen.getByText("2 ölçüm noktası")).toBeTruthy();
    // Unreadable text is marked and ignored; reversed bounds still select the range between them.
    fireEvent.change(from, { target: { value: "abc" } });
    expect(from.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("2 ölçüm noktası")).toBeTruthy();
    fireEvent.change(from, { target: { value: "281030" } });
    fireEvent.change(screen.getByLabelText("Bitiş"), { target: { value: "281+020" } });
    expect(screen.getByText("1 ölçüm noktası")).toBeTruthy();
  });
});
