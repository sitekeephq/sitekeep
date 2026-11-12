export type SensorStatus = "ok" | "warn" | "alarm";

export interface LimitBand {
  min: number;
  max: number;
}

export interface IotSensor {
  id: string;
  name: string;
  groupName: string;
  channel: string;
  channelLabel: string;
  unit: string;
  value: number | null;
  status: SensorStatus;
  position: [number, number, number];
  km?: number;
  metre?: number;
  /** Hat boyunca sıra (km aralığı grafiği için). */
  trackOrder?: number;
  timestamps: Date[];
  series: Array<number | null>;
  limits?: {
    AL?: LimitBand;
    IL?: LimitBand;
    IAL?: LimitBand;
  };
}

export function statusFromLimits(value: number | null, limits?: IotSensor["limits"]): SensorStatus {
  if (value === null || !limits) return "ok";
  if (limits.IAL && (value < limits.IAL.min || value > limits.IAL.max)) return "alarm";
  if (limits.IL && (value < limits.IL.min || value > limits.IL.max)) return "alarm";
  if (limits.AL && (value < limits.AL.min || value > limits.AL.max)) return "warn";
  return "ok";
}
