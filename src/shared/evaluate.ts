import { t } from './i18n.js';
import type { Slo } from './scenario.js';
import type { BotSample } from './protocol.js';

export interface StepInput {
  expectedBots: number;
  failedBots: number;
  lostBots: number;
  joinSeconds: number[];
  samples: { botId: string; sample: BotSample }[];
  windowSeconds: number;
  prometheus: { name: string; value: number; max: number }[];
  /** Media the plan promises. Without a check, a step without any media would pass. */
  expect: { audio: boolean; video: boolean };
  /** Counts as seen by the BBB API, if available. */
  bbb?: { participants: number; expectedParticipants: number; videos: number; expectedVideos: number };
}

export interface StepResult {
  verdict: 'pass' | 'fail' | 'invalid';
  reasons: string[];
  joinFailurePct: number;
  joinP95Seconds: number | null;
  audioLossPct: number;
  videoLossPct: number;
  jitterP95Ms: number | null;
  rttP95Ms: number | null;
  freezesPerMinute: number;
  audioPackets: number;
  videoPackets: number;
  framesDecoded: number;
  botCpuP95Pct: number | null;
  botThrottledP95Pct: number | null;
  mediaPaths: Record<string, number>;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}

const round = (v: number) => Math.round(v * 100) / 100;

/** Per stream: a bot receiving 50 videos would otherwise look 50 times worse than one with a single video. */
function freezesPerStreamMinute({ samples, windowSeconds }: StepInput): number {
  const streamIntervals = samples.reduce((t, x) => t + x.sample.videoStreams, 0);
  if (streamIntervals === 0 || windowSeconds === 0) return 0;
  const intervalSeconds = windowSeconds / (samples.length / new Set(samples.map((x) => x.botId)).size);
  const freezes = samples.reduce((t, x) => t + x.sample.freezes, 0);
  return round((freezes / streamIntervals) * (60 / intervalSeconds));
}

export function evaluateStep(input: StepInput, slo: Slo): StepResult {
  const sum = (pick: (s: BotSample) => number) => input.samples.reduce((t, x) => t + pick(x.sample), 0);
  const defined = (pick: (s: BotSample) => number | undefined) =>
    input.samples.map((x) => pick(x.sample)).filter((v): v is number => v !== undefined);
  const lossPct = (lost: number, received: number) => (lost + received > 0 ? (lost / (lost + received)) * 100 : 0);

  const mediaPaths: Record<string, number> = {};
  const latest = new Map(input.samples.map((x) => [x.botId, x.sample.mediaPath]));
  for (const path of latest.values()) if (path) mediaPaths[path] = (mediaPaths[path] ?? 0) + 1;

  const reporting = new Set(input.samples.map((x) => x.botId)).size;
  const result: StepResult = {
    verdict: 'pass',
    reasons: [],
    joinFailurePct: round(input.expectedBots ? ((input.failedBots + input.lostBots) / input.expectedBots) * 100 : 0),
    joinP95Seconds: percentile(input.joinSeconds, 95),
    audioLossPct: round(lossPct(sum((s) => s.audioLost), sum((s) => s.audioPackets))),
    videoLossPct: round(lossPct(sum((s) => s.videoLost), sum((s) => s.videoPackets))),
    jitterP95Ms: percentile(defined((s) => s.jitterMs), 95),
    rttP95Ms: percentile(defined((s) => s.rttMs), 95),
    freezesPerMinute: freezesPerStreamMinute(input),
    audioPackets: sum((s) => s.audioPackets),
    videoPackets: sum((s) => s.videoPackets),
    framesDecoded: sum((s) => s.framesDecoded),
    botCpuP95Pct: percentile(defined((s) => s.cpuPct), 95),
    botThrottledP95Pct: percentile(defined((s) => s.throttledPct), 95),
    mediaPaths,
  };

  const limits: [string, number | null, number][] = [
    [t('slo.joinFailure'), result.joinFailurePct, slo.maxJoinFailurePct],
    [t('slo.joinP95'), result.joinP95Seconds, slo.maxJoinP95Seconds],
    [t('slo.audioLoss'), result.audioLossPct, slo.maxAudioLossPct],
    [t('slo.videoLoss'), result.videoLossPct, slo.maxVideoLossPct],
    [t('slo.jitter'), result.jitterP95Ms, slo.maxJitterMs],
    [t('slo.rtt'), result.rttP95Ms, slo.maxRttMs],
    [t('slo.freezes'), result.freezesPerMinute, slo.maxFreezesPerMinute],
  ];
  for (const [name, value, max] of limits) {
    if (value !== null && value > max) result.reasons.push(`${name}: ${value} > ${max}`);
  }
  for (const rule of input.prometheus) {
    if (rule.value > rule.max) result.reasons.push(`${rule.name}: ${round(rule.value)} > ${rule.max}`);
  }
  if (input.expect.audio && result.audioPackets === 0) result.reasons.push(t('slo.noAudio'));
  if (input.expect.video && result.framesDecoded === 0) result.reasons.push(t('slo.noVideo'));
  if (input.bbb) {
    const { participants, expectedParticipants, videos, expectedVideos } = input.bbb;
    if (participants !== expectedParticipants) {
      result.reasons.push(t('slo.bbbParticipants', { actual: participants, expected: expectedParticipants }));
    }
    if (videos !== expectedVideos) result.reasons.push(t('slo.bbbCameras', { actual: videos, expected: expectedVideos }));
  }
  if (result.reasons.length) result.verdict = 'fail';

  // Checked last on purpose: an overloaded generator voids any finding about the server.
  const invalid: string[] = [];
  if ((result.botCpuP95Pct ?? 0) > slo.maxBotCpuPct) {
    invalid.push(t('slo.botCpu', { value: result.botCpuP95Pct ?? 0, max: slo.maxBotCpuPct }));
  }
  if ((result.botThrottledP95Pct ?? 0) > slo.maxBotThrottledPct) {
    invalid.push(t('slo.botThrottled', { value: result.botThrottledP95Pct ?? 0, max: slo.maxBotThrottledPct }));
  }
  if (input.expectedBots > 0 && reporting === 0) invalid.push(t('slo.noSamples'));
  if (invalid.length) {
    result.verdict = 'invalid';
    result.reasons.unshift(...invalid);
  }
  return result;
}
