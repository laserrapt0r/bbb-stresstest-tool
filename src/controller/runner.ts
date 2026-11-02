import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { BbbClient, encodeQuery, signQuery, type MeetingInfo, type PresentationSource } from '../shared/bbbApi.js';
import { evaluateStep, type StepResult } from '../shared/evaluate.js';
import { t } from '../shared/i18n.js';
import { buildSlots, usersPerStep, type Slot } from '../shared/plan.js';
import type { Assignment, BotCommand, BotNetwork, BotSample, BotState, Heartbeat } from '../shared/protocol.js';
import type { Scenario } from '../shared/scenario.js';
import { joinUserdata } from '../bot/userdata.js';
import type { BotBackend } from './backend.js';
import type { SelfTestResult } from './selftest.js';
import type { Target } from './config.js';

export type RunPhase = 'starting' | 'waiting-for-bots' | 'running' | 'stopping' | 'finished';
export type RunOutcome = 'completed' | 'limit-found' | 'invalid' | 'aborted' | 'error';

export interface StepRecord extends StepResult {
  /** Values of the Prometheus rules at the end of the step. */
  serverMetrics?: { name: string; value: number; max: number }[];
  usersPerMeeting: number;
  totalUsers: number;
  meetingInfo: MeetingInfo[];
  startedAt: string;
  finishedAt: string;
}

export interface RunRecord {
  id: string;
  createdAt: string;
  finishedAt?: string;
  scenario: Scenario;
  /** The test series this run belongs to. */
  seriesId?: string;
  /** Marks a self-test run, with its result once it finished. */
  kind?: 'selftest';
  selfTest?: SelfTestResult;
  missingSelectors?: string[];
  /** Summary of what the bots reported as errors. */
  botErrors?: string;
  phase: RunPhase;
  outcome?: RunOutcome;
  message?: string;
  /** Highest users per meeting whose step passed. */
  capacityUsers?: number;
  steps: StepRecord[];
  log: { at: string; text: string }[];
}

interface LiveBot {
  botId: string;
  slot: Slot | undefined;
  state: BotState;
  error?: string;
  joinSeconds?: number;
  activated: boolean;
  delivered: boolean;
  lastSeen: number;
}

export interface LiveStatus {
  registered: number;
  expected: number;
  byState: Record<string, number>;
  currentStep?: number;
  stepCount: number;
  usersPerMeeting?: number;
  stepPhase?: string;
  /** Rolling values of the last minute, for the metrics endpoint. */
  quality?: StepResult;
}

const MAX_RUN_EXTRA_SECONDS = 1800;
const BOT_SILENCE_MS = 45_000;
const JOIN_TIMEOUT_MS = 240_000;
const LIVE_WINDOW_MS = 60_000;

export class Run {
  readonly token = randomBytes(24).toString('hex');
  readonly record: RunRecord;
  private readonly bots = new Map<string, LiveBot>();
  private readonly slots: Slot[];
  private readonly joinQueue: LiveBot[] = [];
  private samples: { botId: string; sample: BotSample }[] = [];
  private recent: { at: number; botId: string; sample: BotSample }[] = [];
  private collecting = false;
  private abortRequested = false;
  private readonly moderatorPw = randomBytes(8).toString('hex');
  private readonly attendeePw = randomBytes(8).toString('hex');
  private readonly bbb: BbbClient;
  private readonly fullScenario: Scenario;
  private live: { step?: number; users?: number; phase?: string } = {};

