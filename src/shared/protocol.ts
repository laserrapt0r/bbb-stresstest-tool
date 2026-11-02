import type { Role } from './scenario.js';

export type BotState = 'idle' | 'joining' | 'joined' | 'failed' | 'lost' | 'stopped';

/** Everything a bot needs. The API secret stays in the controller. */
export interface Assignment {
  joinUrl: string;
  role: Role;
  network: BotNetwork;
}

export interface BotNetwork {
  proxy?: { server: string; bypass?: string; username?: string; password?: string };
  /** Chromium --force-webrtc-ip-handling-policy, e.g. disable_non_proxied_udp. */
  webrtcIpPolicy?: string;
  ignoreTlsErrors?: boolean;
  extraChromiumArgs?: string[];
}

/** One heartbeat interval of one bot. Counters are deltas. */
export interface BotSample {
  audioPackets: number;
  audioLost: number;
  videoPackets: number;
  videoLost: number;
  framesDecoded: number;
  freezes: number;
  /** Inbound video streams of this interval. */
  videoStreams: number;
  jitterMs?: number;
  rttMs?: number;
  /** e.g. relay/tcp or host/udp */
  mediaPath?: string;
  connected: number;
  cpuPct?: number;
  throttledPct?: number;
}

export interface Heartbeat {
  botId: string;
  state: BotState;
  error?: string;
  joinSeconds?: number;
  sample?: BotSample;
}

export type BotCommand =
  | { command: 'wait'; pollMs: number }
  | { command: 'join'; assignment: Assignment; pollMs: number }
  | { command: 'continue'; pollMs: number }
  | { command: 'stop' };
