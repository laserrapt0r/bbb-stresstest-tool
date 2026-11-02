import { readFile } from 'node:fs/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import { t } from '../shared/i18n.js';
import type { KubernetesBackendConfig } from './config.js';
import type { Scenario } from '../shared/scenario.js';
import { parseBytes, parseCpu, resourceNeed } from '../shared/plan.js';

export interface Capacity {
  ok: boolean;
  /** Human-readable findings for the UI. */
  notes: string[];
}

export interface BotBackend {
  start(run: { id: string; token: string; bots: number; scenario: Scenario; maxSeconds: number }): Promise<void>;
  stop(runId: string): Promise<void>;
  capacity(scenario: Scenario): Promise<Capacity>;
}

/** Bots are started by hand or from another cluster and only need the controller URL. */
export class ExternalBackend implements BotBackend {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async capacity(): Promise<Capacity> {
    return { ok: true, notes: [t('capacity.external')] };
  }
}

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

export function jobManifest(
  cfg: KubernetesBackendConfig,
  publicUrl: string,
  run: { id: string; token: string; bots: number; scenario: Scenario; maxSeconds: number },
) {
  const { bot } = run.scenario;
  const resources = { cpu: bot.cpu, memory: bot.memory };
  const labels = { 'app.kubernetes.io/name': 'bbb-stress-bot', 'bbb-stress/run': run.id };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: `bbb-stress-${run.id}`, namespace: cfg.namespace, labels },
    spec: {
      completions: run.bots,
      parallelism: run.bots,
      // A lost bot is a measurement, not something to hide with a replacement.
      backoffLimit: run.bots,
      activeDeadlineSeconds: run.maxSeconds,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          terminationGracePeriodSeconds: 10,
          nodeSelector: cfg.nodeSelector,
          tolerations: cfg.tolerations,
          imagePullSecrets: cfg.imagePullSecrets.map((name) => ({ name })),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: cfg.runAsUser,
            runAsGroup: cfg.runAsUser,
            fsGroup: cfg.runAsUser,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          topologySpreadConstraints: [
            {
              maxSkew: 1,
              topologyKey: 'kubernetes.io/hostname',
              whenUnsatisfiable: 'ScheduleAnyway',
              labelSelector: { matchLabels: labels },
            },
          ],
          containers: [
            {
              name: 'bot',
              image: cfg.image,
              imagePullPolicy: cfg.imagePullPolicy,
              command: ['node', 'dist/bot/main.js'],
              env: [
                { name: 'CONTROLLER_URL', value: publicUrl },
                { name: 'RUN_ID', value: run.id },
                { name: 'BOT_TOKEN', value: run.token },
                { name: 'HOME', value: '/tmp' },
                { name: 'BOT_ID', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
              ],
              // requests == limits: Throttling would look like a BBB problem.
              resources: { requests: resources, limits: resources },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [
                { name: 'tmp', mountPath: '/tmp' },
                { name: 'shm', mountPath: '/dev/shm' },
              ],
            },
          ],
          volumes: [
            { name: 'tmp', emptyDir: {} },
            // Counts against the memory limit of the pod.
            { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: bot.shmSize } },
          ],
        },
      },
    },
  };
}

export class KubernetesBackend implements BotBackend {
  private readonly api = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`;
  private dispatcher?: Agent;

  constructor(
    private readonly cfg: KubernetesBackendConfig,
    private readonly publicUrl: string,
  ) {}

  private async request(method: string, path: string, body?: unknown) {
    this.dispatcher ??= new Agent({ connect: { ca: await readFile(`${SA_DIR}/ca.crt`, 'utf8') } });
    const token = (await readFile(`${SA_DIR}/token`, 'utf8')).trim(); // rotates, so read it each time
    return undiciFetch(`${this.api}${path}`, {
      method,
      dispatcher: this.dispatcher,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  async start(run: Parameters<BotBackend['start']>[0]): Promise<void> {
    const res = await this.request(
      'POST',
      `/apis/batch/v1/namespaces/${this.cfg.namespace}/jobs`,
      jobManifest(this.cfg, this.publicUrl, run),
    );
    if (!res.ok) throw new Error(t('k8s.jobCreate', { status: res.status, body: await res.text() }));
  }

  async stop(runId: string): Promise<void> {
    const res = await this.request(
      'DELETE',
      `/apis/batch/v1/namespaces/${this.cfg.namespace}/jobs/bbb-stress-${runId}?propagationPolicy=Background`,
    );
    if (!res.ok && res.status !== 404) throw new Error(t('k8s.jobDelete', { status: res.status }));
  }

  async capacity(scenario: Scenario): Promise<Capacity> {
    const need = resourceNeed(scenario);
    const notes: string[] = [];
    let ok = true;
    const res = await this.request('GET', `/api/v1/namespaces/${this.cfg.namespace}/resourcequotas`);
    if (!res.ok) return { ok: true, notes: [t('capacity.quotaUnreadable', { status: res.status })] };

    const { items } = (await res.json()) as {
      items: { metadata: { name: string }; status?: { hard?: Record<string, string>; used?: Record<string, string> } }[];
    };
    if (items.length === 0) notes.push(t('capacity.noQuota'));
    for (const quota of items) {
      const { hard = {}, used = {} } = quota.status ?? {};
      const check = (key: string, needed: number, parse: (v: string) => number, unit: string) => {
        const limit = hard[key];
        if (!limit) return;
        const free = parse(limit) - parse(used[key] ?? '0');
        const fits = free >= needed;
        ok &&= fits;
        const fmt = (v: number) => (unit === 'GiB' ? (v / 1024 ** 3).toFixed(1) : v.toFixed(1));
        notes.push(t('capacity.quota', { quota: quota.metadata.name, key, needed: fmt(needed), free: fmt(free), unit }));
      };
      check('requests.cpu', need.cpu, parseCpu, 'vCPU');
      check('limits.cpu', need.cpu, parseCpu, 'vCPU');
      check('requests.memory', need.memoryBytes, parseBytes, 'GiB');
      check('limits.memory', need.memoryBytes, parseBytes, 'GiB');
      check('count/pods', need.bots, Number, 'Pods');
      check('pods', need.bots, Number, 'Pods');
    }
    return { ok, notes };
  }
}
