import type { Page } from 'playwright';
import { readFile } from 'node:fs/promises';
import type { BotSample } from '../shared/protocol.js';

/** Runs in the page before any BBB code, so every peer connection gets recorded. */
export const trackPeerConnections = `(() => {
  const Native = window.RTCPeerConnection;
  if (!Native || window.__stressPcs) return;
  window.__stressPcs = [];
  window.RTCPeerConnection = class extends Native {
    constructor(...args) { super(...args); window.__stressPcs.push(this); }
  };
})();`;

interface RawTotals {
  streams: Record<string, { kind: string; packets: number; lost: number; frames: number; freezes: number }>;
  jitterMs?: number;
  rttMs?: number;
  mediaPath?: string;
  connected: number;
}

const readStats = (): Promise<RawTotals> =>
  (async () => {
    const pcs = ((window as unknown as { __stressPcs?: RTCPeerConnection[] }).__stressPcs ?? []).filter(
      (pc) => pc.connectionState !== 'closed',
    );
    const totals: RawTotals = { streams: {}, connected: 0 };
    const jitters: number[] = [];
    const rtts: number[] = [];
    const paths: string[] = [];

    await Promise.all(
      pcs.map(async (pc, pcIndex) => {
        if (pc.connectionState === 'connected') totals.connected += 1;
        const report = await pc.getStats();
        const byId = new Map<string, any>();
        report.forEach((entry: any) => byId.set(entry.id, entry));
        for (const entry of byId.values()) {
          if (entry.type === 'inbound-rtp') {
            totals.streams[`${pcIndex}:${entry.id}`] = {
              kind: entry.kind,
              packets: entry.packetsReceived ?? 0,
              lost: entry.packetsLost ?? 0,
              frames: entry.framesDecoded ?? 0,
              freezes: entry.freezeCount ?? 0,
            };
            if (entry.kind === 'audio' && entry.jitter !== undefined) jitters.push(entry.jitter * 1000);
          }
          if (entry.type === 'candidate-pair' && entry.nominated && entry.state === 'succeeded') {
            if (entry.currentRoundTripTime !== undefined) rtts.push(entry.currentRoundTripTime * 1000);
            const local = byId.get(entry.localCandidateId);
            if (local) paths.push(`${local.candidateType}/${local.relayProtocol ?? local.protocol}`);
          }
        }
      }),
    );
    if (jitters.length) totals.jitterMs = Math.max(...jitters);
    if (rtts.length) totals.rttMs = Math.max(...rtts);
    totals.mediaPath = paths[0];
    return totals;
  })();

export interface CgroupCpu {
  usageUs: number;
  periods: number;
  throttled: number;
  at: number;
}

/** cgroup v2 of this container. Undefined where the file does not exist. */
export async function readCgroupCpu(): Promise<(CgroupCpu & { limitCores: number }) | undefined> {
  try {
    const stat = await readFile('/sys/fs/cgroup/cpu.stat', 'utf8');
    const max = (await readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim().split(/\s+/);
    const value = (key: string) => Number(new RegExp(`^${key} (\\d+)$`, 'm').exec(stat)?.[1] ?? 0);
    const limitCores = max[0] === 'max' ? (await import('node:os')).availableParallelism() : Number(max[0]) / Number(max[1]);
    return {
      usageUs: value('usage_usec'),
      periods: value('nr_periods'),
      throttled: value('nr_throttled'),
      at: Date.now(),
      limitCores,
    };
  } catch {
    return undefined;
  }
}

export class StatsCollector {
  private previous: RawTotals['streams'] = {};
  private previousCpu?: CgroupCpu;

  async sample(page: Page): Promise<BotSample> {
    const raw = await page.evaluate(readStats);
    const sample: BotSample = {
      audioPackets: 0,
      audioLost: 0,
      videoPackets: 0,
      videoLost: 0,
      framesDecoded: 0,
      freezes: 0,
      videoStreams: 0,
      connected: raw.connected,
      ...(raw.jitterMs !== undefined ? { jitterMs: raw.jitterMs } : {}),
      ...(raw.rttMs !== undefined ? { rttMs: raw.rttMs } : {}),
      ...(raw.mediaPath !== undefined ? { mediaPath: raw.mediaPath } : {}),
    };
    for (const [id, now] of Object.entries(raw.streams)) {
      const before = this.previous[id] ?? { kind: now.kind, packets: 0, lost: 0, frames: 0, freezes: 0 };
      const packets = Math.max(0, now.packets - before.packets);
      const lost = Math.max(0, now.lost - before.lost);
      if (now.kind === 'audio') {
        sample.audioPackets += packets;
        sample.audioLost += lost;
      } else {
        sample.videoStreams += 1;
        sample.videoPackets += packets;
        sample.videoLost += lost;
        sample.framesDecoded += Math.max(0, now.frames - before.frames);
        sample.freezes += Math.max(0, now.freezes - before.freezes);
      }
    }
    this.previous = raw.streams;

    const cpu = await readCgroupCpu();
    if (cpu && this.previousCpu) {
      const wallUs = (cpu.at - this.previousCpu.at) * 1000;
      const periods = cpu.periods - this.previousCpu.periods;
      if (wallUs > 0) sample.cpuPct = Math.round(((cpu.usageUs - this.previousCpu.usageUs) / wallUs / cpu.limitCores) * 100);
      if (periods > 0) sample.throttledPct = Math.round(((cpu.throttled - this.previousCpu.throttled) / periods) * 100);
    }
    this.previousCpu = cpu;
    return sample;
  }
}
