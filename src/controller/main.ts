import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { buildSlots, resourceNeed, usersPerStep, validatePlan } from '../shared/plan.js';
import { setLanguage, t } from '../shared/i18n.js';
import type { Heartbeat } from '../shared/protocol.js';
import { scenarioSchema, type Scenario } from '../shared/scenario.js';
import { ExternalBackend, KubernetesBackend, type BotBackend } from './backend.js';
import { loadConfig } from './config.js';
import { renderCsv, renderMetrics } from './report.js';
import { Run, type RunRecord } from './runner.js';
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

const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 64 * 1024 * 1024 });
const active = new Map<string, Run>();
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

app.get('/healthz', async () => ({ ok: true }));
app.get('/', async (_req, reply) => reply.type('text/html').send(await readFile(join(uiDir, 'index.html'))));
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
    const problems = preflightProblems(scenario);
    if (problems.length) return reply.code(400).send({ error: problems.join('; ') });
    const capacity = await backend.capacity(scenario);
    if (!capacity.ok) return reply.code(409).send({ error: t('api.noCapacity', { notes: capacity.notes.join('; ') }) });
    // Two runs on one server would measure each other.
    const busy = [...active.values()].some((r) => r.record.scenario.target === scenario.target);
    if (busy) return reply.code(409).send({ error: t('api.targetBusy') });

    const target = config.targets[scenario.target]!;
    const run = new Run(scenario, target, backend, (r) => store.saveRun(r), {
      botStartTimeoutSeconds: config.botStartTimeoutSeconds,
      ...(config.prometheusUrl ? { prometheusUrl: config.prometheusUrl } : {}),
    });
    active.set(run.id, run);
    void run.execute().finally(() => setTimeout(() => active.delete(run.id), 30_000));
    // Only external bots need it: Kubernetes jobs receive the token from the backend.
    return reply.code(201).send({ id: run.id, ...(config.backend.type === 'external' ? { botToken: run.token } : {}) });
  });

  admin.get('/api/runs', async () => {
    const runs = await store.listRuns();
    return runs.map(({ log: _log, ...run }) => ({ ...run, live: active.get(run.id)?.status() }));
  });

  const findRun = async (id: string): Promise<RunRecord | undefined> =>
    active.get(id)?.record ?? (await store.listRuns()).find((r) => r.id === id);

  admin.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const run = await findRun(req.params.id);
    if (!run) return reply.code(404).send({ error: t('api.runNotFound') });
    return { ...run, live: active.get(run.id)?.status() };
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
