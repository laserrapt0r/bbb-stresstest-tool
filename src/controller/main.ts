import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { buildSlots, resourceNeed, usersPerStep, validatePlan } from '../shared/plan.js';
import { setLanguage, t, type Language } from '../shared/i18n.js';
import type { Heartbeat } from '../shared/protocol.js';
import { scenarioSchema, type Scenario } from '../shared/scenario.js';
import { ExternalBackend, KubernetesBackend, type BotBackend } from './backend.js';
import { loadConfig } from './config.js';
import { renderCsv, renderMetrics } from './report.js';
import { grafanaLink, renderCompareReport, renderCompareView, renderRunReport, renderRunView } from './reportHtml.js';
import { Run, type RunOutcome, type RunRecord } from './runner.js';
import { evaluateSelfTest, selfTestScenario } from './selftest.js';
import { Series, seriesRequestSchema, type RunStarter, type SeriesRequest } from './series.js';
import { Store } from './store.js';

const config = loadConfig();
setLanguage(config.language);
const store = new Store(config.dataDir, config.scenarioDir);
await store.init();

const backend: BotBackend =
  config.backend.type === 'kubernetes' ? new KubernetesBackend(config.backend, config.publicUrl) : new ExternalBackend();

// A controller restart cannot resume a run, so a run left open has to say so.
for (const run of await store.listRuns()) {
  if (run.phase !== 'finished') {
    await store.saveRun({ ...run, phase: 'finished', outcome: 'error', message: t('run.restarted') });
  }
}

for (const series of await store.listSeries()) {
  if (series.state === 'running') {
    await store.saveSeries({ ...series, state: 'error', pausing: false, message: t('run.restarted') });
  }
}

const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 64 * 1024 * 1024 });
const active = new Map<string, Run>();
const activeSeries = new Map<string, Series>();
const MAX_COMPARED_RUNS = 8;
const uiDir = join(dirname(fileURLToPath(import.meta.url)), 'public');

function sameToken(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const bearer = (req: FastifyRequest) => req.headers.authorization?.replace(/^Bearer /, '');

async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (!sameToken(bearer(req), config.adminToken)) await reply.code(401).send({ error: t('api.unauthorized') });
}

function preflightProblems(s: Scenario): string[] {
  const problems = validatePlan(s);
  if (!config.targets[s.target]) problems.push(t('api.unknownTarget', { target: s.target }));
  const { bots } = resourceNeed(s);
  if (bots > config.maxBotsPerRun) problems.push(t('api.botLimit', { bots, max: config.maxBotsPerRun }));
  return problems;
}

function parseScenario(body: unknown, reply: FastifyReply): Scenario | undefined {
  const parsed = scenarioSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  void reply.code(400).send({ error: z.prettifyError(parsed.error) });
  return undefined;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Starts a run in the background. Used by single runs and by test series. */
async function launchRun(
  scenario: Scenario,
  seriesId?: string,
  selfTest = false,
): Promise<{ run: Run; done: Promise<RunOutcome> }> {
  const problems = preflightProblems(scenario);
  if (problems.length) throw new HttpError(400, problems.join('; '));
  const capacity = await backend.capacity(scenario);
  if (!capacity.ok) throw new HttpError(409, t('api.noCapacity', { notes: capacity.notes.join('; ') }));
  // Two runs on one server would measure each other.
  const busy = [...active.values()].some((r) => !r.finished && r.record.scenario.target === scenario.target);
  if (busy) throw new HttpError(409, t('api.targetBusy'));

  const target = config.targets[scenario.target]!;
  const run = new Run(scenario, target, backend, (r) => store.saveRun(r), {
    botStartTimeoutSeconds: config.botStartTimeoutSeconds,
    ...(config.prometheusUrl ? { prometheusUrl: config.prometheusUrl } : {}),
    ...(seriesId ? { seriesId } : {}),
    ...(selfTest ? { selfTest: (record: RunRecord) => evaluateSelfTest(record, Boolean(target.webrtcIpPolicy)) } : {}),
  });
  active.set(run.id, run);
  const done = run.execute().then(() => {
    setTimeout(() => active.delete(run.id), 30_000);
    return run.record.outcome ?? 'error';
  });
  return { run, done };
}

const starter: RunStarter = {
  async start(scenario, seriesId) {
    const { run, done } = await launchRun(scenario, seriesId);
    return { id: run.id, done, stop: () => run.stop() };
  },
  async selfTest(target, seriesId) {
    const { run, done } = await launchRun(selfTestScenario(target), seriesId, true);
    return { id: run.id, done: done.then(() => run.record.selfTest?.ok ?? false), stop: () => run.stop() };
  },
};

async function launchSeries(request: SeriesRequest, scenarios: Scenario[]): Promise<Series> {
  if (activeSeries.size > 0) throw new HttpError(409, t('series.running'));
  // Better to fail before the first run than after hours in the third one.
  const problems = scenarios.flatMap((s) => preflightProblems(s).map((problem) => t('series.scenarioProblem', { name: s.name, problem })));
  if (problems.length) throw new HttpError(400, problems.join('; '));
  const series = new Series(request, scenarios, starter, (s) => store.saveSeries(s));
  activeSeries.set(series.id, series);
  await store.saveSeries(series.record);
  void series.execute().finally(() => activeSeries.delete(series.id));
  return series;
}

const languageOf = (req: FastifyRequest): Language =>
  (req.query as { lang?: string }).lang === 'de' ? 'de' : (req.query as { lang?: string }).lang === 'en' ? 'en' : config.language;

/** Excel and Grafana tolerate only safe names. */
const fileName = (name: string) => name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
  console.error(err);
  return reply.code(500).send({ error: String(err) });
});

