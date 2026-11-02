import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderSelfTest, evaluateSelfTest, selfTestScenario } from '../src/controller/selftest.ts';
import type { RunRecord, StepRecord } from '../src/controller/runner.ts';
import { joinParameters, ui } from '../src/bot/selectors.ts';
// @ts-expect-error plain JavaScript without types
import { latestReleases, missingParameters, missingSelectors, selectorTokens } from '../scripts/check-selectors.mjs';
import { validatePlan } from '../src/shared/plan.ts';

const step = (over: Partial<StepRecord> = {}): StepRecord => ({
  verdict: 'pass', reasons: [], joinFailurePct: 0, joinP95Seconds: 5, audioLossPct: 0, videoLossPct: 0, jitterP95Ms: 1, rttP95Ms: 2, freezesPerMinute: 0,
  audioPackets: 500, videoPackets: 500, framesDecoded: 100, botCpuP95Pct: 30, botThrottledP95Pct: 0, mediaPaths: { 'relay/tls': 2 }, usersPerMeeting: 2, totalUsers: 2,
  meetingInfo: [{ running: true, participantCount: 2, moderatorCount: 1, listenerCount: 0, voiceParticipantCount: 2, videoCount: 1 }], startedAt: '', finishedAt: '', ...over,
});
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r', createdAt: '', scenario: selfTestScenario('t'), phase: 'finished', steps: [step()], log: [], ...over,
});
const statusOf = (r: RunRecord, id: string, relay = false) => evaluateSelfTest(r, relay).checks.find((c) => c.id === id)?.status;

test('The self-test scenario is a valid plan with two users', () => {
  assert.deepEqual(validatePlan(selfTestScenario('t')), []);
});

test('Self-test: a healthy run passes all checks', () => {
  const result = evaluateSelfTest(run(), true);
  assert.equal(result.ok, true);
  assert.equal(result.checks.every((c) => c.status === 'ok'), true);
});

test('Self-test: a run without steps names the reason', () => {
  const result = evaluateSelfTest(run({ steps: [], message: 'create failed: checksumError' }), false);
  assert.equal(result.ok, false);
  assert.match(result.checks[0]?.detail ?? '', /checksumError/);
});

test('Self-test: missing media fails', () => {
  assert.equal(statusOf(run({ steps: [step({ audioPackets: 0 })] }), 'audio'), 'fail');
  assert.equal(statusOf(run({ steps: [step({ framesDecoded: 0 })] }), 'video'), 'fail');
});

test('Self-test: a direct path fails where only relay is possible', () => {
  const direct = run({ steps: [step({ mediaPaths: { 'host/udp': 2 } })] });
  assert.equal(statusOf(direct, 'mediaPath', true), 'fail');
  assert.equal(statusOf(direct, 'mediaPath', false), 'ok');
});

test('Self-test: a required selector fails, an optional one is a note', () => {
  assert.equal(statusOf(run({ missingSelectors: ['joinVideo', 'nextSlide'] }), 'selectors'), 'fail');
  const note = run({ missingSelectors: ['nextSlide'] });
  assert.equal(statusOf(note, 'selectors'), 'warn');
  assert.equal(evaluateSelfTest(note, false).ok, true);
});

test('Self-test report shows a hint for failures only and escapes details', () => {
  const html = renderSelfTest(evaluateSelfTest(run({ steps: [], message: '<b>x' }), false), 'en');
  assert.match(html, /Self-test failed/);
  assert.match(html, /Check API URL/);
  assert.doesNotMatch(html, /<b>x/);
});

test('Selector tokens: attributes, ids and alternatives', () => {
  assert.deepEqual(selectorTokens('button[data-test="joinVideo"]'), [['joinVideo']]);
  assert.deepEqual(selectorTokens('section#ActionsBar'), [['ActionsBar']]);
  assert.equal(selectorTokens(ui.audioModal).length, 2);
});

test('Selector check finds a removed element and accepts alternatives', () => {
  const source = '"listenOnlyBtn" "audioModal"';
  const missing = missingSelectors({ a: 'x[data-test="listenOnlyBtn"]', b: 'x[data-test="gone"]', c: 'x[data-test="old"], x[data-testid="audioModal"]' }, source);
  assert.deepEqual(missing.map((m: { name: string }) => m.name), ['b']);
});

test('Selector check finds removed join parameters', () => {
  assert.deepEqual(missingParameters(joinParameters, joinParameters.slice(1).join(' ')), ['bbb_auto_join_audio']);
});

test('Newest stable release per line, without pre-releases and old lines', () => {
  const tags = ['v2.7.1', 'v3.0.9', 'v3.0.40', 'v4.0.0-rc.1', 'v4.0.0', 'v4.0.1', 'v4.1.0-alpha.1'];
  assert.deepEqual(latestReleases(tags), ['v3.0.40', 'v4.0.1']);
});
