import { z } from 'zod';
import { t } from './i18n.js';

const quantity = z.string().regex(/^\d+(\.\d+)?(m|Ki|Mi|Gi)?$/);

export const roleSchema = z
  .object({
    name: z.string().min(1).max(40),
    /** Fixed number of users per meeting. Exactly one role may use `fill` instead. */
    count: z.number().int().positive().optional(),
    /** Takes every seat left after the fixed roles: this role grows with the load. */
    fill: z.boolean().optional(),
    moderator: z.boolean().default(false),
    audio: z.enum(['none', 'listen', 'microphone']).default('listen'),
    /** Keeps a microphone muted. Muted users do not load the audio mixing. */
    muted: z.boolean().default(false),
    webcam: z.boolean().default(false),
    screenshare: z.boolean().default(false),
    /** Presenter activity: moves to the next slide in this interval. */
    nextSlideEverySeconds: z.number().int().positive().optional(),
  })
  .refine((r) => (r.count !== undefined) !== (r.fill === true), {
    error: () => t('role.countOrFill'),
  })
  .refine((r) => !r.screenshare || r.moderator, {
    error: () => t('role.screenshareModerator'),
  });

export const sloSchema = z.object({
  maxJoinFailurePct: z.number().min(0).default(2),
  maxJoinP95Seconds: z.number().positive().default(45),
  maxAudioLossPct: z.number().min(0).default(3),
  maxVideoLossPct: z.number().min(0).default(3),
  maxJitterMs: z.number().positive().default(60),
  maxRttMs: z.number().positive().default(400),
  /** Video freezes per received stream and minute. Over TCP this is the key signal: TCP hides loss. */
  maxFreezesPerMinute: z.number().min(0).default(3),
  /** Above these values the load generator is the bottleneck: the step is invalid, not failed. */
  maxBotCpuPct: z.number().positive().default(85),
  maxBotThrottledPct: z.number().min(0).default(10),
  /** Optional server-side limits, evaluated against Prometheus (instant query). */
  prometheus: z
    .array(z.object({ name: z.string(), query: z.string(), max: z.number() }))
    .default([]),
});

export const scenarioSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).default(''),
  /** Optional English texts for the templates. The UI picks them by language. */
  nameEn: z.string().max(100).optional(),
  descriptionEn: z.string().max(1000).optional(),
  target: z.string().min(1),
  meetings: z.number().int().positive().default(1),
  meeting: z
    .object({
      /** Passed to /create as is, e.g. webcamsOnlyForModerator or the v4 audioBridge. */
      createParams: z.record(z.string(), z.string()).default({}),
      /** Must be reachable by the BBB server, which rejects private addresses. */
      presentationUrl: z.url().optional(),
      /** Sent along with /create, so it works without any web server. */
      presentationFile: z.object({ name: z.string().min(1), base64: z.string().min(1) }).optional(),
    })
    .default({ createParams: {} }),
  roles: z.array(roleSchema).min(1),
  load: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('fixed'),
      usersPerMeeting: z.number().int().positive(),
      joinPerSecond: z.number().positive().default(1),
      holdSeconds: z.number().int().positive().default(300),
      settleSeconds: z.number().int().min(0).default(30),
    }),
    z.object({
      mode: z.literal('steps'),
      startUsers: z.number().int().positive(),
      stepUsers: z.number().int().positive(),
      maxUsers: z.number().int().positive(),
      joinPerSecond: z.number().positive().default(1),
      holdSeconds: z.number().int().positive().default(180),
      settleSeconds: z.number().int().min(0).default(30),
    }),
  ]),
  slo: sloSchema.prefault({}),
  bot: z
    .object({
      cpu: quantity.default('2'),
      memory: quantity.default('3Gi'),
      shmSize: quantity.default('512Mi'),
    })
    .prefault({}),
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type Role = z.infer<typeof roleSchema>;
export type Slo = z.infer<typeof sloSchema>;
