import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCharts, esc, niceScale, renderChart, renderChartGrid } from '../src/controller/charts.ts';
import { renderCsv, renderMetrics } from '../src/controller/report.ts';
import { grafanaLink, renderCompareReport, renderRunReport } from '../src/controller/reportHtml.ts';
import type { Run, RunRecord, StepRecord } from '../src/controller/runner.ts';
import { Series, seriesRequestSchema, type RunStarter } from '../src/controller/series.ts';
import { dictionaries } from '../src/shared/i18n.ts';
import { scenarioSchema } from '../src/shared/scenario.ts';

const scenario = scenarioSchema.parse({
  name: 'Demo <script>alert(1)</script>', target: 't', roles: [{ name: 'a', fill: true }],
  load: { mode: 'steps', startUsers: 10, stepUsers: 10, maxUsers: 30 },
});
const step = (users: number, over: Partial<StepRecord> = {}): StepRecord => ({
  verdict: 'pass', reasons: [], joinFailurePct: 0, joinP95Seconds: 5, audioLossPct: 0.5, videoLossPct: 1, jitterP95Ms: 10, rttP95Ms: 20,
  freezesPerMinute: 0.2, audioPackets: 1, videoPackets: 1, framesDecoded: 1, botCpuP95Pct: 40, botThrottledP95Pct: 0, mediaPaths: { 'relay/tls': users },
  usersPerMeeting: users, totalUsers: users, meetingInfo: [], startedAt: '', finishedAt: '', ...over,
});
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r1', createdAt: '2026-11-02T10:00:00.000Z', finishedAt: '2026-11-02T10:30:00.000Z', scenario, phase: 'finished', outcome: 'limit-found', capacityUsers: 20,
  steps: [step(10), step(20), step(30, { verdict: 'fail', freezesPerMinute: 9, reasons: ['x'] })], log: [{ at: '2026-11-02T10:00:00.000Z', text: 'hello <b>' }], ...over,
});

test('Y axis uses round ticks', () => {
  assert.deepEqual(niceScale(3.2), { max: 4, step: 1 });
  assert.deepEqual(niceScale(61), { max: 80, step: 20 });
  assert.deepEqual(niceScale(400), { max: 400, step: 100 });
  assert.deepEqual(niceScale(0), { max: 1, step: 0.25 });
});

test('Charts use one axis per measure and show the limit', () => {
  const charts = buildCharts([run()], 'en');
  assert.equal(charts.length, 8);
  const svg = renderChart(charts[2]!, 'en');
  assert.match(svg, /class="limit"/);
  assert.match(svg, /ring-fail/);
  assert.match(svg, /data-chart=/);
});

test('A single step gives no chart, the table carries the values', () => {
  assert.match(renderChartGrid([run({ steps: [step(10)] })], 'en'), /at least two load steps/);
});

test('Limits are only drawn if all compared runs share them', () => {
  const other = run({ id: 'r2', scenario: { ...scenario, slo: { ...scenario.slo, maxRttMs: 999 } } });
  const charts = buildCharts([run(), other], 'en');
  assert.equal(charts.find((c) => c.title.startsWith('RTT'))?.limit, null);
  assert.equal(charts.find((c) => c.title.startsWith('Jitter'))?.limit, 60);
});

test('Prometheus rules become their own charts', () => {
  const steps = [10, 20].map((u) => step(u, { serverMetrics: [{ name: 'BBB CPU %', value: u, max: 85 }] }));
  const chart = buildCharts([run({ steps })], 'en').at(-1);
  assert.equal(chart?.title, 'BBB CPU %');
  assert.equal(chart?.limit, 85);
});

test('The report is self-contained and escapes user input', () => {
  const html = renderRunReport(run(), 'de', 'https://grafana.example/d/x');
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /hello <b>/);
  assert.doesNotMatch(html, /src="|href="\/|rel="stylesheet"/);
  assert.match(html, /Lasttest-Bericht/);
  assert.match(html, /grafana\.example/);
  assert.match(renderRunReport(run(), 'en'), /Load test report/);
  assert.match(renderCompareReport([run(), run({ id: 'r2' })], 'en'), /Load test comparison/);
});

test('Grafana link covers the run and selects it', () => {
  assert.equal(grafanaLink(undefined, run()), undefined);
  const link = grafanaLink('https://g/d/x?orgId=1', run()) ?? '';
  assert.match(link, /orgId=1&from=\d+&to=\d+&var-run=r1$/);
});

test('CSV carries server metrics', () => {
  const steps = [step(10, { serverMetrics: [{ name: 'cpu', value: 7, max: 9 }] })];
  assert.match(renderCsv(run({ steps })), /cpu=7/);
});

