import type { StepResult } from '../shared/evaluate.js';
import type { Run, RunRecord } from './runner.js';

const COLUMNS = [
  'usersPerMeeting', 'totalUsers', 'verdict', 'joinFailurePct', 'joinP95Seconds', 'audioLossPct', 'videoLossPct',
  'jitterP95Ms', 'rttP95Ms', 'freezesPerMinute', 'audioPackets', 'videoPackets', 'framesDecoded', 'botCpuP95Pct', 'botThrottledP95Pct',
] as const;

const csvCell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;

export function renderCsv(run: RunRecord): string {
  const header = [...COLUMNS, 'mediaPaths', 'participants', 'videos', 'serverMetrics', 'reasons'];
  const rows = run.steps.map((step) => [
    ...COLUMNS.map((c) => step[c]),
    Object.entries(step.mediaPaths).map(([path, n]) => `${path}:${n}`).join(' '),
    step.meetingInfo.reduce((t, m) => t + m.participantCount, 0),
    step.meetingInfo.reduce((t, m) => t + m.videoCount, 0),
    (step.serverMetrics ?? []).map((m) => `${m.name}=${m.value}`).join(' '),
    step.reasons.join('; '),
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

const label = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');

const GAUGES: [string, string, (q: StepResult) => number | null][] = [
  ['bbb_stress_audio_loss_percent', 'Audio packet loss of the last minute', (q) => q.audioLossPct],
  ['bbb_stress_video_loss_percent', 'Video packet loss of the last minute', (q) => q.videoLossPct],
  ['bbb_stress_jitter_p95_milliseconds', 'Audio jitter P95 of the last minute', (q) => q.jitterP95Ms],
  ['bbb_stress_rtt_p95_milliseconds', 'Round trip time P95 of the last minute', (q) => q.rttP95Ms],
  ['bbb_stress_freezes_per_minute', 'Video freezes per stream and minute', (q) => q.freezesPerMinute],
  ['bbb_stress_join_p95_seconds', 'Join time P95 of the run so far', (q) => q.joinP95Seconds],
  ['bbb_stress_join_failure_percent', 'Share of failed or lost bots', (q) => q.joinFailurePct],
  ['bbb_stress_bot_cpu_p95_percent', 'Bot CPU P95 relative to the limit', (q) => q.botCpuP95Pct],
  ['bbb_stress_bot_throttled_p95_percent', 'Bot CPU throttling P95', (q) => q.botThrottledP95Pct],
];

export function renderMetrics(runs: Run[]): string {
  const lines = [
    '# HELP bbb_stress_bots Bots of the running test by state',
    '# TYPE bbb_stress_bots gauge',
    '# HELP bbb_stress_users_per_meeting Current load step',
    '# TYPE bbb_stress_users_per_meeting gauge',
    '# HELP bbb_stress_stable_users Highest users per meeting whose step passed',
    '# TYPE bbb_stress_stable_users gauge',
    ...GAUGES.flatMap(([name, help]) => [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`]),
  ];
  for (const run of runs) {
    const status = run.status();
    const { scenario, capacityUsers } = run.record;
    const labels = `run="${label(run.id)}",scenario="${label(scenario.name)}",target="${label(scenario.target)}"`;
    for (const [state, count] of Object.entries(status.byState)) {
      lines.push(`bbb_stress_bots{${labels},state="${label(state)}"} ${count}`);
    }
    if (status.usersPerMeeting !== undefined) lines.push(`bbb_stress_users_per_meeting{${labels}} ${status.usersPerMeeting}`);
    if (capacityUsers !== undefined) lines.push(`bbb_stress_stable_users{${labels}} ${capacityUsers}`);
    if (status.quality) {
      for (const [name, , value] of GAUGES) {
        const current = value(status.quality);
        if (current !== null) lines.push(`${name}{${labels}} ${current}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}
