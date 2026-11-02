import type { Run, RunRecord } from './runner.js';

const COLUMNS = [
  'usersPerMeeting', 'totalUsers', 'verdict', 'joinFailurePct', 'joinP95Seconds', 'audioLossPct', 'videoLossPct',
  'jitterP95Ms', 'rttP95Ms', 'freezesPerMinute', 'audioPackets', 'videoPackets', 'framesDecoded', 'botCpuP95Pct', 'botThrottledP95Pct',
] as const;

const csvCell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;

export function renderCsv(run: RunRecord): string {
  const header = [...COLUMNS, 'mediaPaths', 'participants', 'videos', 'reasons'];
  const rows = run.steps.map((step) => [
    ...COLUMNS.map((c) => step[c]),
    Object.entries(step.mediaPaths).map(([path, n]) => `${path}:${n}`).join(' '),
    step.meetingInfo.reduce((t, m) => t + m.participantCount, 0),
    step.meetingInfo.reduce((t, m) => t + m.videoCount, 0),
    step.reasons.join('; '),
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

export function renderMetrics(runs: Run[]): string {
  const lines = [
    '# HELP bbb_stress_bots Bots of the running test by state',
    '# TYPE bbb_stress_bots gauge',
    '# HELP bbb_stress_users_per_meeting Current load step',
    '# TYPE bbb_stress_users_per_meeting gauge',
  ];
  for (const run of runs) {
    const status = run.status();
    for (const [state, count] of Object.entries(status.byState)) {
      lines.push(`bbb_stress_bots{run="${run.id}",state="${state}"} ${count}`);
    }
    if (status.usersPerMeeting !== undefined) {
      lines.push(`bbb_stress_users_per_meeting{run="${run.id}"} ${status.usersPerMeeting}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
