import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { BbbClient, escapeXml, presentationXml, signQuery, xmlTag } from '../src/shared/bbbApi.ts';
import { dictionaries, setLanguage, t } from '../src/shared/i18n.ts';
import { evaluateStep, percentile, type StepInput } from '../src/shared/evaluate.ts';
import { buildSlots, parseBytes, parseCpu, resourceNeed, usersPerStep, validatePlan } from '../src/shared/plan.ts';
import { scenarioSchema, sloSchema } from '../src/shared/scenario.ts';
import { joinUserdata } from '../src/bot/userdata.ts';

beforeEach(() => setLanguage('de'));

const base = {
  name: 'x',
  target: 't',
  roles: [
    { name: 'presenter', count: 1, moderator: true, audio: 'microphone', screenshare: true },
    { name: 'kamera', count: 1, webcam: true },
    { name: 'zuhoerer', fill: true },
  ],
  load: { mode: 'steps', startUsers: 10, stepUsers: 10, maxUsers: 35 },
};

test('Steps end exactly at the maximum', () => {
  const s = scenarioSchema.parse(base);
  assert.deepEqual(usersPerStep(s.load), [10, 20, 30, 35]);
});

test('Seats: presenter first, fill role takes the rest, steps match', () => {
  const slots = buildSlots(scenarioSchema.parse({ ...base, meetings: 2 }));
  assert.equal(slots.length, 70);
  assert.equal(slots[0]?.role.name, 'presenter');
  assert.equal(slots[35]?.role.name, 'presenter');
  assert.equal(slots[35]?.meeting, 1);
  assert.equal(slots.filter((s) => s.meeting === 0 && s.role.fill).length, 33);
  assert.equal(slots.filter((s) => s.meeting === 0 && s.step === 0).length, 10);
  assert.equal(slots.filter((s) => s.meeting === 0 && s.step === 3).length, 5);
});

test('Plan validation finds a too small first step and a missing fill role', () => {
  const small = scenarioSchema.parse({ ...base, load: { ...base.load, startUsers: 1 } });
  assert.match(validatePlan(small).join(), /feste/i);
  const noFill = scenarioSchema.parse({
    ...base,
    roles: [{ name: 'a', count: 3 }],
    load: { mode: 'fixed', usersPerMeeting: 5 },
  });
  assert.match(validatePlan(noFill).join(), /genau 5/);
});

test('Schema: screen sharing needs a moderator, a role needs count or fill', () => {
  assert.equal(scenarioSchema.safeParse({ ...base, roles: [{ name: 'a', count: 1, screenshare: true }] }).success, false);
  assert.equal(scenarioSchema.safeParse({ ...base, roles: [{ name: 'a' }] }).success, false);
  assert.equal(scenarioSchema.safeParse({ ...base, roles: [{ name: 'a', count: 1, fill: true }] }).success, false);
});

test('Resource need', () => {
  const need = resourceNeed(scenarioSchema.parse({ ...base, meetings: 2, bot: { cpu: '1500m', memory: '2Gi' } }));
  assert.equal(need.bots, 70);
  assert.equal(need.cpu, 105);
  assert.equal(need.memoryBytes, 140 * 1024 ** 3);
  assert.equal(parseCpu('250m'), 0.25);
  assert.equal(parseBytes('1Mi'), 1024 ** 2);
});

test('Checksum follows the BBB rule', () => {
  const expected = createHash('sha256').update('createmeetingID=a%20bgeheim').digest('hex');
  assert.equal(signQuery('create', 'meetingID=a%20b', 'geheim', 'sha256'), expected);
  const url = new BbbClient({ apiUrl: 'https://x/api/', secret: 'geheim', checksum: 'sha256' }).signedUrl('create', { meetingID: 'a b' });
  assert.equal(url, `https://x/api/create?meetingID=a%20b&checksum=${expected}`);
});

test('XML helpers', () => {
  assert.equal(xmlTag('<a><![CDATA[x]]></a>', 'a'), 'x');
  assert.equal(xmlTag('<a>y</a>', 'a'), 'y');
  assert.equal(escapeXml('a&b"'), 'a&amp;b&quot;');
});

test('Presentation as URL or embedded file', () => {
  assert.match(presentationXml({ url: 'https://x/a.pdf?b&c' }), /url="https:\/\/x\/a\.pdf\?b&amp;c"/);
  assert.match(presentationXml({ name: 'a.pdf', base64: 'QUJD' }), /<document name="a\.pdf">QUJD<\/document>/);
});

