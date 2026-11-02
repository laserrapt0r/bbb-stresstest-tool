import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobManifest } from '../src/controller/backend.ts';
import { scenarioSchema } from '../src/shared/scenario.ts';

const scenario = scenarioSchema.parse({
  name: 'x', target: 't', roles: [{ name: 'a', fill: true }], load: { mode: 'fixed', usersPerMeeting: 5 },
  bot: { cpu: '2', memory: '3Gi', shmSize: '512Mi' },
});
const job = jobManifest(
  { type: 'kubernetes', namespace: 'ns', image: 'img', imagePullPolicy: 'Always', imagePullSecrets: ['p'], nodeSelector: {}, tolerations: [], runAsUser: 1001 },
  'http://ctl:8080',
  { id: 'r1', token: 't', bots: 5, scenario, maxSeconds: 100 },
);

test('Job meets the restricted pod security profile', () => {
  const pod = job.spec.template.spec;
  const container = pod.containers[0]!;
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  assert.equal('hostNetwork' in pod, false);
  assert.equal(pod.volumes.every((v) => 'emptyDir' in v), true);
});

test('Requests equal limits, so throttling cannot look like a BBB problem', () => {
  const { resources } = job.spec.template.spec.containers[0]!;
  assert.deepEqual(resources.requests, resources.limits);
});

test('Job is guaranteed to end and cleans up', () => {
  assert.equal(job.spec.activeDeadlineSeconds, 100);
  assert.ok(job.spec.ttlSecondsAfterFinished > 0);
  assert.equal(job.spec.completions, 5);
});
