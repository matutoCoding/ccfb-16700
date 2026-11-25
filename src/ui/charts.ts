import type { SimulationResult } from '../types';

export interface ChartSeries {
  name: string;
  color: string;
  values: number[];
  times: number[];
  width?: number;
  dashed?: boolean;
}

export interface ChartBand { x0: number; x1: number; label?: string; tone?: 'eclipse' | 'maneuver' }
export interface ChartMarker { x: number; y: number; color: string; label: string }

export interface ChartOptions {
  width?: number;
  height?: number;
  xMax: number;
  yMax?: number;
  yLabel?: string;
  bands?: ChartBand[];
  markers?: ChartMarker[];
  threshold?: { value: number; label: string; color?: string };
  area?: boolean;
}

export function lineChartSVG(series: ChartSeries[], opts: ChartOptions): string {
  const W = opts.width ?? 960;
  const H = opts.height ?? 380;
  const m = { l: 64, r: 20, t: 18, b: 42 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const allY = series.flatMap((s) => s.values);
  if (opts.threshold) allY.push(opts.threshold.value);
  opts.markers?.forEach((mk) => allY.push(mk.y));
  const yMax = opts.yMax ?? Math.max(1, ...allY) * 1.12;
  const xMax = Math.max(1, opts.xMax);
  const x = (t: number) => m.l + (t / xMax) * iw;
  const y = (v: number) => m.t + ih - (Math.max(0, v) / yMax) * ih;

  const xTicks = 8;
  const yTicks = 5;
  const grid: string[] = [];
  for (let i = 0; i <= yTicks; i++) {
    const v = (yMax / yTicks) * i;
    const yy = y(v);
    grid.push(`<line x1="${m.l}" y1="${yy.toFixed(1)}" x2="${W - m.r}" y2="${yy.toFixed(1)}" class="chart-grid"/>`);
    grid.push(`<text x="${m.l - 9}" y="${(yy + 4).toFixed(1)}" text-anchor="end" class="chart-tick">${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}</text>`);
  }
  for (let i = 0; i <= xTicks; i++) {
    const t = (xMax / xTicks) * i;
    const xx = x(t);
    grid.push(`<line x1="${xx.toFixed(1)}" y1="${m.t}" x2="${xx.toFixed(1)}" y2="${m.t + ih}" class="chart-grid x"/>`);
    grid.push(`<text x="${xx.toFixed(1)}" y="${H - 16}" text-anchor="middle" class="chart-tick">${(t / 60).toFixed(0)}m</text>`);
  }

  const bands = (opts.bands ?? []).map((b) => {
    const bx = x(b.x0);
    const bw = Math.max(1, x(b.x1) - bx);
    const cls = b.tone === 'maneuver' ? 'chart-band maneuver' : 'chart-band eclipse';
    return `<rect x="${bx.toFixed(1)}" y="${m.t}" width="${bw.toFixed(1)}" height="${ih}" class="${cls}"/>` +
      (b.label ? `<text x="${(bx + 5).toFixed(1)}" y="${m.t + 16}" class="chart-band-label">${b.label}</text>` : '');
  }).join('');

  const threshold = opts.threshold ? `
    <line x1="${m.l}" y1="${y(opts.threshold.value)}" x2="${W - m.r}" y2="${y(opts.threshold.value)}" stroke="${opts.threshold.color ?? '#f59e0b'}" stroke-width="1.6" stroke-dasharray="7 5"/>
    <text x="${W - m.r - 6}" y="${y(opts.threshold.value) - 6}" text-anchor="end" class="chart-threshold">${opts.threshold.label}</text>` : '';

  const paths = series.map((s, si) => {
    if (!s.values.length) return '';
    const d = s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(s.times[i]).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = opts.area && si === 0
      ? `<path d="${d} L${x(s.times[s.times.length - 1]).toFixed(1)},${(m.t + ih).toFixed(1)} L${x(s.times[0]).toFixed(1)},${(m.t + ih).toFixed(1)} Z" fill="${s.color}" opacity="0.13"/>`
      : '';
    return `${area}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 2.4}" stroke-linejoin="round" stroke-linecap="round" ${s.dashed ? 'stroke-dasharray="8 5"' : ''}/>`;
  }).join('');

  const markers = (opts.markers ?? []).map((mk) => {
    const cx = x(mk.x), cy = y(mk.y);
    return `<circle cx="${cx}" cy="${cy}" r="5.5" fill="${mk.color}" stroke="#fff" stroke-width="1.5"/>
      <text x="${cx + 9}" y="${cy - 9}" class="chart-marker" fill="${mk.color}">${mk.label}</text>`;
  }).join('');

  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">
    <rect x="0" y="0" width="${W}" height="${H}" rx="12" class="chart-bg"/>
    ${grid.join('')}
    ${bands}
    ${threshold}
    ${paths}
    ${markers}
    <line x1="${m.l}" y1="${m.t + ih}" x2="${W - m.r}" y2="${m.t + ih}" class="chart-axis"/>
    <line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${m.t + ih}" class="chart-axis"/>
    <text x="18" y="${m.t + ih / 2}" transform="rotate(-90 18 ${m.t + ih / 2})" text-anchor="middle" class="chart-axis-title">${opts.yLabel ?? '功率 W'}</text>
  </svg>`;
}

export function resultPowerChart(result: SimulationResult, loadW?: number): string {
  const times = result.epochs.map((e) => e.tSec);
  const bands = result.eclipseIntervals.map((iv) => ({ x0: iv.startSec, x1: iv.endSec, label: '地影', tone: 'eclipse' as const }));
  const markers = [
    { x: result.minTotal.tSec, y: result.minTotal.powerW, color: '#ef4444', label: `全轨最小 ${result.minTotal.powerW.toFixed(0)} W` },
  ];
  if (result.minSunlit) markers.push({ x: result.minSunlit.tSec, y: result.minSunlit.powerW, color: '#f59e0b', label: `光照最差 ${result.minSunlit.powerW.toFixed(0)} W` });
  return lineChartSVG([
    { name: '总功率', color: '#38bdf8', values: result.epochs.map((e) => e.totalPowerW), times, width: 2.8 },
    { name: '直接太阳', color: '#fbbf24', values: result.epochs.map((e) => e.directPowerW), times, width: 1.4, dashed: true },
  ], {
    xMax: result.orbitPeriodSec,
    yLabel: '功率 W',
    bands,
    markers,
    threshold: loadW ? { value: loadW, label: `载荷 ${loadW.toFixed(0)} W`, color: '#fb7185' } : undefined,
    area: true,
  });
}

export function compareChart(results: Array<{ name: string; color: string; result: SimulationResult }>, loadW?: number): string {
  const period = Math.max(...results.map((r) => r.result.orbitPeriodSec));
  const series = results.map((r) => ({
    name: r.name,
    color: r.color,
    values: r.result.epochs.map((e) => e.totalPowerW),
    times: r.result.epochs.map((e) => e.tSec),
    width: 2.5,
  }));
  const first = results[0]?.result;
  const bands = first?.eclipseIntervals.map((iv) => ({ x0: iv.startSec, x1: iv.endSec, tone: 'eclipse' as const })) ?? [];
  return lineChartSVG(series, {
    xMax: period,
    yLabel: '总功率 W',
    bands,
    threshold: loadW ? { value: loadW, label: `载荷 ${loadW.toFixed(0)} W`, color: '#fb7185' } : undefined,
  });
}

export function cellColorLegendHTML(): string {
  return `<div class="legend">
    <span>0</span>
    <div class="legend-bar"></div>
    <span>1.0</span>
    <em>受照率 / 归一化辐照</em>
  </div>`;
}