test('Join parameters per role', () => {
  const listen = joinUserdata({ name: 'a', moderator: false, audio: 'listen', muted: false, webcam: false, screenshare: false });
  assert.equal(listen['userdata-bbb_force_listen_only'], 'true');
  const mic = joinUserdata({ name: 'a', moderator: false, audio: 'microphone', muted: false, webcam: true, screenshare: false });
  assert.equal(mic['userdata-bbb_listen_only_mode'], 'false');
  assert.equal(mic['userdata-bbb_auto_share_webcam'], 'true');
  const none = joinUserdata({ name: 'a', moderator: false, audio: 'none', muted: false, webcam: false, screenshare: false });
  assert.equal(none['userdata-bbb_auto_join_audio'], 'false');
});

const sample = (over = {}) => ({
  audioPackets: 1000, audioLost: 0, videoPackets: 1000, videoLost: 0, framesDecoded: 100, freezes: 0, videoStreams: 1, connected: 2,
  jitterMs: 10, rttMs: 20, mediaPath: 'relay/tcp', cpuPct: 50, throttledPct: 0, ...over,
});
const input = (over: Partial<StepInput> = {}): StepInput => ({
  expect: { audio: true, video: true }, expectedBots: 2, failedBots: 0, lostBots: 0, joinSeconds: [5, 6], windowSeconds: 60, prometheus: [],
  samples: [{ botId: 'a', sample: sample() }, { botId: 'b', sample: sample() }], ...over,
});
const slo = sloSchema.parse({});

test('Evaluation: a healthy step passes', () => {
  const r = evaluateStep(input(), slo);
  assert.equal(r.verdict, 'pass');
  assert.deepEqual(r.mediaPaths, { 'relay/tcp': 2 });
});

test('Evaluation: packet loss, freezes and a server rule are a limit', () => {
  assert.equal(evaluateStep(input({ samples: [{ botId: 'a', sample: sample({ audioLost: 100 }) }] }), slo).verdict, 'fail');
  assert.equal(evaluateStep(input({ samples: [{ botId: 'a', sample: sample({ freezes: 9 }) }] }), slo).verdict, 'fail');
  assert.equal(evaluateStep(input({ prometheus: [{ name: 'CPU', value: 95, max: 85 }] }), slo).verdict, 'fail');
});

test('Evaluation: a step without expected media does not pass', () => {
  const silent = sample({ audioPackets: 0, videoPackets: 0, framesDecoded: 0 });
  const r = evaluateStep(input({ samples: [{ botId: 'a', sample: silent }] }), slo);
  assert.equal(r.verdict, 'fail');
  assert.match(r.reasons.join(), /Audiopakete/);
  assert.match(r.reasons.join(), /Videobilder/);
});

test('Evaluation: a mismatch with the BBB API is a failure', () => {
  const r = evaluateStep(input({ bbb: { participants: 9, expectedParticipants: 10, videos: 2, expectedVideos: 3 } }), slo);
  assert.equal(r.verdict, 'fail');
  assert.equal(r.reasons.length, 2);
});

test('Evaluation: freezes count per video stream', () => {
  const many = (botId: string) => ({ botId, sample: sample({ freezes: 10, videoStreams: 10 }) });
  const r = evaluateStep(input({ windowSeconds: 60, samples: [many('a'), many('b')] }), slo);
  assert.equal(r.freezesPerMinute, 1);
  assert.equal(r.verdict, 'pass');
});

test('Evaluation: overloaded bots make even a bad step invalid', () => {
  const r = evaluateStep(input({ samples: [{ botId: 'a', sample: sample({ cpuPct: 99, audioLost: 500 }) }] }), slo);
  assert.equal(r.verdict, 'invalid');
  assert.match(r.reasons[0] ?? '', /Bot-CPU/);
});

test('Evaluation: no pass without media values', () => {
  assert.equal(evaluateStep(input({ samples: [] }), slo).verdict, 'invalid');
});

test('Percentile', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([], 95), null);
});

test('i18n: both languages have the same keys and placeholders', () => {
  const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.de).sort());
  for (const [key, text] of Object.entries(dictionaries.de)) {
    assert.deepEqual(placeholders(dictionaries.en[key as keyof typeof dictionaries.en]), placeholders(text), key);
  }
});

test('i18n: the language is switchable and fills in values', () => {
  setLanguage('en');
  assert.equal(t('run.step', { step: 2, users: 30 }), 'Step 2: 30 users per meeting');
  setLanguage('de');
  assert.equal(t('run.step', { step: 2, users: 30 }), 'Stufe 2: 30 Nutzer pro Meeting');
});
