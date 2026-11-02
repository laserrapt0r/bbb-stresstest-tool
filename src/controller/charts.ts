import type { Language } from '../shared/i18n.js';
import { tr } from '../shared/i18n.js';
import type { RunRecord, StepRecord } from './runner.js';

export const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Verdict = StepRecord['verdict'];

export interface ChartPoint {
  x: number;
  y: number | null;
  verdict: Verdict;
}

export interface ChartSeries {
  label: string;
  points: ChartPoint[];
}

export interface Chart {
  title: string;
  unit: string;
  limit: number | null;
  series: ChartSeries[];
}

const WIDTH = 360;
const HEIGHT = 196;
const MARGIN = { left: 44, right: 14, top: 14, bottom: 26 };
/** Shapes carry identity next to the color, also in print and for color-blind readers. */
const MAX_SERIES = 8;

/** About four intervals with round tick values. */
export function niceScale(value: number): { max: number; step: number } {
  if (value <= 0) return { max: 1, step: 0.25 };
  const rough = value / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((n) => rough <= n * magnitude) ?? 10) * magnitude;
  return { max: Math.ceil(value / step - 1e-9) * step, step };
}

const number = (value: number, language: Language) =>
  new Intl.NumberFormat(language === 'de' ? 'de-DE' : 'en-GB', { maximumFractionDigits: 2 }).format(value);

function marker(shape: number, x: number, y: number, extra: string): string {
  const s = 4.5;
  switch (shape % 4) {
    case 1:
      return `<rect x="${x - s + 0.5}" y="${y - s + 0.5}" width="${2 * s - 1}" height="${2 * s - 1}" rx="1" ${extra}/>`;
    case 2:
      return `<path d="M${x} ${y - s - 1}L${x + s + 1} ${y}L${x} ${y + s + 1}L${x - s - 1} ${y}Z" ${extra}/>`;
    case 3:
      return `<path d="M${x} ${y - s - 1}L${x + s + 1} ${y + s}L${x - s - 1} ${y + s}Z" ${extra}/>`;
    default:
      return `<circle cx="${x}" cy="${y}" r="${s}" ${extra}/>`;
  }
}

