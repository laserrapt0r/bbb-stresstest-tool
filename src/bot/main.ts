import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';
import type { Assignment, BotCommand, BotSample, BotState, Heartbeat } from '../shared/protocol.js';
import { joinMeeting, nextSlide } from './client.js';
import { StatsCollector, trackPeerConnections } from './rtcStats.js';

const controllerUrl = required('CONTROLLER_URL').replace(/\/+$/, '');
const runId = required('RUN_ID');
const token = required('BOT_TOKEN');
const mediaDir = process.env.MEDIA_DIR ?? '/app/media';
const botId = process.env.BOT_ID ?? `${hostname()}-${randomUUID().slice(0, 6)}`;
/** Without a controller nobody could stop this bot, so it leaves on its own. */
const MAX_CONTROLLER_SILENCE_MS = 120_000;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Environment variable ${name} is missing`);
  return value;
}

function chromiumArgs(a: Assignment): string[] {
  const args = [
    // The restricted profile rules out the sandbox's user namespaces. Bots only open the
    // configured BBB server. BBB's own test suite runs the same way.
    '--no-sandbox',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${mediaDir}/video.y4m`,
    `--use-file-for-fake-audio-capture=${mediaDir}/speech.wav`,
    '--auto-select-desktop-capture-source=Entire screen',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-gpu',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ];
  if (a.network.ignoreTlsErrors) args.push('--ignore-certificate-errors');
  if (a.network.webrtcIpPolicy) args.push(`--force-webrtc-ip-handling-policy=${a.network.webrtcIpPolicy}`);
  args.push(...(a.network.extraChromiumArgs ?? []));
  return args;
}

class Bot {
  private state: BotState = 'idle';
  private error: string | undefined;
  private joinSeconds: number | undefined;
  private missingSelectors: string[] | undefined;
  private browser: Browser | undefined;
  private page: Page | undefined;
  private lastControllerContact = Date.now();
  private readonly stats = new StatsCollector();
  private slideTimer: NodeJS.Timeout | undefined;

  private async post(path: string, body: unknown): Promise<BotCommand> {
    const res = await fetch(`${controllerUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Controller answered with HTTP ${res.status}`);
    this.lastControllerContact = Date.now();
    return (await res.json()) as BotCommand;
  }

  private async heartbeat(sample?: BotSample): Promise<BotCommand> {
    const body: Heartbeat = {
      botId,
      state: this.state,
      ...(this.error ? { error: this.error } : {}),
      ...(this.joinSeconds !== undefined ? { joinSeconds: this.joinSeconds } : {}),
      ...(sample ? { sample } : {}),
      ...(this.missingSelectors ? { missingSelectors: this.missingSelectors } : {}),
    };
    return this.post(`/internal/runs/${runId}/heartbeat`, body);
  }

  private async join(a: Assignment): Promise<void> {
    this.state = 'joining';
    const started = Date.now();
    try {
      this.browser = await chromium.launch({
        headless: true,
        args: chromiumArgs(a),
        ...(a.network.proxy ? { proxy: a.network.proxy } : {}),
      });
      const context = await this.browser.newContext({
        viewport: { width: 1366, height: 768 },
        ignoreHTTPSErrors: a.network.ignoreTlsErrors ?? false,
        permissions: ['camera', 'microphone'],
      });
      await context.addInitScript(trackPeerConnections);
      this.page = await context.newPage();
      this.missingSelectors = await joinMeeting(this.page, a.joinUrl, a.role, { probe: a.probe });
      this.joinSeconds = (Date.now() - started) / 1000;
      this.state = 'joined';
      if (a.role.nextSlideEverySeconds) {
        this.slideTimer = setInterval(() => {
          if (this.page) void nextSlide(this.page);
        }, a.role.nextSlideEverySeconds * 1000);
      }
    } catch (err) {
      this.state = 'failed';
      this.error = err instanceof Error ? err.message.split('\n')[0] : String(err);
      console.error(`Join failed: ${this.error}`);
    }
  }

  private async measure(): Promise<BotSample | undefined> {
    if (!this.page || this.state !== 'joined') return undefined;
    if (this.page.isClosed()) {
      this.state = 'lost';
      this.error = 'Page closed';
      return undefined;
    }
    try {
      return await this.stats.sample(this.page);
    } catch (err) {
      this.state = 'lost';
      this.error = err instanceof Error ? err.message.split('\n')[0] : String(err);
      return undefined;
    }
  }

  async run(): Promise<void> {
    let pollMs = 1000 + Math.random() * 1000; // spreads the first requests of many pods
    for (;;) {
      if (Date.now() - this.lastControllerContact > MAX_CONTROLLER_SILENCE_MS) {
        console.error('Controller unreachable, bot exits');
        break;
      }
      await sleep(pollMs);
      let command: BotCommand;
      try {
        command = await this.heartbeat(await this.measure());
      } catch (err) {
        console.error(`Heartbeat failed: ${String(err)}`);
        continue;
      }
      if (command.command === 'stop') break;
      pollMs = command.pollMs;
      if (command.command === 'join') void this.join(command.assignment);
    }
    if (this.slideTimer) clearInterval(this.slideTimer);
    this.state = 'stopped';
    await this.browser?.close().catch(() => undefined);
    await this.heartbeat().catch(() => undefined);
  }
}

await new Bot().run();
process.exit(0);
