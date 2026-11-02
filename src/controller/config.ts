import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const targetSchema = z.object({
  apiUrl: z.url(),
  secret: z.string().min(1),
  checksum: z.enum(['sha1', 'sha256', 'sha384', 'sha512']).default('sha256'),
  description: z.string().default(''),
  /** Applies to API calls and browsers, so a target behind a forward proxy needs one entry only. */
  proxy: z
    .object({
      server: z.string(),
      bypass: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .optional(),
  webrtcIpPolicy: z.string().optional(),
  ignoreTlsErrors: z.boolean().default(false),
  extraChromiumArgs: z.array(z.string()).default([]),
});

const configSchema = z.object({
  adminToken: z.string().min(16),
  /** Language of run logs, step reasons and API errors. */
  language: z.enum(['de', 'en']).default('en'),
  targets: z.record(z.string(), targetSchema),
  maxBotsPerRun: z.number().int().positive().default(500),
  dataDir: z.string().default('/data'),
  scenarioDir: z.string().default('/app/scenarios'),
  /** URL under which bots reach this controller. */
  publicUrl: z.url(),
  prometheusUrl: z.url().optional(),
  grafanaUrl: z.url().optional(),
  /** Seconds to wait until every bot of a run has checked in. */
  botStartTimeoutSeconds: z.number().int().positive().default(600),
  backend: z.discriminatedUnion('type', [
    z.object({ type: z.literal('external') }),
    z.object({
      type: z.literal('kubernetes'),
      namespace: z.string(),
      image: z.string(),
      imagePullPolicy: z.string().default('IfNotPresent'),
      imagePullSecrets: z.array(z.string()).default([]),
      nodeSelector: z.record(z.string(), z.string()).default({}),
      tolerations: z.array(z.record(z.string(), z.unknown())).default([]),
      runAsUser: z.number().int().positive().default(1001),
      resourceQuotaName: z.string().optional(),
    }),
  ]),
});

export type Config = z.infer<typeof configSchema>;
export type Target = z.infer<typeof targetSchema>;
export type KubernetesBackendConfig = Extract<Config['backend'], { type: 'kubernetes' }>;

export function loadConfig(path = process.env.CONFIG_FILE ?? '/etc/bbb-stress/config.yaml'): Config {
  return configSchema.parse(parse(readFileSync(path, 'utf8')));
}
