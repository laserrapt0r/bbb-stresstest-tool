// Test double for the BBB API and client. Validates checksums and offers the selectors
// the bot relies on, with real WebRTC traffic. It proves the tool chain, never BBB itself.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const SECRET = process.env.FAKE_SECRET ?? 'fake-secret';
const meetings = new Map();
const xml = (body) => `<response>${body}</response>`;

function checksumValid(call, rawQuery) {
  const params = new URLSearchParams(rawQuery);
  const given = params.get('checksum') ?? '';
  const query = rawQuery.replace(/&?checksum=[^&]*/, '');
  const algo = { 40: 'sha1', 64: 'sha256', 96: 'sha384', 128: 'sha512' }[given.length];
  return algo && createHash(algo).update(call + query + SECRET).digest('hex') === given;
}

const page = (meeting, user, webcam, screenshareAllowed) => `<!doctype html><title>fake</title>
<section id="ActionsBar">
  <button data-test="audioDropdownMenu" hidden>audio</button><button data-test="unmuteMicButton" hidden>unmute</button><button data-test="muteMicButton" hidden>mute</button>
  <button data-test="joinVideo">video</button><button data-test="startSharingWebcam" hidden>start</button>
  <button data-test="leaveVideo" hidden>leave</button>
  <button data-test="startScreenShare">screen</button><button data-test="stopScreenShare" hidden>stop</button>
</section><video id="v" autoplay muted playsinline width="320"></video>
<script>
const q = (t) => document.querySelector('[data-test="' + t + '"]');
const report = (data) => fetch('/fake/report', { method: 'POST', body: JSON.stringify({ meeting: ${JSON.stringify(meeting)}, user: ${JSON.stringify(user)}, ...data }) });
async function loop(stream) {
  const a = new RTCPeerConnection(), b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  b.ontrack = (e) => { if (e.track.kind === 'video') document.getElementById('v').srcObject = e.streams[0]; };
  stream.getTracks().forEach((t) => a.addTrack(t, stream));
  const offer = await a.createOffer(); await a.setLocalDescription(offer); await b.setRemoteDescription(offer);
  const answer = await b.createAnswer(); await b.setLocalDescription(answer); await a.setRemoteDescription(answer);
}
async function webcam() {
  await loop(await navigator.mediaDevices.getUserMedia({ video: true }));
  q('leaveVideo').hidden = false; report({ video: true });
}
report({ joined: true });
navigator.mediaDevices.getUserMedia({ audio: true }).then(async (s) => { await loop(s); q('audioDropdownMenu').hidden = false; q('unmuteMicButton').hidden = false; report({ voice: true }); });
q('unmuteMicButton').onclick = () => { q('unmuteMicButton').hidden = true; q('muteMicButton').hidden = false; };
if (${webcam}) webcam();
q('startScreenShare').onclick = async () => {
  await loop(await navigator.mediaDevices.getDisplayMedia({ video: true }));
  q('stopScreenShare').hidden = false; report({ screen: true });
};
</script>`;

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const rawQuery = req.url.split('?')[1] ?? '';
  const send = (status, body, type = 'text/xml') => { res.writeHead(status, { 'content-type': type }); res.end(body); };

  if (url.pathname === '/fake/report') {
    let body = ''; for await (const c of req) body += c;
    const r = JSON.parse(body); const m = meetings.get(r.meeting);
    if (m) { const u = m.users.get(r.user) ?? {}; m.users.set(r.user, { ...u, ...r }); }
    return send(200, 'ok', 'text/plain');
  }
  if (url.pathname === '/fake/state') {
    return send(200, JSON.stringify([...meetings.keys()]), 'application/json');
  }
  if (url.pathname === '/html5client') {
    return send(200, page(url.searchParams.get('m'), url.searchParams.get('u'), url.searchParams.get('w') === '1'), 'text/html');
  }
  const call = /\/api\/(\w+)$/.exec(url.pathname)?.[1];
  if (!call) return send(404, 'not found', 'text/plain');
  if (!checksumValid(call, rawQuery)) return send(200, xml('<returncode>FAILED</returncode><messageKey>checksumError</messageKey>'));

  const id = url.searchParams.get('meetingID');
  const m = meetings.get(id);
  if (call === 'create') {
    meetings.set(id, { users: new Map() });
    return send(200, xml('<returncode>SUCCESS</returncode>'));
  }
  if (!m) return send(200, xml('<returncode>FAILED</returncode><messageKey>notFound</messageKey>'));
  if (call === 'join') {
    const w = url.searchParams.get('userdata-bbb_auto_share_webcam') === 'true' ? 1 : 0;
    res.writeHead(302, { location: `/html5client?m=${encodeURIComponent(id)}&u=${encodeURIComponent(url.searchParams.get('userID'))}&w=${w}` });
    return res.end();
  }
  if (call === 'getMeetingInfo') {
    const users = [...m.users.values()];
    return send(200, xml(`<returncode>SUCCESS</returncode><running>true</running><participantCount>${users.length}</participantCount><moderatorCount>1</moderatorCount><listenerCount>0</listenerCount><voiceParticipantCount>${users.filter((u) => u.voice).length}</voiceParticipantCount><videoCount>${users.filter((u) => u.video).length}</videoCount>`));
  }
  if (call === 'end') { meetings.delete(id); return send(200, xml('<returncode>SUCCESS</returncode>')); }
  return send(200, xml('<returncode>FAILED</returncode>'));
}).listen(8090, () => console.log('fake-bbb on 8090'));
