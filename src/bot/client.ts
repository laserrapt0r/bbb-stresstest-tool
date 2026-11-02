import type { Page } from 'playwright';
import type { Role } from '../shared/scenario.js';

/**
 * Selectors from BigBlueButton's own Playwright suite, identical in v3.0.40 and v4.0.1
 * unless both variants are listed. Keep this list as the only place that knows the UI.
 */
export const ui = {
  ready: 'section#ActionsBar',
  audioModal: 'div[data-test="audioModal"], div[data-testid="audioModal"]',
  listenOnlyButton: 'button[data-test="listenOnlyBtn"]',
  microphoneButton: 'button[data-test="microphoneBtn"]',
  audioJoined: 'button[data-test="audioDropdownMenu"]',
  unmuteMic: 'button[data-test="unmuteMicButton"]',
  muteMic: 'button[data-test="muteMicButton"]',
  joinVideo: 'button[data-test="joinVideo"]',
  startSharingWebcam: 'button[data-test="startSharingWebcam"]',
  webcamJoined: 'button[data-test="leaveVideo"]',
  startScreenShare: 'button[data-test="startScreenShare"]',
  screenShareJoined: 'button[data-test="stopScreenShare"]',
  nextSlide: 'button[data-test="nextSlide"]',
} as const;

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

/** Resolves when all media of the role are confirmed by the client UI. */
export async function joinMeeting(page: Page, joinUrl: string, role: Role): Promise<void> {
  await page.goto(joinUrl, { waitUntil: 'domcontentloaded', timeout: MEDIA_TIMEOUT_MS });
  await page.locator(ui.ready).waitFor({ timeout: MEDIA_TIMEOUT_MS });
  await connectAudio(page, role);
  if (role.audio === 'microphone' && !role.muted) await unmute(page);
  if (role.webcam) await connectWebcam(page);
  if (role.screenshare) await connectScreenShare(page);
}

/** Slide changes are background activity: a failure gets logged and must not end the bot. */
export async function nextSlide(page: Page): Promise<void> {
  await page
    .locator(ui.nextSlide)
    .click({ timeout: 5_000 })
    .catch((err: Error) => console.error(`Slide change failed: ${err.message.split('\n')[0]}`));
}