  constructor(
    scenario: Scenario,
    private readonly target: Target,
    private readonly backend: BotBackend,
    private readonly persist: (r: RunRecord) => Promise<void>,
    private readonly opts: {
      botStartTimeoutSeconds: number;
      prometheusUrl?: string;
      seriesId?: string;
      /** Set for self-tests: bots report missing UI elements and this evaluates the result. */
      selfTest?: (record: RunRecord) => SelfTestResult;
    },
  ) {
    const now = new Date();
    this.record = {
      id: `${now.toISOString().slice(0, 19).replace(/[-:T]/g, '').toLowerCase()}-${randomBytes(2).toString('hex')}`,
      createdAt: now.toISOString(),
      // The file can be large and the record gets listed often. Its name is enough for reports.
      scenario: withoutFileContent(scenario),
      ...(opts.seriesId ? { seriesId: opts.seriesId } : {}),
      ...(opts.selfTest ? { kind: 'selftest' as const } : {}),
      phase: 'starting',
      steps: [],
      log: [],
    };
    this.fullScenario = scenario;
    this.slots = buildSlots(scenario);
    this.bbb = new BbbClient({
      apiUrl: target.apiUrl,
      secret: target.secret,
      checksum: target.checksum,
      ...(target.proxy ? { proxy: target.proxy } : {}),
    });
  }

  get id(): string {
    return this.record.id;
  }

  get finished(): boolean {
    return this.record.phase === 'finished';
  }

  private log(text: string): void {
    this.record.log.push({ at: new Date().toISOString(), text });
    console.log(`[${this.id}] ${text}`);
    // A full disk must not end a measurement that is still running.
    this.persist(this.record).catch((err) => console.error(t('run.notSaved', { error: String(err) })));
  }

  private liveQuality(): StepResult | undefined {
    const since = Date.now() - LIVE_WINDOW_MS;
    this.recent = this.recent.filter((entry) => entry.at >= since);
    if (this.recent.length === 0) return undefined;
    const bots = [...this.bots.values()];
    return evaluateStep(
      {
        expectedBots: bots.filter((b) => b.activated).length,
        failedBots: bots.filter((b) => b.state === 'failed').length,
        lostBots: bots.filter((b) => b.state === 'lost').length,
        joinSeconds: bots.flatMap((b) => (b.joinSeconds !== undefined ? [b.joinSeconds] : [])),
        samples: this.recent,
        windowSeconds: LIVE_WINDOW_MS / 1000,
        prometheus: [],
        expect: { audio: false, video: false },
      },
      this.record.scenario.slo,
    );
  }

  status(): LiveStatus {
    const byState: Record<string, number> = {};
    for (const bot of this.bots.values()) byState[bot.state] = (byState[bot.state] ?? 0) + 1;
    const quality = this.liveQuality();
    return {
      registered: this.bots.size,
      expected: this.slots.length,
      byState,
      stepCount: usersPerStep(this.record.scenario.load).length,
      ...(this.live.step !== undefined ? { currentStep: this.live.step } : {}),
      ...(this.live.users !== undefined ? { usersPerMeeting: this.live.users } : {}),
      ...(this.live.phase !== undefined ? { stepPhase: this.live.phase } : {}),
      ...(quality ? { quality } : {}),
    };
  }

  stop(): void {
    this.abortRequested = true;
  }

  private meetingId(meeting: number): string {
    return `stress-${this.id}-m${meeting}`;
  }

  private assignment(slot: Slot): Assignment {
    const params: Record<string, string> = {
      fullName: `${slot.role.name}-${slot.meeting}-${slot.seat}`,
      meetingID: this.meetingId(slot.meeting),
      password: slot.role.moderator ? this.moderatorPw : this.attendeePw,
      userID: `stress-${this.id}-${slot.id}`,
      redirect: 'true',
      ...joinUserdata(slot.role),
    };
    const query = encodeQuery(params);
    const checksum = signQuery('join', query, this.target.secret, this.target.checksum);
    const network: BotNetwork = {
      ignoreTlsErrors: this.target.ignoreTlsErrors,
      extraChromiumArgs: this.target.extraChromiumArgs,
      ...(this.target.proxy ? { proxy: this.target.proxy } : {}),
      ...(this.target.webrtcIpPolicy ? { webrtcIpPolicy: this.target.webrtcIpPolicy } : {}),
    };
    return {
      joinUrl: `${this.target.apiUrl.replace(/\/+$/, '')}/join?${query}&checksum=${checksum}`,
      role: slot.role,
      network,
      ...(this.opts.selfTest ? { probe: true } : {}),
    };
  }

