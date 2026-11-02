import { tr, type Language } from '../shared/i18n.js';
import { esc } from './charts.js';
import { scenarioSchema, type Scenario } from '../shared/scenario.js';
import type { RunRecord } from './runner.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface SelfTestCheck {
  id: string;
  status: CheckStatus;
  detail?: string;
}

export interface SelfTestResult {
  ok: boolean;
  checks: SelfTestCheck[];
}

/** Two bots are enough to prove every path: one sends screen and audio, one sends camera and receives. */
export function selfTestScenario(target: string): Scenario {
  return scenarioSchema.parse({
    name: 'Self-test',
    target,
    meetings: 1,
    roles: [
      { name: 'presenter', count: 1, moderator: true, audio: 'microphone', screenshare: true },
      { name: 'camera', count: 1, audio: 'listen', webcam: true },
    ],
    load: { mode: 'fixed', usersPerMeeting: 2, joinPerSecond: 1, holdSeconds: 20, settleSeconds: 5 },
  });
}

/** Options like the presentation controls can be absent without harming the load test. */
const OPTIONAL_SELECTORS = new Set(['nextSlide']);

export function evaluateSelfTest(run: RunRecord, expectRelay: boolean): SelfTestResult {
  const checks: SelfTestCheck[] = [];
  const add = (id: string, status: CheckStatus, detail?: string) =>
    checks.push({ id, status, ...(detail ? { detail } : {}) });
  const step = run.steps[0];

  if (!step) {
    add('start', 'fail', run.message ?? run.botErrors);
    return { ok: false, checks };
  }
  add('start', 'ok');

  const joinOk = step.joinFailurePct === 0;
  add('join', joinOk ? 'ok' : 'fail', joinOk ? `${step.joinP95Seconds ?? '–'} s` : run.botErrors);

  const missing = run.missingSelectors ?? [];
  const required = missing.filter((name) => !OPTIONAL_SELECTORS.has(name));
  add('selectors', required.length ? 'fail' : missing.length ? 'warn' : 'ok', missing.join(', ') || undefined);

  add('audio', step.audioPackets > 0 ? 'ok' : 'fail', String(step.audioPackets));
  add('video', step.framesDecoded > 0 ? 'ok' : 'fail', String(step.framesDecoded));

  const info = step.meetingInfo[0];
  const countsOk = info?.participantCount === 2 && info.videoCount === 1;
  add('bbb', countsOk ? 'ok' : 'fail', info ? `${info.participantCount}/${info.videoCount}` : undefined);

  const paths = Object.keys(step.mediaPaths);
  const relayOnly = paths.length > 0 && paths.every((path) => path.startsWith('relay'));
  add('mediaPath', paths.length === 0 || (expectRelay && !relayOnly) ? 'fail' : 'ok', paths.join(', ') || undefined);

  const cpu = step.botCpuP95Pct ?? 0;
  add('botLoad', cpu > run.scenario.slo.maxBotCpuPct ? 'warn' : 'ok', `${cpu} %`);

  return { ok: !checks.some((c) => c.status === 'fail'), checks };
}

export function renderSelfTest(result: SelfTestResult, language: Language): string {
  const label = { ok: 'selftest.ok', warn: 'selftest.warn', fail: 'selftest.fail' } as const;
  const rows = result.checks.map((check) => {
    const hint = check.status === 'ok' ? '' : tr(language, `selftest.hint.${check.id}`);
    return `<tr><td class="check ${check.status}">${esc(tr(language, label[check.status]))}</td><td>${esc(tr(language, `selftest.check.${check.id}`))}</td><td>${esc(check.detail ?? '')}</td><td class="hint">${esc(hint)}</td></tr>`;
  });
  return `<p class="selftest-summary"><b>${esc(tr(language, result.ok ? 'selftest.passed' : 'selftest.failed'))}</b></p><div class="scroll"><table class="selftest"><tbody>${rows.join('')}</tbody></table></div>`;
}
