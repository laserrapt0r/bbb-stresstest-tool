import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { t } from '../shared/i18n.js';
import type { Scenario } from '../shared/scenario.js';
import type { RunOutcome } from './runner.js';

export const seriesRequestSchema = z.object({
  name: z.string().min(1).max(100),
  scenarios: z.array(z.string().min(1)).min(1).max(20),
  /** Gives the server time to calm down, so one run does not leak into the next. */
  pauseSeconds: z.number().int().min(0).max(3600).default(120),
  continueOnError: z.boolean().default(false),
  /** Proves each target with two bots before the first run starts many. */
  selfTest: z.boolean().default(false),
});
export type SeriesRequest = z.infer<typeof seriesRequestSchema>;

export type SeriesState = 'running' | 'finished' | 'aborted' | 'error';

export interface SeriesRecord {
  id: string;
  name: string;
  createdAt: string;
  finishedAt?: string;
  scenarios: string[];
  pauseSeconds: number;
  continueOnError: boolean;
  selfTest: boolean;
  state: SeriesState;
  /** Scenario being run or paused before, zero-based. */
  position: number;
  pausing: boolean;
  runIds: string[];
  selfTestRunIds: string[];
  message?: string;
}

/** What the series needs from the controller, which keeps this class testable. */
export interface RunStarter {
  start(scenario: Scenario, seriesId: string): Promise<{ id: string; done: Promise<RunOutcome>; stop(): void }>;
  selfTest(target: string, seriesId: string): Promise<{ id: string; done: Promise<boolean>; stop(): void }>;
}

export class Series {
  readonly record: SeriesRecord;
  private stopRequested = false;
  private current: { stop(): void } | undefined;

  constructor(
    request: SeriesRequest,
    private readonly scenarios: Scenario[],
    private readonly starter: RunStarter,
    private readonly persist: (s: SeriesRecord) => Promise<void>,
  ) {
    const now = new Date();
    this.record = {
      id: `${now.toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${randomBytes(2).toString('hex')}`,
      name: request.name,
      createdAt: now.toISOString(),
      scenarios: request.scenarios,
      pauseSeconds: request.pauseSeconds,
      continueOnError: request.continueOnError,
      selfTest: request.selfTest,
      state: 'running',
      position: 0,
      pausing: false,
      runIds: [],
      selfTestRunIds: [],
    };
  }

  get id(): string {
    return this.record.id;
  }

  stop(): void {
    this.stopRequested = true;
    this.current?.stop();
  }

  private save(): void {
    this.persist(this.record).catch((err) => console.error(t('run.notSaved', { error: String(err) })));
  }

  private async pause(): Promise<void> {
    this.record.pausing = true;
    this.save();
    const until = Date.now() + this.record.pauseSeconds * 1000;
    while (Date.now() < until && !this.stopRequested) await sleep(Math.min(250, this.record.pauseSeconds * 1000));
    this.record.pausing = false;
  }

  private finish(state: SeriesState, message?: string): void {
    this.record.state = state;
    if (message) this.record.message = message;
    this.record.finishedAt = new Date().toISOString();
    this.current = undefined;
    this.save();
  }

  /** True if all targets passed. A failed self-test ends the series before any large run. */
  private async runSelfTests(): Promise<boolean> {
    for (const target of new Set(this.scenarios.map((s) => s.target))) {
      if (this.stopRequested) return false;
      try {
        const test = await this.starter.selfTest(target, this.id);
        this.current = test;
        this.record.selfTestRunIds.push(test.id);
        this.save();
        const passed = await test.done;
        this.current = undefined;
        if (!passed) {
          this.finish('error', t('series.selfTestFailed', { target }));
          return false;
        }
      } catch (err) {
        this.finish('error', t('series.selfTestFailed', { target }) + `: ${String(err)}`);
        return false;
      }
    }
    return true;
  }

  /** Never rejects. A failed start ends the series instead of skipping silently. */
  async execute(): Promise<void> {
    if (this.record.selfTest && !(await this.runSelfTests())) {
      if (this.record.state === 'running') this.finish('aborted', t('series.aborted'));
      return;
    }
    for (const [position, scenario] of this.scenarios.entries()) {
      if (this.stopRequested) return this.finish('aborted', t('series.aborted'));
      this.record.position = position;
      if (position > 0) {
        await this.pause();
        if (this.stopRequested) return this.finish('aborted', t('series.aborted'));
      }

      let outcome: RunOutcome;
      try {
        const run = await this.starter.start(scenario, this.id);
        this.current = run;
        this.record.runIds.push(run.id);
        this.save();
        outcome = await run.done;
        this.current = undefined;
      } catch (err) {
        return this.finish('error', t('series.skippedBusy', { name: scenario.name, error: String(err) }));
      }

      if (this.stopRequested || outcome === 'aborted') return this.finish('aborted', t('series.aborted'));
      if (outcome === 'error' && !this.record.continueOnError) {
        return this.finish('error', t('series.stoppedOnError', { name: scenario.name }));
      }
    }
    this.finish('finished');
  }
}