  /** Called for each bot request. Bots hold no state about the plan. */
  heartbeat(hb: Heartbeat): BotCommand {
    let bot = this.bots.get(hb.botId);
    if (!bot) {
      const taken = new Set([...this.bots.values()].map((b) => b.slot?.id));
      const slot = this.slots.find((s) => !taken.has(s.id));
      bot = { botId: hb.botId, slot, state: 'idle', activated: false, delivered: false, lastSeen: Date.now() };
      this.bots.set(hb.botId, bot);
    }
    bot.lastSeen = Date.now();
    bot.state = hb.state;
    if (hb.error) bot.error = hb.error;
    if (hb.joinSeconds !== undefined) bot.joinSeconds = hb.joinSeconds;
    if (hb.missingSelectors?.length) {
      this.record.missingSelectors = [...new Set([...(this.record.missingSelectors ?? []), ...hb.missingSelectors])];
    }
    if (hb.sample && bot.state === 'joined') {
      this.recent.push({ at: Date.now(), botId: bot.botId, sample: hb.sample });
      if (this.collecting) this.samples.push({ botId: bot.botId, sample: hb.sample });
    }

    if (!bot.slot || this.record.phase === 'stopping' || this.finished) return { command: 'stop' };
    if (bot.activated && !bot.delivered) {
      bot.delivered = true;
      return { command: 'join', assignment: this.assignment(bot.slot), pollMs: 5000 };
    }
    return bot.delivered ? { command: 'continue', pollMs: 5000 } : { command: 'wait', pollMs: 1000 };
  }

  private activeBots(step: number): LiveBot[] {
    return [...this.bots.values()].filter((b) => b.slot && b.slot.step <= step);
  }

  private checkAbort(): void {
    if (this.abortRequested) throw new AbortError();
  }

