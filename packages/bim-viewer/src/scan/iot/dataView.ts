// @ts-nocheck
import { statusFromLimits } from "../types.js";
import type { IotSensor } from "../types.js";

export type LimitBand = { min: number; max: number };

export interface IotChannel {
  name: string;
  unit: string;
  min?: number;
  max?: number;
  limitMin?: number;
  limitMax?: number;
  limits?: {
    AL?: LimitBand;
    IL?: LimitBand;
    IAL?: LimitBand;
  };
}

export interface IotSensorMeta {
  name?: string;
  groupName?: string;
  km?: number;
  metre?: number;
  location: { x: number; y: number; z: number };
  _trackOrder?: number;
}

export interface IotSamples {
  timestamps: Date[];
  data: Record<string, Record<string, Array<number | null>>>;
}

/** Default live API: the host's VITE_IOT_API, else none (no request to a guessed localhost port). */
const ENV_IOT_API: string | undefined = (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_IOT_API) || undefined;

let iotApiBase: string | null = ENV_IOT_API ? ENV_IOT_API.replace(/\/$/, "") : null;

/** Points IoT at a live API; null uses the bundled sample data only. */
export function configureIotApi(baseUrl: string | null) {
  iotApiBase = baseUrl ? baseUrl.replace(/\/$/, "") : null;
}

const ENV_IOT_PROFILE: string | undefined = (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_IOT_PROFILE) || undefined;
let iotProfileUrl: string | null = ENV_IOT_PROFILE || null;

/**
 * The host's 25 cm survey file (IotProfile JSON, e.g. "/iot-profile.json"), or VITE_IOT_PROFILE.
 * Opt-in like the live API: without it nothing is requested (no 404 for hosts that have none).
 */
export function configureIotProfile(url: string | null) {
  iotProfileUrl = url || null;
}

/** Autodesk / demo: 281+000.75 → 281+001.00 (25 m adım, km atlama yok). */
export function formatRailChainageLabel(baseKm: number, trackOrder: number, stepMetres = 25): string {
  const along = Math.max(0, (trackOrder - 1) * stepMetres);
  const major = Math.floor(along / 100);
  const minor = along % 100;
  return `${baseKm}+${String(major).padStart(3, "0")}.${String(minor).padStart(2, "0")}`;
}

export function trackChainageMetres(trackOrder: number, stepMetres = 25): number {
  return Math.max(0, (trackOrder - 1) * stepMetres);
}

/**
 * A typed range bound of the km chart → the chart's position axis, or null when empty/unreadable.
 * Plain numbers are positions as they are ("100", "12,5"). "km+…" text is read like the axis
 * labels: with track chainage the inverse of formatRailChainageLabel ("281+001.00" → 100 hat m);
 * otherwise kilometre and metres ("281+050.5" → 281050.5 m).
 */
