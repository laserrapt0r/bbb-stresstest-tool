// Checks with real Chromium whether media flows over TURN and a forward proxy without a direct route.
import { chromium } from '/app/node_modules/playwright/index.mjs';

const { TURN_URL, PROXY, POLICY } = process.env;
const args = ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'];
if (POLICY) args.push(`--force-webrtc-ip-handling-policy=${POLICY}`);
const browser = await chromium.launch({ headless: true, args, ...(PROXY ? { proxy: { server: PROXY } } : {}) });
const page = await (await browser.newContext({ permissions: ['camera', 'microphone'] })).newPage();
await page.goto('about:blank');

const result = await page.evaluate(async (turnUrl) => {
  const config = { iceServers: [{ urls: turnUrl, username: 'test', credential: 'test' }], iceTransportPolicy: 'relay' };
  const a = new RTCPeerConnection(config), b = new RTCPeerConnection(config);
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
  // about:blank is no secure context for getUserMedia, a canvas gives a real video track.
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
  const ctx = canvas.getContext('2d');
  const draw = setInterval(() => { ctx.fillStyle = `hsl(${Date.now() % 360} 80% 50%)`; ctx.fillRect(0, 0, 320, 240); }, 66);
  const stream = canvas.captureStream(15);
  stream.getTracks().forEach((t) => a.addTrack(t, stream));
  const offer = await a.createOffer(); await a.setLocalDescription(offer); await b.setRemoteDescription(offer);
  const answer = await b.createAnswer(); await b.setLocalDescription(answer); await a.setRemoteDescription(answer);

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && a.connectionState !== 'connected' && a.connectionState !== 'failed') await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 6000));
  clearInterval(draw);

  const out = { state: a.connectionState, ice: a.iceConnectionState };
  const stats = await a.getStats(), inbound = await b.getStats();
  const byId = new Map(); stats.forEach((s) => byId.set(s.id, s));
  for (const s of byId.values()) {
    if (s.type === 'candidate-pair' && s.nominated) {
      const l = byId.get(s.localCandidateId);
      out.path = `${l?.candidateType}/${l?.relayProtocol}`; out.url = l?.url; out.rttMs = (s.currentRoundTripTime ?? 0) * 1000;
    }
  }
  inbound.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') { out.framesDecoded = s.framesDecoded; out.bytes = s.bytesReceived; } });
  return out;
}, TURN_URL);
console.log(JSON.stringify(result));
await browser.close();
