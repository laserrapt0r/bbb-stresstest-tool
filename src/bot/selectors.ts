/**
 * Selectors from BigBlueButton's own Playwright suite. This is the only place that knows the
 * UI, and scripts/check-selectors.mjs compares it against each BBB release.
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

/** Join parameters the bots rely on, checked the same way. */
export const joinParameters = [
  'bbb_auto_join_audio',
  'bbb_force_listen_only',
  'bbb_listen_only_mode',
  'bbb_skip_check_audio',
  'bbb_auto_share_webcam',
  'bbb_skip_video_preview',
] as const;
