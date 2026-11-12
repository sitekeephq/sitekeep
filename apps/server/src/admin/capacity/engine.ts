/**
 * A capacity test engine measures; CapacityRuns (runs.ts) owns the run record, one-at-a-time and
 * cancelling. Engines: DemoEngine (sample data, today). QuickCheckEngine and LoadTestEngine
 * (docs/onprem/capacity.md §4, §12) plug in behind the same interface.
 */
import type { CapacityCheck, CapacityHardware, CapacityRunDto, CapacityRunMode, CapacitySample, CapacityStep } from "@sitekeep/shared";
import type { Msg } from "../../i18n/index.js";

/** A check with its texts as Msg: runs.ts renders them in the language of whoever views the run. */
export type CapacityEngineCheck = Omit<CapacityCheck, "label" | "value"> & { label: Msg; value: Msg | null };

export interface CapacityEngineContext {
  mode: CapacityRunMode;
  hardware: CapacityHardware;
  /** Aborted when the administrator presses Durdur. */
  signal: AbortSignal;
  setStage(stage: Msg, progress: number): void;
  setCheck(check: CapacityEngineCheck): void;
  sample(sample: CapacitySample): void;
  step(step: CapacityStep): void;
}

export interface CapacityEngineResult {
  status: "passed" | "limited";
  result: Omit<NonNullable<CapacityRunDto["result"]>, "stopReason"> & { stopReason: Msg | null };
}

export interface CapacityEngine {
  /** True when nothing is really measured: the run is labelled "örnek veri". */
  readonly demo: boolean;
  run(ctx: CapacityEngineContext): Promise<CapacityEngineResult>;
}

/** Waits, or rejects with an AbortError when the run is cancelled. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("cancelled", "AbortError"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("cancelled", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