  private async pause(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      this.checkAbort();
      await sleep(Math.min(500, ms));
    }
  }

  private async waitForBots(): Promise<void> {
    this.record.phase = 'waiting-for-bots';
    this.log(t('run.waiting', { count: this.slots.length }));
    const deadline = Date.now() + this.opts.botStartTimeoutSeconds * 1000;
    while (this.bots.size < this.slots.length) {
      if (Date.now() > deadline) {
        throw new Error(
          t('run.tooFewBots', { started: this.bots.size, expected: this.slots.length }),
        );
      }
      await this.pause(1000);
    }
    this.log(t('run.ready'));
  }

  private async createMeetings(): Promise<void> {
    const scenario = this.fullScenario;
    const maxMinutes = Math.ceil(maxRunSeconds(scenario) / 60);
    for (let m = 0; m < scenario.meetings; m++) {
      await this.bbb.create(
        {
          name: t('run.meetingName', { name: scenario.name, number: m + 1 }),
          meetingID: this.meetingId(m),
          moderatorPW: this.moderatorPw,
          attendeePW: this.attendeePw,
          record: 'false',
          // The server ends the meeting even if the controller dies.
          duration: String(maxMinutes),
          ...scenario.meeting.createParams,
        },
        presentationOf(scenario),
      );
    }
    this.log(t('run.meetingsCreated', { count: scenario.meetings }));
  }

  private async activateStep(step: number): Promise<void> {
    const load = this.record.scenario.load;
    const pending = [...this.bots.values()]
      .filter((b) => b.slot?.step === step)
      .sort((a, b) => (a.slot?.seat ?? 0) - (b.slot?.seat ?? 0));
    const gapMs = 1000 / load.joinPerSecond;
    for (const bot of pending) {
      this.checkAbort();
      bot.activated = true;
      await sleep(gapMs);
    }
  }

  private async waitForJoins(step: number): Promise<void> {
    const deadline = Date.now() + JOIN_TIMEOUT_MS;
    for (;;) {
      this.markSilentBots();
      const open = this.activeBots(step).filter((b) => b.state === 'idle' || b.state === 'joining');
      if (open.length === 0) return;
      if (Date.now() > deadline) {
        for (const bot of open) {
          bot.state = 'failed';
          bot.error = t('run.joinTimeout');
        }
        return;
      }
      await this.pause(1000);
    }
  }

  private markSilentBots(): void {
    const limit = Date.now() - BOT_SILENCE_MS;
    for (const bot of this.bots.values()) {
      if (bot.lastSeen < limit && bot.state !== 'lost' && bot.state !== 'stopped') {
        bot.state = 'lost';
        bot.error ??= t('run.botSilent');
      }
    }
  }

  private async prometheusValues() {
    const { prometheusUrl } = this.opts;
    const rules = this.record.scenario.slo.prometheus;
    if (!prometheusUrl || rules.length === 0) return [];
    const values: { name: string; value: number; max: number }[] = [];
    for (const rule of rules) {
      try {
        const url = `${prometheusUrl.replace(/\/+$/, '')}/api/v1/query?query=${encodeURIComponent(rule.query)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        const body = (await res.json()) as { data?: { result?: { value?: [number, string] }[] } };
        const raw = body.data?.result?.[0]?.value?.[1];
        if (raw === undefined) this.log(t('run.promNoValue', { name: rule.name }));
        else values.push({ name: rule.name, value: Number(raw), max: rule.max });
      } catch (err) {
        this.log(t('run.promFailed', { name: rule.name, error: String(err) }));
      }
    }
    return values;
  }

  private async meetingInfos(): Promise<MeetingInfo[]> {
    const infos: MeetingInfo[] = [];
    for (let m = 0; m < this.record.scenario.meetings; m++) {
      const info = await this.bbb.getMeetingInfo(this.meetingId(m)).catch(() => undefined);
      if (info) infos.push(info);
    }
    return infos;
  }

  private async runStep(step: number, users: number): Promise<StepRecord> {
    const { load, slo, meetings } = this.record.scenario;
    const startedAt = new Date().toISOString();
    this.live = { step, users, phase: t('phase.join') };
    this.log(t('run.step', { step: step + 1, users }));
    await this.activateStep(step);
    await this.waitForJoins(step);

    this.live.phase = t('phase.settle');
    await this.pause(load.settleSeconds * 1000);

    this.live.phase = t('phase.measure');
    this.samples = [];
    this.collecting = true;
    await this.pause(load.holdSeconds * 1000);
    this.collecting = false;
    this.markSilentBots();

    const active = this.activeBots(step);
    const meetingInfo = await this.meetingInfos();
    const seats = this.slots.filter((s) => s.step <= step);
    const serverMetrics = await this.prometheusValues();
    const result = evaluateStep(
      {
        expectedBots: users * meetings,
        failedBots: active.filter((b) => b.state === 'failed').length + (users * meetings - active.length),
        lostBots: active.filter((b) => b.state === 'lost').length,
        joinSeconds: active.flatMap((b) => (b.joinSeconds !== undefined ? [b.joinSeconds] : [])),
        samples: this.samples,
        windowSeconds: load.holdSeconds,
        prometheus: serverMetrics,
        expect: {
          // Only a speaker guarantees packets: LiveKit stays silent while nobody talks.
          audio: seats.length > 1 && seats.some((s) => s.role.audio === 'microphone' && !s.role.muted),
          // Everybody but the sender sees a stream, so one sender needs a second seat.
          video: seats.length > 1 && seats.some((s) => s.role.webcam || s.role.screenshare),
        },
        ...(meetingInfo.length === meetings
          ? {
              bbb: {
                participants: meetingInfo.reduce((t, m) => t + m.participantCount, 0),
                expectedParticipants: users * meetings,
                videos: meetingInfo.reduce((t, m) => t + m.videoCount, 0),
                expectedVideos: seats.filter((s) => s.role.webcam).length,
              },
            }
          : {}),
      },
      slo,
    );
    return {
      ...result,
      ...(serverMetrics.length ? { serverMetrics } : {}),
      usersPerMeeting: users,
      totalUsers: users * meetings,
      meetingInfo,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  private failureSummary(): string {
    const errors = new Map<string, number>();
    for (const bot of this.bots.values()) {
      if (bot.error) errors.set(bot.error, (errors.get(bot.error) ?? 0) + 1);
    }
    return [...errors].map(([e, n]) => `${n}x ${e}`).join('; ');
  }

  /** Never rejects. All cleanup happens here, also after errors and aborts. */
  async execute(): Promise<void> {
    const { scenario } = this.record;
    let outcome: RunOutcome = 'completed';
    try {
      await this.backend.start({
        id: this.id,
        token: this.token,
        bots: this.slots.length,
        scenario,
        maxSeconds: maxRunSeconds(scenario),
      });
      await this.waitForBots();
      await this.createMeetings();
      this.record.phase = 'running';

      for (const [step, users] of usersPerStep(scenario.load).entries()) {
        const record = await this.runStep(step, users);
        this.record.steps.push(record);
        await this.persist(this.record);
        const verdict = `${record.verdict}${record.reasons.length ? ` (${record.reasons.join('; ')})` : ''}`;
        this.log(t('run.stepResult', { step: step + 1, verdict }));
        if (record.verdict === 'invalid') {
          outcome = 'invalid';
          this.record.message = t('run.generatorBottleneck');
          break;
        }
        if (record.verdict === 'fail') {
          outcome = 'limit-found';
          break;
        }
        this.record.capacityUsers = users;
      }
    } catch (err) {
      if (err instanceof AbortError) {
        outcome = 'aborted';
        this.record.message = t('run.aborted');
      } else {
        outcome = 'error';
        this.record.message = describeError(err);
      }
      this.log(t('run.abort', { message: this.record.message ?? '' }));
    }

    const failures = this.failureSummary();
    if (failures) {
      this.record.botErrors = failures;
      this.log(t('run.botErrors', { errors: failures }));
    }
    await this.teardown();
    this.record.outcome = outcome;
    this.record.finishedAt = new Date().toISOString();
    if (this.opts.selfTest) this.record.selfTest = this.opts.selfTest(this.record);
    this.record.phase = 'finished';
    this.log(t('run.finished', { outcome }));
    await this.persist(this.record);
  }

  private async teardown(): Promise<void> {
    this.record.phase = 'stopping';
    this.collecting = false;
    for (let m = 0; m < this.record.scenario.meetings; m++) {
      await this.bbb.end(this.meetingId(m), this.moderatorPw).catch(() => undefined);
    }
    // Bots pick up the stop with their next heartbeat, then the job gets removed.
    await sleep(7000);
    await this.backend.stop(this.id).catch((err) => this.log(t('run.botsNotRemoved', { error: String(err) })));
  }
}

class AbortError extends Error {}

function withoutFileContent(scenario: Scenario): Scenario {
  const file = scenario.meeting.presentationFile;
  if (!file) return scenario;
  return { ...scenario, meeting: { ...scenario.meeting, presentationFile: { name: file.name, base64: '' } } };
}

function presentationOf({ meeting }: Scenario): PresentationSource | undefined {
  if (meeting.presentationFile) return meeting.presentationFile;
  return meeting.presentationUrl ? { url: meeting.presentationUrl } : undefined;
}

/** fetch() only says "fetch failed", the reason sits in the cause. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? `: ${err.cause.message}` : '';
  return `${err.message}${cause}`;
}

export function maxRunSeconds(s: Scenario): number {
  const steps = usersPerStep(s.load).length;
  const perStep = s.load.holdSeconds + s.load.settleSeconds + JOIN_TIMEOUT_MS / 1000;
  return steps * perStep + (usersPerStep(s.load).at(-1) ?? 0) * s.meetings / s.load.joinPerSecond + MAX_RUN_EXTRA_SECONDS;
}
