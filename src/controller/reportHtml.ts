import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from '../shared/i18n.js';
import { tr } from '../shared/i18n.js';
import { esc, renderChartGrid, runLabel } from './charts.js';
import type { RunRecord, StepRecord } from './runner.js';
import { renderSelfTest } from './selftest.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');
const asset = (name: string) => readFileSync(join(publicDir, name), 'utf8');

export function grafanaLink(base: string | undefined, run: RunRecord): string | undefined {
  if (!base) return undefined;
  const pad = 60_000;
  const from = new Date(run.createdAt).getTime() - pad;
  const to = new Date(run.finishedAt ?? Date.now()).getTime() + pad;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}from=${from}&to=${to}&var-run=${encodeURIComponent(run.id)}`;
}

export function mediaPaths(run: RunRecord): string {
  return [...new Set(run.steps.flatMap((s) => Object.keys(s.mediaPaths)))].join(', ') || '–';
}

const fixed = (value: number | null) => (value === null ? '–' : String(Math.round(value * 100) / 100));
const sum = (step: StepRecord, key: 'participantCount' | 'videoCount') => step.meetingInfo.reduce((t, m) => t + m[key], 0);

export function stepsTable(run: RunRecord, language: Language): string {
  const head = ['report.usersPerMeeting', 'report.result', 'report.joinFailure', 'report.joinP95', 'report.audioLoss', 'report.videoLoss', 'report.jitter', 'report.rtt', 'report.freezes', 'report.botCpuShort', 'report.bbbCounts', 'report.mediaPath', 'report.reason'];
  const rows = run.steps.map((s) => {
    const cells = [
      s.usersPerMeeting,
      `<span class="verdict ${s.verdict}">${esc(tr(language, `verdict.${s.verdict}`))}</span>`,
      s.joinFailurePct, fixed(s.joinP95Seconds), s.audioLossPct, s.videoLossPct, fixed(s.jitterP95Ms), fixed(s.rttP95Ms),
      s.freezesPerMinute, fixed(s.botCpuP95Pct), `${sum(s, 'participantCount')}/${sum(s, 'videoCount')}`,
      esc(Object.entries(s.mediaPaths).map(([path, n]) => `${path}: ${n}`).join(', ')),
      esc(s.reasons.join('; ')),
    ];
    return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  });
  return `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${esc(tr(language, h))}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function rolesTable(run: RunRecord, language: Language): string {
  const yes = (v: boolean | undefined) => esc(tr(language, v ? 'report.yes' : 'report.no'));
  const head = ['report.role', 'report.count', 'report.moderator', 'report.audio', 'report.camera', 'report.screen'];
  const rows = run.scenario.roles.map(
    (r) => `<tr><td>${esc(r.name)}</td><td>${r.fill ? esc(tr(language, 'report.fill')) : r.count}</td><td>${yes(r.moderator)}</td><td>${esc(r.audio)}${r.muted ? ' (muted)' : ''}</td><td>${yes(r.webcam)}</td><td>${yes(r.screenshare)}</td></tr>`,
  );
  return `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${esc(tr(language, h))}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function duration(run: RunRecord): string {
  if (!run.finishedAt) return '–';
  const seconds = Math.round((new Date(run.finishedAt).getTime() - new Date(run.createdAt).getTime()) / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

function tile(value: string, label: string): string {
  return `<div class="tile"><b>${esc(value)}</b><small>${esc(label)}</small></div>`;
}

export function runTiles(run: RunRecord, language: Language): string {
  return `<div class="tiles">${[
    tile(run.capacityUsers !== undefined ? String(run.capacityUsers) : tr(language, 'report.noStable'), tr(language, 'report.stable')),
    tile(tr(language, `outcome.${run.outcome ?? 'error'}`), tr(language, 'report.outcome')),
    tile(mediaPaths(run), tr(language, 'report.mediaPath')),
    tile(duration(run), tr(language, 'report.duration')),
  ].join('')}</div>`;
}

export function compareTable(runs: RunRecord[], language: Language): string {
  const head = ['report.run', 'report.target', 'report.meetings', 'report.stable', 'report.outcome', 'report.mediaPath'];
  const rows = runs.map(
    (r) => `<tr><td>${esc(runLabel(r, language))}</td><td>${esc(r.scenario.target)}</td><td>${r.scenario.meetings}</td><td>${r.capacityUsers ?? '–'}</td><td>${esc(tr(language, `outcome.${r.outcome ?? 'error'}`))}</td><td>${esc(mediaPaths(r))}</td></tr>`,
  );
  return `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${esc(tr(language, h))}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

const REPORT_CSS = `
*{box-sizing:border-box}body{margin:0;background:#f6f7f9;font:15px/1.5 system-ui,sans-serif}
main.viz-root{max-width:1100px;margin:0 auto;padding:24px 16px;background:transparent}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px}p{margin:0 0 10px}
table{border-collapse:collapse;width:100%;font-size:13px;background:var(--surface-1)}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--hairline);white-space:nowrap}th{color:var(--text-secondary);font-weight:500}
.scroll{overflow-x:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;background:var(--surface-1);border:1px solid var(--hairline);border-radius:8px;padding:12px;margin:0}
a{color:var(--series-1)}.verdict.fail{font-weight:600}.verdict.invalid{font-style:italic}
@media (prefers-color-scheme:dark){body{background:#111110}}
@media print{body{background:#fff}.scroll{overflow:visible}th,td{white-space:normal}}`;

function page(title: string, language: Language, body: string): string {
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${asset('charts.css')}${REPORT_CSS}</style></head><body><main class="viz-root">${body}<p class="muted" style="margin-top:28px">${esc(tr(language, 'report.generated', { date: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC' }))}</p></main><script>${asset('charts.js').replaceAll('</script', '<\\/script')}</script></body></html>`;
}

/** Self-contained: one file with all data, styles and scripts, so it can be mailed or archived. */
export function renderRunReport(run: RunRecord, language: Language, grafanaUrl?: string): string {
  const link = grafanaLink(grafanaUrl, run);
  const { load } = run.scenario;
  const log = run.log.map((l) => `${l.at.slice(11, 19)}  ${l.text}`).join('\n');
  const loadText = load.mode === 'steps'
    ? `${load.startUsers} → ${load.maxUsers} (+${load.stepUsers}) · ${load.joinPerSecond}/s · ${load.holdSeconds} s`
    : `${load.usersPerMeeting} · ${load.joinPerSecond}/s · ${load.holdSeconds} s`;
  return page(
    `${tr(language, 'report.title')}: ${run.scenario.name}`,
    language,
    `<h1>${esc(tr(language, 'report.title'))}</h1>
<p class="muted">${esc(run.scenario.name)} · ${esc(tr(language, 'report.target'))}: ${esc(run.scenario.target)} · ${esc(tr(language, 'report.started'))}: ${esc(run.createdAt.slice(0, 16).replace('T', ' '))} UTC · ${esc(tr(language, 'report.meetings'))}: ${run.scenario.meetings}${link ? ` · <a href="${esc(link)}">${esc(tr(language, 'report.grafana'))}</a>` : ''}</p>
${run.message ? `<p>${esc(run.message)}</p>` : ''}
${run.selfTest ? renderSelfTest(run.selfTest, language) : ''}
${runTiles(run, language)}
<h2>${esc(tr(language, 'report.charts'))}</h2>${renderChartGrid([run], language)}
<h2>${esc(tr(language, 'report.steps'))}</h2>${stepsTable(run, language)}
<h2>${esc(tr(language, 'report.roles'))}</h2>${rolesTable(run, language)}
<p class="muted" style="margin-top:8px">${esc(tr(language, 'report.load'))}: ${esc(loadText)}</p>
<h2>${esc(tr(language, 'report.log'))}</h2><pre>${esc(log)}</pre>`,
  );
}

export function renderCompareReport(runs: RunRecord[], language: Language): string {
  return page(
    tr(language, 'report.compareTitle'),
    language,
    `<h1>${esc(tr(language, 'report.compareTitle'))}</h1>
<h2>${esc(tr(language, 'report.comparedRuns'))}</h2>${compareTable(runs, language)}
<h2>${esc(tr(language, 'report.charts'))}</h2><p class="muted">${esc(tr(language, 'report.compareNote'))}</p>${renderChartGrid(runs, language)}
${runs.map((r) => `<h2>${esc(runLabel(r, language))}</h2>${stepsTable(r, language)}`).join('')}`,
  );
}

export function renderCompareView(runs: RunRecord[], language: Language): string {
  return `<div class="viz-root">${compareTable(runs, language)}<p class="muted" style="margin:10px 0">${esc(tr(language, 'report.compareNote'))}</p>${renderChartGrid(runs, language)}</div>`;
}

export function renderRunView(run: RunRecord, language: Language): string {
  if (run.selfTest) return `<div class="viz-root">${renderSelfTest(run.selfTest, language)}</div>`;
  return `<div class="viz-root">${runTiles(run, language)}${renderChartGrid([run], language)}</div>`;
}