export function parseChainageInput(text: string, trackChainage: boolean): number | null {
  const t = text.trim().replace(",", ".");
  if (!t) return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(\d+)\s*\+\s*(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  if (trackChainage) return Number(m[2]) * 100 + Number((m[3] ?? "0").padEnd(2, "0"));
  return Number(m[1]) * 1000 + Number(`${m[2]}.${m[3] ?? "0"}`);
}

export function sensorsUseTrackChainage(sensors: Array<{ trackOrder?: number; km?: number; metre?: number }>, stepMetres = 25) {
  const ordered = sensors.filter((s) => s.trackOrder != null).sort((a, b) => (a.trackOrder ?? 0) - (b.trackOrder ?? 0));
  if (ordered.length < 2 || ordered.length !== sensors.length) return false;
  for (let i = 1; i < ordered.length; i++) {
    const prev = (ordered[i - 1].km ?? 0) * 1000 + (ordered[i - 1].metre ?? 0);
    const next = (ordered[i].km ?? 0) * 1000 + (ordered[i].metre ?? 0);
    if (next - prev > stepMetres * 1.5) return true;
  }
  return false;
}


/**
 * Dense track geometry survey for the km range chart: one row per measured position (every 25 cm),
 * per survey year. Rows of a year share index across km, metre and every channel's values.
 */
export interface IotProfile {
  channels: Record<string, IotChannel>;
  years: Record<string, { km: number[]; metre: number[]; values: Record<string, Array<number | null>> }>;
}

/** Track position in metres from km and metres ("281+066.25" → 281066.25). */
export function chainagePosition(km: number, metre: number): number {
  return km * 1000 + metre;
}

/** "281+066.25": km, then metres with three integer digits and two decimals. */
export function formatKmMetre(km: number, metre: number): string {
  return `${km}+${metre.toFixed(2).padStart(6, "0")}`;
}

/** A typed km / metre pair of the range chart → a track position; null when both are empty or unreadable. */
export function kmMetreInput(kmText: string, metreText: string, defaultKm: number): number | null {
  const num = (t: string) => {
    const v = t.trim().replace(",", ".");
    return v === "" ? undefined : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  };
  const km = num(kmText);
  const metre = num(metreText);
  if (km === undefined && metre === undefined) return null;
  if (Number.isNaN(km) || Number.isNaN(metre)) return null;
  return chainagePosition(km ?? defaultKm, metre ?? 0);
}

async function fetchJson(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  return response.json();
}

export class IoTDataView {
  sensors = new Map<string, IotSensorMeta>();
  channels = new Map<string, IotChannel>();
  samples: IotSamples | null = null;
  /** live: the IoT API; survey: the bundled 25 cm survey (iot-profile.json); sample: the 8-point demo. */
  source: "live" | "survey" | "sample" | "none" = "none";
  private profilePromise: Promise<IotProfile | null> | null = null;

  /**
   * The dense survey, loaded once: the live API's /profile, else the host's survey file
   * (configureIotProfile / VITE_IOT_PROFILE). Null when neither is set or answers.
   */
  loadProfile(): Promise<IotProfile | null> {
    this.profilePromise ??= (async () => {
      const urls = [...(iotApiBase ? [`${iotApiBase}/profile`] : []), ...(iotProfileUrl ? [iotProfileUrl] : [])];
      for (const url of urls) {
        try {
          const profile = (await fetchJson(url)) as IotProfile;
          if (profile?.years && Object.keys(profile.years).length) return profile;
        } catch {
          /* next source */
        }
      }
      return null;
    })();
    return this.profilePromise;
  }

  async init() {
    const base = iotApiBase;
    try {
      if (!base) throw new Error("IoT live API is not configured (configureIotApi / VITE_IOT_API)");
      const [sensors, channels, samples] = await Promise.all([
        fetchJson(`${base}/sensors`),
        fetchJson(`${base}/channels`),
        fetchJson(`${base}/samples`),
      ]);
      this._apply(sensors, channels, samples);
      this.source = "live";
    } catch (liveError) {
      // Only a configured API that fails is worth a warning; no API at all is the normal demo case.
      if (base) console.warn("IoT live API yok, örnek demiryolu verisi kullanılıyor:", liveError);
      // The host's survey makes every measured position a point (as the earlier viewer did); the
      // 8-point demo only when there is none.
      const profile = await this.loadProfile();
      if (profile) {
        this._applyProfile(profile);
        this.source = "survey";
        return;
      }
      const bundled = await fetchJson("/iot-sample.json");
      this._apply(bundled.sensors, bundled.channels, bundled.samples);
      this.source = "sample";
    }
  }

  /**
   * Survey → points: one per measured position (km + metre), its series one value per survey year
   * (dated mid-year, like the demo's). Positions missing in a year get null for that year.
   */
  private _applyProfile(profile: IotProfile) {
    const years = Object.keys(profile.years).map(Number).sort((a, b) => a - b);
    const sensors: Record<string, IotSensorMeta> = {};
    const data: Record<string, Record<string, Array<number | null>>> = {};
    const channelIds = Object.keys(profile.channels);
    years.forEach((year, yearIndex) => {
      const rows = profile.years[String(year)]!;
      for (let i = 0; i < rows.km.length; i++) {
        const km = rows.km[i]!;
        const metre = rows.metre[i]!;
        const id = `km-${km}-m-${metre.toFixed(2).padStart(6, "0")}`;
        if (!sensors[id]) {
          sensors[id] = { name: formatKmMetre(km, metre), groupName: String(km), km, metre, location: { x: 0, y: 0, z: 0 } };
          data[id] = Object.fromEntries(channelIds.map((c) => [c, Array<number | null>(years.length).fill(null)]));
        }
        for (const c of channelIds) data[id]![c]![yearIndex] = rows.values[c]?.[i] ?? null;
      }
    });
    this._apply(sensors, profile.channels, { timestamps: years.map((y) => `${y}-06-15T00:00:00Z`), data });
  }

  private _apply(sensors: Record<string, IotSensorMeta>, channels: Record<string, IotChannel>, samples: any) {
    this.sensors.clear();
    this.channels.clear();
    for (const [id, sensor] of Object.entries(sensors || {})) {
      this.sensors.set(id, {
        ...sensor,
        location: sensor.location || { x: 0, y: 0, z: 0 },
      });
    }
    for (const [id, channel] of Object.entries(channels || {})) {
      this.channels.set(id, channel);
    }
    this.samples = {
      timestamps: (samples?.timestamps || []).map((t: string) => new Date(t)),
      data: samples?.data || {},
    };
    this._normalizeChannelAliases();
    this._ensureAutodeskChannels();
  }

  /** Live IoT API / Autodesk export may use camelCase ids. */
  private _normalizeChannelAliases() {
    if (!this.samples) return;
    const aliasPairs: Array<[string, string]> = [
      ["longLevelLeft", "long_level_l"],
      ["long_level_left", "long_level_l"],
      ["longLevelRight", "long_level_r"],
      ["long_level_right", "long_level_r"],
      ["alignmentLeft", "alignment_l"],
      ["alignmentRight", "alignment_r"],
    ];
    for (const [from, to] of aliasPairs) {
      const channel = this.channels.get(from);
      if (channel && !this.channels.has(to)) {
        this.channels.set(to, { ...channel, name: channel.name || to });
        this.channels.delete(from);
      }
      for (const row of Object.values(this.samples.data)) {
        if (row[from] && !row[to]) {
          row[to] = row[from];
          delete row[from];
        }
      }
    }
  }

  private _ensureAutodeskChannels() {
    const extras: Record<string, IotChannel> = {
      alignment_r: {
        name: "Alignment (Sağ)",
        unit: "mm",
        min: -20,
        max: 20,
        limits: { AL: { min: -8, max: 8 }, IL: { min: -11, max: 11 }, IAL: { min: -17, max: 17 } },
      },
      alignment_l: {
        name: "Alignment (Sol)",
        unit: "mm",
        min: -20,
        max: 20,
        limits: { AL: { min: -8, max: 8 }, IL: { min: -11, max: 11 }, IAL: { min: -17, max: 17 } },
      },
      long_level_r: {
        name: "Long. Level (Sağ)",
        unit: "mm",
        min: -30,
        max: 30,
        limits: { AL: { min: -10, max: 10 }, IL: { min: -13, max: 13 }, IAL: { min: -26, max: 26 } },
      },
      long_level_l: {
        name: "Long. Level (Sol)",
        unit: "mm",
        min: -30,
        max: 30,
        limits: { AL: { min: -10, max: 10 }, IL: { min: -13, max: 13 }, IAL: { min: -26, max: 26 } },
      },
      twist: {
        name: "Twist",
        unit: "mm/m",
        min: -10,
        max: 10,
        limits: { AL: { min: -4, max: 4 }, IL: { min: -5, max: 5 }, IAL: { min: -7, max: 7 } },
      },
    };
    const sourceId = this.channels.has("cant") ? "cant" : [...this.channels.keys()][0];
    if (!sourceId || !this.samples) return;
    const scale: Record<string, number> = {
      alignment_r: 1.05,
      alignment_l: 0.82,
      long_level_r: 1.15,
      long_level_l: 0.9,
      twist: 0.38,
    };
    for (const [id, channel] of Object.entries(extras)) {
      if (!this.channels.has(id)) this.channels.set(id, channel);
      for (const [sensorId, row] of Object.entries(this.samples.data)) {
        if (row[id]) continue;
        const base = row[sourceId] || [];
        row[id] = base.map((v, i) =>
          v === null ? null : Number((v * (scale[id] || 1) + (i % 2 === 0 ? 0.4 : -0.3)).toFixed(2))
        );
      }
    }
  }

  getSample(sensorId: string, channelId: string, year = 2024): number | null {
    const values = this.samples?.data?.[sensorId]?.[channelId];
    if (!values || !this.samples) return null;
    const index = this.samples.timestamps.findIndex((t) => t.getFullYear() === year);
    const pick = index >= 0 ? index : values.length - 1;
    const value = values[pick];
    return value === null || value === undefined ? null : value;
  }

  toSceneSensors(
    box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
    channelId: string,
    year: number,
    remap = false,
    path?: Array<{ x: number; y: number; z: number }>
  ): IotSensor[] {
    const placed = path && path.length >= 2
      ? placeSensorsOnPath(this.sensors, path)
      : placeSensorsOnBox(this.sensors, box, remap);
    const channel = this.channels.get(channelId) || [...this.channels.values()][0];
    const resolvedChannel = channelId && this.channels.has(channelId) ? channelId : [...this.channels.keys()][0];
    const minKm = [...placed.values()].reduce((min, sensor) => Math.min(min, sensor.km ?? min), placed.values().next().value?.km ?? 0);
    return [...placed.entries()]
      .sort((a, b) => (a[1]._trackOrder ?? 0) - (b[1]._trackOrder ?? 0))
      .map(([id, sensor]) => {
        const value = this.getSample(id, resolvedChannel, year);
        const trackOrder = sensor._trackOrder;
        return {
          id,
          name:
            trackOrder != null
              ? formatRailChainageLabel(minKm, trackOrder)
              : sensor.name || `${sensor.km ?? "?"}+${(sensor.metre ?? 0).toFixed(2)}`,
          groupName: sensor.groupName || String(sensor.km ?? "hat"),
          channel: resolvedChannel,
          channelLabel: channel?.name || resolvedChannel,
          unit: channel?.unit || "",
          value,
          status: statusFromLimits(value, channel?.limits),
          position: [sensor.location.x, sensor.location.y, sensor.location.z] as [number, number, number],
          km: sensor.km,
          metre: sensor.metre,
          trackOrder,
          timestamps: this.samples?.timestamps || [],
          series: this.samples?.data?.[id]?.[resolvedChannel] || [],
          limits: channel?.limits,
        };
      });
  }
}

function trackSortValue(sensor: IotSensorMeta) {
  return sensor._trackOrder ?? (sensor.km ?? 0) * 1000 + (sensor.metre ?? 0);
}

function pathLengths(path: Array<{ x: number; y: number; z: number }>) {
  const lengths = [0];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(
      path[i].x - path[i - 1].x,
      path[i].y - path[i - 1].y,
      path[i].z - path[i - 1].z
    );
    lengths.push(total);
  }
  return { lengths, total };
}