app.get('/healthz', async () => ({ ok: true }));
app.get('/', async (_req, reply) => reply.type('text/html').send(await readFile(join(uiDir, 'index.html'))));
app.get('/charts.js', async (_req, reply) => reply.type('text/javascript').send(await readFile(join(uiDir, 'charts.js'))));
app.get('/charts.css', async (_req, reply) => reply.type('text/css').send(await readFile(join(uiDir, 'charts.css'))));
app.get('/metrics', async (_req, reply) => reply.type('text/plain; version=0.0.4').send(renderMetrics([...active.values()])));

app.post<{ Params: { id: string }; Body: Heartbeat }>('/internal/runs/:id/heartbeat', async (req, reply) => {
  const run = active.get(req.params.id);
  if (!run) return { command: 'stop' };
  if (!sameToken(bearer(req), run.token)) return reply.code(401).send({ error: t('api.badToken') });
  return run.heartbeat(req.body);
});

app.register(async (admin) => {
  admin.addHook('onRequest', requireAdmin);

  admin.get('/api/meta', async () => ({
    targets: Object.entries(config.targets).map(([name, t]) => ({
      name,
      description: t.description,
      viaProxy: Boolean(t.proxy),
      webrtcIpPolicy: t.webrtcIpPolicy ?? null,
    })),
    grafanaUrl: config.grafanaUrl ?? null,
    prometheus: Boolean(config.prometheusUrl),
    backend: config.backend.type,
    language: config.language,
    maxBotsPerRun: config.maxBotsPerRun,
  }));

  admin.get('/api/scenarios', async () => store.listScenarios());
  admin.put('/api/scenarios', async (req, reply) => {
    const scenario = parseScenario(req.body, reply);
    if (!scenario) return reply;
    await store.saveScenario(scenario);
    return { ok: true };
  });
  admin.delete<{ Params: { name: string } }>('/api/scenarios/:name', async (req) => {
    await store.deleteScenario(req.params.name);
    return { ok: true };
  });

  admin.post('/api/preflight', async (req, reply) => {
    const scenario = parseScenario(req.body, reply);
    if (!scenario) return reply;
    const problems = preflightProblems(scenario);
    const capacity = problems.length ? { ok: false, notes: [] } : await backend.capacity(scenario);
    const need = resourceNeed(scenario);
    return {
      ok: problems.length === 0 && capacity.ok,
      problems,
      notes: capacity.notes,
      need: { bots: need.bots, cpu: need.cpu, memoryGiB: need.memoryBytes / 1024 ** 3 },
      steps: usersPerStep(scenario.load),
      roles: Object.fromEntries(
        scenario.roles.map((r) => [r.name, buildSlots(scenario).filter((s) => s.role.name === r.name && s.meeting === 0).length]),
      ),
    };
  });

  admin.post('/api/runs', async (req, reply) => {
    const scenario = parseScenario(req.body, reply);
    if (!scenario) return reply;
    // With a self-test first, the run becomes a series of one, which handles the gate and the stop.
    if ((req.query as { selfTest?: string }).selfTest === 'true') {
      const request = seriesRequestSchema.parse({ name: scenario.name, scenarios: [scenario.name], pauseSeconds: 0, selfTest: true });
      const series = await launchSeries(request, [scenario]);
      return reply.code(201).send({ seriesId: series.id });
    }
    const { run } = await launchRun(scenario);
    // Only external bots need it: Kubernetes jobs receive the token from the backend.
    return reply.code(201).send({ id: run.id, ...(config.backend.type === 'external' ? { botToken: run.token } : {}) });
  });

  admin.get('/api/runs', async () => {
    const runs = await store.listRuns();
    return runs.map(({ log: _log, ...run }) => ({
      ...run,
      live: active.get(run.id)?.status(),
      grafanaUrl: grafanaLink(config.grafanaUrl, run as RunRecord) ?? null,
    }));
  });

  const findRun = async (id: string): Promise<RunRecord | undefined> =>
    active.get(id)?.record ?? (await store.listRuns()).find((r) => r.id === id);

  admin.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const run = await findRun(req.params.id);
    if (!run) return reply.code(404).send({ error: t('api.runNotFound') });
    const live = active.get(run.id);
    return {
      ...run,
      live: live?.status(),
      // Bots of a series start between runs, so external ones must be able to fetch the token.
      ...(live && config.backend.type === 'external' ? { botToken: live.token } : {}),
      grafanaUrl: grafanaLink(config.grafanaUrl, run) ?? null,
    };
  });

  admin.get<{ Params: { id: string } }>('/api/runs/:id/view', async (req, reply) => {
    const run = await findRun(req.params.id);
    if (!run) return reply.code(404).send({ error: t('api.runNotFound') });
    return reply.type('text/html').send(renderRunView(run, languageOf(req)));
  });

  admin.get<{ Params: { id: string } }>('/api/runs/:id/report.html', async (req, reply) => {
    const run = await findRun(req.params.id);
    if (!run) return reply.code(404).send({ error: t('api.runNotFound') });
    return reply
      .type('text/html')
      .header('content-disposition', `attachment; filename="${fileName(run.id)}.html"`)
      .send(renderRunReport(run, languageOf(req), config.grafanaUrl));
  });

  const comparedRuns = async (req: FastifyRequest): Promise<RunRecord[]> => {
    const ids = ((req.query as { ids?: string }).ids ?? '').split(',').filter(Boolean);
    if (ids.length < 2) throw new HttpError(400, t('series.tooFewRuns'));
    if (ids.length > MAX_COMPARED_RUNS) throw new HttpError(400, t('series.tooManyRuns', { max: MAX_COMPARED_RUNS }));
    const runs = await store.listRuns();
    const found = ids.map((id) => runs.find((r) => r.id === id));
    if (found.some((r) => !r)) throw new HttpError(404, t('api.runNotFound'));
    return (found as RunRecord[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  };

  admin.get('/api/compare/view', async (req, reply) =>
    reply.type('text/html').send(renderCompareView(await comparedRuns(req), languageOf(req))),
  );

  admin.get('/api/compare/report.html', async (req, reply) =>
    reply
      .type('text/html')
      .header('content-disposition', 'attachment; filename="comparison.html"')
      .send(renderCompareReport(await comparedRuns(req), languageOf(req))),
  );

  admin.post('/api/selftest', async (req, reply) => {
    const target = (req.body as { target?: string } | undefined)?.target ?? '';
    if (!config.targets[target]) throw new HttpError(400, t('api.unknownTarget', { target }));
    const { run } = await launchRun(selfTestScenario(target), undefined, true);
    return reply.code(201).send({ id: run.id, ...(config.backend.type === 'external' ? { botToken: run.token } : {}) });
  });

  admin.get('/api/series', async () => store.listSeries());

  admin.post('/api/series', async (req, reply) => {
    const parsed = seriesRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    const request = parsed.data;
    const known = await store.listScenarios();
    const scenarios = request.scenarios.map((name) => {
      const entry = known.find((k) => k.scenario.name === name);
      if (!entry) throw new HttpError(400, t('series.unknownScenario', { name }));
      return entry.scenario;
    });
    const series = await launchSeries(request, scenarios);
    return reply.code(201).send({ id: series.id });
  });

  admin.post<{ Params: { id: string } }>('/api/series/:id/stop', async (req, reply) => {
    const series = activeSeries.get(req.params.id);
    if (!series) return reply.code(404).send({ error: t('series.notFound') });
    series.stop();
    return { ok: true };
  });

  admin.get<{ Params: { id: string } }>('/api/runs/:id/report.csv', async (req, reply) => {
    const run = await findRun(req.params.id);
    if (!run) return reply.code(404).send({ error: t('api.runNotFound') });
    return reply
      .type('text/csv')
      .header('content-disposition', `attachment; filename="${run.id}.csv"`)
      .send(renderCsv(run));
  });

  admin.post<{ Params: { id: string } }>('/api/runs/:id/stop', async (req, reply) => {
    const run = active.get(req.params.id);
    if (!run) return reply.code(404).send({ error: t('api.noActiveRun') });
    run.stop();
    return { ok: true };
  });
});

const port = Number(process.env.PORT ?? 8080);
await app.listen({ host: '0.0.0.0', port });
console.log(`Controller listening on port ${port}`);
