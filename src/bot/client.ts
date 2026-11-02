import type { Page } from 'playwright';
import type { Role } from '../shared/scenario.js';

import { ui } from './selectors.js';

const MEDIA_TIMEOUT_MS = 90_000;

async function connectAudio(page: Page, role: Role): Promise<void> {
  if (role.audio === 'none') return;
  const joined = page.locator(ui.audioJoined);
  const modalButton = page.locator(role.audio === 'listen' ? ui.listenOnlyButton : ui.microphoneButton);
  // The join parameters usually skip the modal; a server config may still show it.
  await Promise.race([
    joined.waitFor({ timeout: MEDIA_TIMEOUT_MS }),
    modalButton.click({ timeout: MEDIA_TIMEOUT_MS }).then(() => joined.waitFor({ timeout: MEDIA_TIMEOUT_MS })),
  ]);
}

/** BBB joins microphones muted. Without this step the test understates the audio load. */
async function unmute(page: Page): Promise<void> {
  const button = page.locator(ui.unmuteMic);
  await button.waitFor({ timeout: 10_000 }).catch(() => undefined);
  if (await button.isVisible()) await button.click({ timeout: MEDIA_TIMEOUT_MS });
  await page.locator(ui.muteMic).waitFor({ timeout: 30_000 });
}

async function connectWebcam(page: Page): Promise<void> {
  const joined = page.locator(ui.webcamJoined);
  if (await joined.isVisible()) return;
  await Promise.race([
    joined.waitFor({ timeout: MEDIA_TIMEOUT_MS }),
    (async () => {
      await page.locator(ui.joinVideo).click({ timeout: MEDIA_TIMEOUT_MS });
      await page.locator(ui.startSharingWebcam).click({ timeout: 30_000 }).catch(() => undefined);
      await joined.waitFor({ timeout: MEDIA_TIMEOUT_MS });
    })(),
  ]);
}

async function connectScreenShare(page: Page): Promise<void> {
  await page.locator(ui.startScreenShare).click({ timeout: MEDIA_TIMEOUT_MS });
  await page.locator(ui.screenShareJoined).waitFor({ timeout: MEDIA_TIMEOUT_MS });
}

/** Names the failed stage: "timeout" alone says nothing about which part of BBB changed. */
async function stage(name: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    throw new Error(`${name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

/** Elements this role must see while no screen is shared. Empty result means all were found. */
async function missingElements(page: Page, role: Role): Promise<string[]> {
  // The camera button changes once the camera runs.
  const expected: (keyof typeof ui)[] = ['ready', role.webcam ? 'webcamJoined' : 'joinVideo'];
  if (role.audio !== 'none') expected.push('audioJoined');
  if (role.audio === 'microphone') expected.push('muteMic');
  if (role.screenshare) expected.push('startScreenShare', 'nextSlide');
  const missing: string[] = [];
  for (const name of expected) {
    const found = await page.locator(ui[name]).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    if (!found) missing.push(name);
  }
  return missing;
}

export interface JoinOptions {
  /** Also reports expected UI elements that are missing. Only the self-test needs this. */
  probe?: boolean | undefined;
}

/** Resolves when all media of the role are confirmed by the client UI. */
export async function joinMeeting(page: Page, joinUrl: string, role: Role, options: JoinOptions = {}): Promise<string[]> {
  await stage('open client', async () => {
    await page.goto(joinUrl, { waitUntil: 'domcontentloaded', timeout: MEDIA_TIMEOUT_MS });
    await page.locator(ui.ready).waitFor({ timeout: MEDIA_TIMEOUT_MS });
  });
  await stage('audio', () => connectAudio(page, role));
  if (role.audio === 'microphone' && !role.muted) await stage('unmute', () => unmute(page));
  if (role.webcam) await stage('webcam', () => connectWebcam(page));
  // Before the screen share, which replaces the presentation and its controls.
  const missing = options.probe ? await missingElements(page, role) : [];
  if (role.screenshare) await stage('screen share', () => connectScreenShare(page));
  return missing;
}

/** Slide changes are background activity: a failure gets logged and must not end the bot. */
export async function nextSlide(page: Page): Promise<void> {
  await page
    .locator(ui.nextSlide)
    .click({ timeout: 5_000 })
    .catch((err: Error) => console.error(`Slide change failed: ${err.message.split('\n')[0]}`));
}