function pointAtPathT(
  path: Array<{ x: number; y: number; z: number }>,
  lengths: number[],
  total: number,
  t: number
) {
  const target = Math.max(0, Math.min(1, t)) * total;
  let index = 1;
  while (index < lengths.length && lengths[index] < target) index += 1;
  const start = path[index - 1];
  const end = path[Math.min(index, path.length - 1)];
  const segment = lengths[index] - lengths[index - 1] || 1;
  const u = (target - lengths[index - 1]) / segment;
  return {
    x: start.x + (end.x - start.x) * u,
    y: start.y + (end.y - start.y) * u + 0.45,
    z: start.z + (end.z - start.z) * u,
  };
}

export function placeSensorsOnPath(
  sensors: Map<string, IotSensorMeta>,
  path: Array<{ x: number; y: number; z: number }>
): Map<string, IotSensorMeta> {
  const entries = [...sensors.entries()].sort((a, b) => trackSortValue(a[1]) - trackSortValue(b[1]));
  const { lengths, total } = pathLengths(path);
  const next = new Map<string, IotSensorMeta>();
  const last = Math.max(entries.length - 1, 1);
  entries.forEach(([id, sensor], i) => {
    // Örnek veride km 281 → 282 bir kilometre atlıyor; bunu kullanırsak
    // 4 nokta başta, 4 nokta sonda kümelenir. Hat boyunca eşit aralık kullan.
    const t = i / last;
    next.set(id, { ...sensor, location: pointAtPathT(path, lengths, total, t) });
  });
  return next;
}

export function placeSensorsOnBox(
  sensors: Map<string, IotSensorMeta>,
  box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
  remap = false
): Map<string, IotSensorMeta> {
  const entries = [...sensors.entries()].sort(
    (a, b) => (a[1]._trackOrder ?? (a[1].km ?? 0) * 1000 + (a[1].metre ?? 0))
      - (b[1]._trackOrder ?? (b[1].km ?? 0) * 1000 + (b[1].metre ?? 0))
  );
  const hasReal = entries.some(([, s]) => s.location.x || s.location.y || s.location.z);
  if (hasReal && !remap) return sensors;

  const next = new Map<string, IotSensorMeta>();
  const last = Math.max(entries.length - 1, 1);
  entries.forEach(([id, sensor], i) => {
    const t = i / last;
    next.set(id, {
      ...sensor,
      location: {
        x: box.min.x + (box.max.x - box.min.x) * t,
        y: box.min.y + (box.max.y - box.min.y) * 0.55,
        z: box.min.z + (box.max.z - box.min.z) * t,
      },
    });
  });
  return next;
}