/** Static SVG. charts.js adds crosshair and tooltip on top, so reports also work when printed. */
export function renderChart(chart: Chart, language: Language): string {
  const xs = [...new Set(chart.series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b);
  const values = chart.series.flatMap((s) => s.points.flatMap((p) => (p.y === null ? [] : [p.y])));
  if (xs.length < 2 || values.length === 0) return '';

  const plotW = WIDTH - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const [minX, maxX] = [xs[0] ?? 0, xs.at(-1) ?? 1];
  const scale = niceScale(Math.max(...values, chart.limit ?? 0));
  const yMax = scale.max;
  const px = (x: number) => Math.round((MARGIN.left + ((x - minX) / (maxX - minX || 1)) * plotW) * 10) / 10;
  const py = (y: number) => Math.round((MARGIN.top + plotH - (y / yMax) * plotH) * 10) / 10;

  const ticks = Array.from({ length: Math.round(yMax / scale.step) + 1 }, (_, i) => i * scale.step);
  const grid = ticks.map((tick) => {
    const y = py(tick);
    return `<line class="grid" x1="${MARGIN.left}" x2="${WIDTH - MARGIN.right}" y1="${y}" y2="${y}"/><text class="tick" x="${MARGIN.left - 6}" y="${y + 3.5}" text-anchor="end">${esc(number(tick, language))}</text>`;
  });
  const every = Math.ceil(xs.length / 7);
  const xTicks = xs
    .filter((_, i) => i % every === 0)
    .map((x) => `<text class="tick" x="${px(x)}" y="${HEIGHT - 8}" text-anchor="middle">${x}</text>`);

  let limit = '';
  if (chart.limit !== null) {
    const y = py(chart.limit);
    limit = `<line class="limit" x1="${MARGIN.left}" x2="${WIDTH - MARGIN.right}" y1="${y}" y2="${y}"/><text class="limit-label" x="${MARGIN.left + 4}" y="${y - 4}">${esc(tr(language, 'report.limit'))} ${esc(number(chart.limit, language))}</text>`;
  }

  const lines = chart.series.map((series, index) => {
    const slot = (index % MAX_SERIES) + 1;
    const segments: string[][] = [[]];
    const marks: string[] = [];
    for (const point of series.points) {
      if (point.y === null) {
        segments.push([]);
        continue;
      }
      const [x, y] = [px(point.x), py(point.y)];
      segments.at(-1)?.push(`${x} ${y}`);
      if (point.verdict !== 'pass') marks.push(`<circle class="ring ring-${point.verdict}" cx="${x}" cy="${y}" r="8"/>`);
      marks.push(marker(index, x, y, `class="dot s${slot}"`));
    }
    const paths = segments
      .filter((s) => s.length > 1)
      .map((s) => `<path class="line s${slot}" d="M${s.join('L')}"/>`);
    return paths.join('') + marks.join('');
  });

  const readout = {
    xs: xs.map(px),
    rows: xs.map((x) => ({
      x,
      series: chart.series.flatMap((series, index) => {
        const point = series.points.find((p) => p.x === x);
        if (!point || point.y === null) return [];
        const value = `${number(point.y, language)}${chart.unit ? ` ${chart.unit}` : ''}`;
        return [{
          slot: (index % MAX_SERIES) + 1,
          label: series.label,
          value,
          ...(point.verdict === 'pass' ? {} : { verdict: tr(language, `verdict.${point.verdict}`) }),
        }];
      }),
    })),
    top: MARGIN.top,
    bottom: HEIGHT - MARGIN.bottom,
    xLabel: tr(language, 'report.usersPerMeeting'),
  };

  return `<figure class="chart"><figcaption>${esc(chart.title)}</figcaption>
<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" tabindex="0" aria-label="${esc(chart.title)}" data-chart="${esc(JSON.stringify(readout))}">
${grid.join('')}${xTicks.join('')}${limit}${lines.join('')}<line class="crosshair" y1="${MARGIN.top}" y2="${HEIGHT - MARGIN.bottom}" x1="0" x2="0"/></svg></figure>`;
}

const METRICS: {
  key: string;
  unit: string;
  value: (s: StepRecord) => number | null;
  limit: (r: RunRecord) => number;
}[] = [
  { key: 'slo.audioLoss', unit: '%', value: (s) => s.audioLossPct, limit: (r) => r.scenario.slo.maxAudioLossPct },
  { key: 'slo.videoLoss', unit: '%', value: (s) => s.videoLossPct, limit: (r) => r.scenario.slo.maxVideoLossPct },
  { key: 'slo.freezes', unit: '', value: (s) => s.freezesPerMinute, limit: (r) => r.scenario.slo.maxFreezesPerMinute },
  { key: 'slo.jitter', unit: 'ms', value: (s) => s.jitterP95Ms, limit: (r) => r.scenario.slo.maxJitterMs },
  { key: 'slo.rtt', unit: 'ms', value: (s) => s.rttP95Ms, limit: (r) => r.scenario.slo.maxRttMs },
  { key: 'slo.joinP95', unit: 's', value: (s) => s.joinP95Seconds, limit: (r) => r.scenario.slo.maxJoinP95Seconds },
  { key: 'slo.joinFailure', unit: '%', value: (s) => s.joinFailurePct, limit: (r) => r.scenario.slo.maxJoinFailurePct },
  { key: 'report.botCpu', unit: '%', value: (s) => s.botCpuP95Pct, limit: (r) => r.scenario.slo.maxBotCpuPct },
];

/** Compared runs can have different limits. A line is only true if all of them agree. */
function sharedLimit(runs: RunRecord[], limit: (r: RunRecord) => number): number | null {
  const limits = new Set(runs.map(limit));
  return limits.size === 1 ? ([...limits][0] ?? null) : null;
}

export function runLabel(run: RunRecord, language: Language): string {
  const time = new Date(run.createdAt).toLocaleString(language === 'de' ? 'de-DE' : 'en-GB', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
  return `${run.scenario.name} (${time} UTC)`;
}

export function buildCharts(runs: RunRecord[], language: Language): Chart[] {
  const chart = (
    title: string,
    unit: string,
    limit: number | null,
    value: (s: StepRecord) => number | null,
  ): Chart => ({
    title,
    unit,
    limit,
    series: runs.map((run) => ({
      label: runLabel(run, language),
      points: run.steps.map((s) => ({ x: s.usersPerMeeting, y: value(s), verdict: s.verdict })),
    })),
  });
  const charts = METRICS.map((m) => chart(tr(language, m.key), m.unit, sharedLimit(runs, m.limit), m.value));

  const serverNames = [...new Set(runs.flatMap((r) => r.steps.flatMap((s) => (s.serverMetrics ?? []).map((m) => m.name))))];
  for (const name of serverNames) {
    const find = (s: StepRecord) => s.serverMetrics?.find((m) => m.name === name);
    const limits = new Set(runs.flatMap((r) => r.steps.flatMap((s) => find(s)?.max ?? [])));
    charts.push(chart(name, '', limits.size === 1 ? ([...limits][0] ?? null) : null, (s) => find(s)?.value ?? null));
  }
  return charts;
}

function legend(runs: RunRecord[], language: Language): string {
  const items =
    runs.length < 2
      ? ''
      : runs
          .map((run, index) => {
            const slot = (index % MAX_SERIES) + 1;
            return `<span class="key"><svg width="26" height="14" aria-hidden="true"><line class="line s${slot}" x1="1" x2="25" y1="7" y2="7"/>${marker(index, 13, 7, `class="dot s${slot}"`)}</svg>${esc(runLabel(run, language))}</span>`;
          })
          .join('');
  const usesVerdict = (verdict: Verdict) => runs.some((r) => r.steps.some((s) => s.verdict === verdict));
  const status = (['fail', 'invalid'] as const)
    .filter(usesVerdict)
    .map(
      (verdict) =>
        `<span class="key"><svg width="20" height="20" aria-hidden="true"><circle class="ring ring-${verdict}" cx="10" cy="10" r="7"/></svg>${esc(tr(language, `verdict.long.${verdict}`))}</span>`,
    )
    .join('');
  return `<div class="legend">${items}${status}<span class="key muted">${esc(tr(language, 'report.axisNote'))}</span></div>`;
}

/** Small multiples: one measure per chart, all on the same user axis. */
export function renderChartGrid(runs: RunRecord[], language: Language): string {
  const figures = buildCharts(runs, language).map((c) => renderChart(c, language)).filter(Boolean);
  if (figures.length === 0) return `<p class="muted">${esc(tr(language, 'report.noCharts'))}</p>`;
  return `${legend(runs, language)}<div class="chart-grid">${figures.join('')}</div>`;
}
