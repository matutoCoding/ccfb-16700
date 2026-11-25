import { formatClock } from '../lib/format';

export interface ChartPoint { x: number; y: number }
export interface ChartSeries {
  name: string;
  color: string;
  points: ChartPoint[];
  dashed?: boolean;
  axis?: 'y' | 'load';
}
export interface ChartBand { x0: number; x1: number; label?: string; color?: string }
export interface ChartMarker { x: number; y: number; label: string; color?: string }

export interface LineChartOptions {
  series: ChartSeries[];
  bands?: ChartBand[];
  markers?: ChartMarker[];
  height?: number;
  yLabel?: string;
  xMax?: number;
  zeroLine?: boolean;
}

export function renderLineChart(opts: LineChartOptions): string {
  const width = 980;
  const height = opts.height ?? 390;
  const m = { l: 64, r: 24, t: 28, b: 46 };
  const iw = width - m.l - m.r;
  const ih = height - m.t - m.b;
  const all = opts.series.flatMap((s) => s.points);
  if (!all.length) return '<div class="empty">暂无可绘制数据</div>';
  const xMin = 0;
  const xMax = opts.xMax ?? Math.max(...all.map((p) => p.x));
  let yMin = Math.min(0, ...all.map((p) => p.y));
  let yMax = Math.max(...all.map((p) => p.y), 1);
  const pad = (yMax - yMin) * 0.08 || 1;
  yMin = Math.min(0, yMin - pad * 0.2);
  yMax += pad;

  const X = (x: number) => m.l + ((x - xMin) / Math.max(1e-6, xMax - xMin)) * iw;
  const Y = (y: number) => m.t + ih - ((y - yMin) / (yMax - yMin)) * ih;

  const yTicks = 5;
  const xTicks = 6;
  const grid: string[] = [];
  for (let i = 0; i <= yTicks; i++) {
    const y = yMin + ((yMax - yMin) * i) / yTicks;
    const yy = Y(y);
    grid.push(`<line x1="${m.l}" x2="${m.l + iw}" y1="${yy}" y2="${yy}" class="grid-line"/>`);
    grid.push(`<text x="${m.l - 10}" y="${yy + 4}" text-anchor="end" class="axis-text">${Math.round(y)}</text>`);
  }
  for (let i = 0; i <= xTicks; i++) {
    const x = xMin + ((xMax - xMin) * i) / xTicks;
    const xx = X(x);
    grid.push(`<line x1="${xx}" x2="${xx}" y1="${m.t}" y2="${m.t + ih}" class="grid-line x"/>`);
    grid.push(`<text x="${xx}" y="${m.t + ih + 24}" text-anchor="middle" class="axis-text">${formatClock(x)}</text>`);
  }

  const bands = (opts.bands ?? []).map((b) => {
    const x0 = X(Math.max(xMin, b.x0));
    const x1 = X(Math.min(xMax, b.x1));
    return `<rect x="${x0}" y="${m.t}" width="${Math.max(0, x1 - x0)}" height="${ih}" fill="${b.color ?? 'rgba(30,64,175,.16)'}"/>
      ${b.label ? `<text x="${(x0 + x1) / 2}" y="${m.t + 16}" text-anchor="middle" class="band-text">${b.label}</text>` : ''}`;
  }).join('');

  const paths = opts.series.map((s) => {
    const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${X(p.x).toFixed(2)},${Y(p.y).toFixed(2)}`).join(' ');
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.4" ${s.dashed ? 'stroke-dasharray="7 5"' : ''} stroke-linejoin="round" stroke-linecap="round"><title>${s.name}</title></path>`;
  }).join('');

  const markers = (opts.markers ?? []).map((mk) => {
    const cx = X(mk.x), cy = Y(mk.y);
    return `<g><circle cx="${cx}" cy="${cy}" r="5.5" fill="${mk.color ?? '#ef4444'}" stroke="#fff" stroke-width="2"/>
      <text x="${cx + 9}" y="${cy - 10}" class="marker-text">${mk.label}</text></g>`;
  }).join('');

  const legend = opts.series.map((s) => `<span class="legend-item"><i style="background:${s.color};${s.dashed ? 'height:0;border-top:3px dashed ' + s.color : ''}"></i>${s.name}</span>`).join('');

  return `
  <div class="chart-legend">${legend}</div>
  <svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="功率曲线">
    ${bands}
    ${grid.join('')}
    ${opts.zeroLine === false ? '' : `<line x1="${m.l}" x2="${m.l + iw}" y1="${Y(0)}" y2="${Y(0)}" class="zero-line"/>`}
    ${paths}
    ${markers}
    <text transform="translate(18 ${m.t + ih / 2}) rotate(-90)" text-anchor="middle" class="axis-title">${opts.yLabel ?? '功率 W'}</text>
  </svg>`;
}
