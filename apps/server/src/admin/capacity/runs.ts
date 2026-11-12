/**
 * Capacity test runs: one at a time per installation, cancellable, the last RUN_HISTORY kept.
 * Runs live in memory for now (a restart forgets them); the capacity_runs table replaces the
 * Map without changing the API (docs/onprem/kapasite.md §12).
 */
import { randomUUID } from "node:crypto";
import type { CapacityFinding, CapacityHardware, CapacityRunDto, CapacityRunMode } from "@sitekeep/shared";
import { conflict } from "../../core/platform/http.js";
import { DEFAULT_LANGUAGE, msg, render, type Msg } from "../../i18n/index.js";
import type { CapacityEngine } from "./engine.js";

/** The run's texts as Msg; the record holds them in the installation's language, view() in the reader's. */
interface RunTexts {
  stage: Msg;
  checks: Map<string, { label: Msg; value: Msg | null }>;
  stopReason: Msg | null;
}

const RUN_HISTORY = 20;
/** The screen polls once a second; a load test keeps at most this many points. */
const MAX_SAMPLES = 1800;

export class CapacityRuns {
  private readonly runs = new Map<string, CapacityRunDto>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly texts = new Map<string, RunTexts>();
  private readonly findings = new Map<string, (lang: string) => CapacityFinding[]>();
  private active: Promise<void> | null = null;

  constructor(
    private readonly engine: CapacityEngine,
    /** Findings for a finished run (evaluateCapacity with the current counts), in a language. */
    private readonly evaluate: (run: CapacityRunDto) => Promise<(lang: string) => CapacityFinding[]>,
  ) {}

  get running(): CapacityRunDto | null {
    return [...this.runs.values()].find((r) => r.status === "running") ?? null;
  }

  /** Newest first. */
  list(): CapacityRunDto[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): CapacityRunDto | null {
    return this.runs.get(id) ?? null;
  }

  /** The run with its stage, checks and stop reason in `lang` (the viewer's language). */
  view(run: CapacityRunDto, lang: string): CapacityRunDto {
    const findings = this.findings.get(run.id);
    if (findings) run = { ...run, findings: findings(lang) };
    const tx = this.texts.get(run.id);
    if (!tx) return run;
    return {
      ...run,
      stage: render(lang, tx.stage),
      checks: run.checks.map((c) => {
        const m = tx.checks.get(c.key);
        return m ? { ...c, label: render(lang, m.label), value: m.value ? render(lang, m.value) : null } : c;
      }),
      result: run.result && tx.stopReason ? { ...run.result, stopReason: render(lang, tx.stopReason) } : run.result,
    };
  }

  private setStage(run: CapacityRunDto, stage: Msg) {
    const tx = this.texts.get(run.id);
    if (tx) tx.stage = stage;
    run.stage = render(DEFAULT_LANGUAGE, stage);
  }

  /** Latest run that produced a result (cancelled and failed runs do not count as a test). */
  lastFinished(): CapacityRunDto | null {
    return this.list().find((r) => r.status === "passed" || r.status === "limited") ?? null;
  }

  start(input: { mode: CapacityRunMode; hardware: CapacityHardware; startedBy: string | null; appVersion: string | null }): CapacityRunDto {
    if (this.running) throw conflict(msg("admin:errors.runActive"));
    const run: CapacityRunDto = {
      id: randomUUID(),
      mode: input.mode,
      status: "running",
      demo: this.engine.demo,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      startedBy: input.startedBy,
      progress: 0,
      stage: render(DEFAULT_LANGUAGE, msg("admin:capacity.stage.starting")),
      hardware: input.hardware,
      appVersion: input.appVersion,
      checks: [],
      samples: [],
      steps: [],
      result: null,
      findings: [],
    };
    this.runs.set(run.id, run);
    this.texts.set(run.id, { stage: msg("admin:capacity.stage.starting"), checks: new Map(), stopReason: null });
    this.trim();
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    this.active = this.execute(run, controller.signal).finally(() => {
      this.controllers.delete(run.id);
      this.active = null;
    });
    return run;
  }

  cancel(id: string): CapacityRunDto | null {
    const run = this.runs.get(id);
    if (!run) return null;
    this.controllers.get(id)?.abort();
    return run;
  }

  /** Tests and shutdown: wait for the running test. */
  async settle(): Promise<void> {
    await this.active;
  }

  private async execute(run: CapacityRunDto, signal: AbortSignal) {
    try {
      const outcome = await this.engine.run({
        mode: run.mode,
        hardware: run.hardware,
        signal,
        setStage: (stage, progress) => {
          this.setStage(run, stage);
          run.progress = Math.max(run.progress, Math.min(1, progress));
        },
        setCheck: (check) => {
          this.texts.get(run.id)?.checks.set(check.key, { label: check.label, value: check.value });
          const rendered = { ...check, label: render(DEFAULT_LANGUAGE, check.label), value: check.value ? render(DEFAULT_LANGUAGE, check.value) : null };
          const i = run.checks.findIndex((c) => c.key === check.key);
          if (i >= 0) run.checks[i] = rendered;
          else run.checks.push(rendered);
        },
        sample: (sample) => {
          run.samples.push(sample);
          if (run.samples.length > MAX_SAMPLES) run.samples.shift();
        },
        step: (step) => void run.steps.push(step),
      });
      run.status = outcome.status;
      const tx = this.texts.get(run.id);
      if (tx) tx.stopReason = outcome.result.stopReason;
      run.result = { ...outcome.result, stopReason: outcome.result.stopReason ? render(DEFAULT_LANGUAGE, outcome.result.stopReason) : null };
      run.progress = 1;
    } catch (err) {
      const cancelled = signal.aborted || (err as Error).name === "AbortError";
      run.status = cancelled ? "cancelled" : "failed";
      this.setStage(run, cancelled ? msg("admin:capacity.stage.stopped") : msg("admin:capacity.stage.error", { message: (err as Error).message }));
    }
    run.finishedAt = new Date().toISOString();
    if (run.status === "passed" || run.status === "limited") {
      const findings = await this.evaluate(run).catch(() => null);
      if (findings) {
        this.findings.set(run.id, findings);
        run.findings = findings(DEFAULT_LANGUAGE);
      }
    }
  }

  private trim() {
    const old = this.list().slice(RUN_HISTORY);
    for (const r of old)
      if (r.status !== "running") {
        this.runs.delete(r.id);
        this.texts.delete(r.id);
        this.findings.delete(r.id);
      }
  }
}