test('Metrics contain quality values and escape labels', () => {
  const status = { registered: 1, expected: 1, byState: { joined: 1 }, stepCount: 1, usersPerMeeting: 10, quality: step(10) };
  const fake = { id: 'r"1', status: () => status, record: run() } as unknown as Run;
  const text = renderMetrics([fake]);
  assert.match(text, /# TYPE bbb_stress_freezes_per_minute gauge/);
  assert.match(text, /bbb_stress_audio_loss_percent\{run="r\\"1",.*\} 0\.5/);
  assert.match(text, /bbb_stress_stable_users\{.*\} 20/);
});

const fakeStarter = (outcomes: string[], started: string[], selfTestPasses = true): RunStarter => ({
  async selfTest(target) {
    started.push(`selftest:${target}`);
    return { id: 'selftest', done: Promise.resolve(selfTestPasses), stop() {} };
  },
  async start(s) {
    started.push(s.name);
    const outcome = outcomes[started.length - 1] ?? 'completed';
    if (outcome === 'throw') throw new Error('busy');
    return { id: `run${started.length}`, done: Promise.resolve(outcome as never), stop() {} };
  },
});
const request = (over = {}) => seriesRequestSchema.parse({ name: 's', scenarios: ['a', 'b', 'c'], pauseSeconds: 0, ...over });
const three = ['a', 'b', 'c'].map((name) => ({ ...scenario, name }));
const save = async () => {};

test('Series runs all scenarios in order', async () => {
  const started: string[] = [];
  const series = new Series(request(), three, fakeStarter(['limit-found', 'invalid'], started), save);
  await series.execute();
  assert.deepEqual(started, ['a', 'b', 'c']);
  assert.equal(series.record.state, 'finished');
  assert.deepEqual(series.record.runIds, ['run1', 'run2', 'run3']);
});

test('Series stops after an error unless told to continue', async () => {
  let started: string[] = [];
  let series = new Series(request(), three, fakeStarter(['error'], started), save);
  await series.execute();
  assert.deepEqual(started, ['a']);
  assert.equal(series.record.state, 'error');
  started = [];
  series = new Series(request({ continueOnError: true }), three, fakeStarter(['error'], started), save);
  await series.execute();
  assert.equal(started.length, 3);
  assert.equal(series.record.state, 'finished');
});

test('Series ends when a run cannot start', async () => {
  const series = new Series(request(), three, fakeStarter(['completed', 'throw'], []), save);
  await series.execute();
  assert.equal(series.record.state, 'error');
  assert.match(series.record.message ?? '', /busy/);
});

test('Series runs one self-test per target first', async () => {
  const started: string[] = [];
  const series = new Series(request({ selfTest: true }), three, fakeStarter([], started), save);
  await series.execute();
  assert.deepEqual(started, ['selftest:t', 'a', 'b', 'c']);
  assert.deepEqual(series.record.selfTestRunIds, ['selftest']);
  assert.equal(series.record.runIds.includes('selftest'), false);
});

test('A failed self-test starts no run', async () => {
  const started: string[] = [];
  const series = new Series(request({ selfTest: true }), three, fakeStarter([], started, false), save);
  await series.execute();
  assert.deepEqual(started, ['selftest:t']);
  assert.equal(series.record.state, 'error');
});

test('Series stop aborts the running scenario and skips the rest', async () => {
  const started: string[] = [];
  let finish: (o: never) => void = () => {};
  let stopped = false;
  const starter: RunStarter = {
    selfTest: async () => ({ id: 'x', done: Promise.resolve(true), stop() {} }),
    async start(s) {
      started.push(s.name);
      return { id: 'r', done: new Promise((resolve) => { finish = resolve; }), stop() { stopped = true; finish('aborted' as never); } };
    },
  };
  const series = new Series(request(), three, starter, save);
  const done = series.execute();
  await new Promise((resolve) => setImmediate(resolve));
  series.stop();
  await done;
  assert.equal(stopped, true);
  assert.deepEqual(started, ['a']);
  assert.equal(series.record.state, 'aborted');
});

test('HTML helper escapes quotes for attributes', () => {
  assert.equal(esc(`a"'<`), 'a&#34;&#39;&#60;');
});

test('All verdict and outcome texts exist in both languages', () => {
  for (const key of ['verdict.pass', 'verdict.fail', 'verdict.invalid', 'outcome.limit-found', 'outcome.error']) {
    assert.ok(key in dictionaries.de && key in dictionaries.en, key);
  }
});
