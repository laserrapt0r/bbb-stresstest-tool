// Writes invented sample runs for the README screenshots. These are no measurements.
import { mkdirSync, writeFileSync } from 'node:fs';

const dir = process.argv[2];
for (const sub of ['runs', 'scenarios', 'series']) mkdirSync(`${dir}/${sub}`, { recursive: true });

const slo = { maxJoinFailurePct: 2, maxJoinP95Seconds: 45, maxAudioLossPct: 3, maxVideoLossPct: 3, maxJitterMs: 60, maxRttMs: 400, maxFreezesPerMinute: 3, maxBotCpuPct: 85, maxBotThrottledPct: 10, prometheus: [] };
const roles = [
  { name: 'presenter', count: 1, moderator: true, audio: 'microphone', muted: false, webcam: false, screenshare: true },
  { name: 'camera', count: 1, moderator: false, audio: 'listen', muted: false, webcam: true, screenshare: false },
  { name: 'listener', fill: true, moderator: false, audio: 'listen', muted: false, webcam: false, screenshare: false },
];
const scenario = (name) => ({ name, description: '', target: 'testserver', meetings: 1, meeting: { createParams: {} }, roles, slo,
  load: { mode: 'steps', startUsers: 20, stepUsers: 20, maxUsers: 140, joinPerSecond: 1, holdSeconds: 180, settleSeconds: 30 },
  bot: { cpu: '2', memory: '3Gi', shmSize: '512Mi' } });

function run(id, name, start, curve, path, seriesId) {
  const steps = [];
  let capacityUsers;
  let outcome = 'completed';
  const base = new Date(start).getTime();
  for (let i = 0; i < 7; i++) {
    const users = 20 + i * 20;
    const load = (users / curve) ** 3;
    const s = { audioLossPct: +(0.1 + 2 * load).toFixed(2), videoLossPct: +(0.2 + 2.6 * load).toFixed(2), freezesPerMinute: +(0.05 + 2.8 * load).toFixed(2),
      jitterP95Ms: +(7 + 32 * load).toFixed(1), rttP95Ms: +(24 + 210 * load).toFixed(0), joinP95Seconds: +(5 + 26 * load).toFixed(1), joinFailurePct: load > 1 ? 1.4 : 0, botCpuP95Pct: 38 + i * 3 };
    const reasons = s.freezesPerMinute > 3 ? [`Freezes/min: ${s.freezesPerMinute} > 3`] : [];
    steps.push({ verdict: reasons.length ? 'fail' : 'pass', reasons, ...s, botThrottledP95Pct: 1, audioPackets: users * 9000, videoPackets: users * 14000, framesDecoded: users * 3600,
      mediaPaths: { [path]: users }, usersPerMeeting: users, totalUsers: users, meetingInfo: [{ running: true, participantCount: users, moderatorCount: 1, listenerCount: 0, voiceParticipantCount: users, videoCount: 1 }],
      startedAt: new Date(base + i * 300000).toISOString(), finishedAt: new Date(base + (i + 1) * 300000).toISOString() });
    if (reasons.length) { outcome = 'limit-found'; break; }
    capacityUsers = users;
  }
  const log = [['All bots are ready', 0], ['1 meeting(s) created', 8], ...steps.flatMap((s, i) => [[`Step ${i + 1}: ${s.usersPerMeeting} users per meeting`, i * 300 + 10], [`Step ${i + 1}: ${s.verdict}${s.reasons.length ? ` (${s.reasons[0]})` : ''}`, i * 300 + 290]]), [`Run finished: ${outcome}`, steps.length * 300]]
    .map(([text, seconds]) => ({ at: new Date(base + seconds * 1000).toISOString(), text }));
  const record = { id, createdAt: new Date(base).toISOString(), finishedAt: new Date(base + steps.length * 300000).toISOString(), scenario: scenario(name), phase: 'finished', outcome, capacityUsers, steps, log, ...(seriesId ? { seriesId } : {}) };
  writeFileSync(`${dir}/runs/${id}.json`, JSON.stringify(record));
}

run('demo-a', 'Demo A', '2026-03-02T09:00:00Z', 118, 'host/udp', 'demo-series');
run('demo-b', 'Demo B', '2026-03-02T09:45:00Z', 84, 'relay/tls', 'demo-series');
const checks = [['start'], ['join', '4.1 s'], ['selectors'], ['audio', '3003'], ['video', '400'], ['bbb', '2/1'], ['mediaPath', 'relay/tls'], ['botLoad', '32 %']]
  .map(([id, detail]) => ({ id, status: 'ok', ...(detail ? { detail } : {}) }));
writeFileSync(`${dir}/runs/demo-selftest.json`, JSON.stringify({ id: 'demo-selftest', kind: 'selftest', createdAt: '2026-03-02T08:50:00.000Z', finishedAt: '2026-03-02T08:51:00.000Z', scenario: scenario('Self-test'), phase: 'finished', outcome: 'completed', capacityUsers: 2, steps: [], selfTest: { ok: true, checks }, log: [{ at: '2026-03-02T08:50:00.000Z', text: 'All bots are ready' }] }));
writeFileSync(`${dir}/series/demo-series.json`, JSON.stringify({ id: 'demo-series', name: 'Demo series', createdAt: '2026-03-02T09:00:00.000Z', finishedAt: '2026-03-02T10:20:00.000Z', scenarios: ['Demo A', 'Demo B'], pauseSeconds: 120, continueOnError: false, state: 'finished', position: 1, pausing: false, runIds: ['demo-a', 'demo-b'] }));
writeFileSync(`${dir}/scenarios/Demo_A.json`, JSON.stringify(scenario('Demo A')));
writeFileSync(`${dir}/scenarios/Demo_B.json`, JSON.stringify(scenario('Demo B')));
