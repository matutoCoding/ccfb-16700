import type { PageHandle } from './types';
import type { ScenarioCase, SimResult } from '../types';
import { store } from '../state';
import { el, toast, busyButton } from '../components/ui';
import { simulateScenario } from '../lib/sim';
import { renderLineChart } from '../components/chart';
import { downloadText } from '../lib/export';
import { formatClock, formatNumber } from '../lib/format';

interface CompareRun { source: ScenarioCase; scenario: ScenarioCase; result: SimResult }

const COLORS = ['#2563eb', '#dc2626', '#059669', '#7c3aed', '#d97706', '#0891b2'];

export function renderComparePage(): PageHandle {
  const root = el<HTMLElement>('<section class="page"></section>');
  const first = store.cases.find((c) => store.compareIds.includes(c.id)) ?? store.cases[0];
  const commonDate = first.orbit.epochISO.slice(0, 10);
  root.innerHTML = `
    <header class="page-header">
      <div><h1>工况对比</h1><p>保存多套构型+姿态方案到 IndexedDB；可强制同一天、同一组轨道六根数，将整轨功率曲线叠加并逐时列出差值。</p></div>
      <div class="actions"><button class="btn primary" data-action="run-compare">运行所选工况对比</button></div>
    </header>
    <section class="card compare-controls">
      <div class="case-picker">
        ${store.cases.map((c, i) => `
          <label class="check-pill"><input type="checkbox" data-case="${c.id}" ${store.compareIds.includes(c.id) ? 'checked' : ''}/>
          <span><i class="dot" style="background:${COLORS[i % COLORS.length]}"></i>${c.name}</span></label>`).join('')}
      </div>
      <div class="compare-options">
        <label class="inline-field"><input type="checkbox" data-role="unify" checked/> 统一轨道六根数（以首个选中工况为基准）</label>
        <label class="inline-field">同一天 <input type="date" data-role="date" value="${commonDate}"/></label>
        <label class="inline-field">采样差值间隔
          <select data-role="stride"><option value="60">60 s</option><option value="300" selected>5 min</option><option value="600">10 min</option><option value="0">仅极值点</option></select>
        </label>
        <button class="btn" data-action="export-compare">导出对比差值 CSV</button>
      </div>
    </section>
    <div data-role="output"><div class="card empty">选择至少两套工况后运行对比。</div></div>`;

  const output = root.querySelector<HTMLElement>('[data-role="output"]')!;
  const runBtn = root.querySelector<HTMLButtonElement>('[data-action="run-compare"]')!;
  let runs: CompareRun[] = [];
  let running = false;

  root.querySelectorAll<HTMLInputElement>('[data-case]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.case!;
      if (cb.checked) {
        if (!store.compareIds.includes(id)) store.compareIds.push(id);
      } else {
        store.compareIds = store.compareIds.filter((x) => x !== id);
      }
    });
  });

  runBtn.addEventListener('click', () => void runCompare());
  root.querySelector('[data-action="export-compare"]')?.addEventListener('click', () => exportCsv());

  async function runCompare() {
    if (running) return;
    const selected = store.cases.filter((c) => store.compareIds.includes(c.id));
    if (selected.length < 2) {
      toast('请至少选择两套工况', 'error');
      return;
    }
    running = true;
    busyButton(runBtn, true, '批量推演中…');
    output.innerHTML = '<div class="card loading-card"><span class="spinner big"></span><div data-role="progress">准备批量推演…</div></div>';
    const progress = output.querySelector<HTMLElement>('[data-role="progress"]');
    const unify = root.querySelector<HTMLInputElement>('[data-role="unify"]')!.checked;
    const date = root.querySelector<HTMLInputElement>('[data-role="date"]')!.value;
    runs = [];
    try {
      const baseline = selected[0];
      for (let i = 0; i < selected.length; i++) {
        const source = selected[i];
        progress!.textContent = `正在推演 ${i + 1}/${selected.length}：${source.name}`;
        const scenario = structuredClone(source);
        scenario.simulation.stepSec = 10;
        if (unify) {
          scenario.orbit = structuredClone(baseline.orbit);
          if (date) scenario.orbit.epochISO = new Date(`${date}T00:00:00.000Z`).toISOString();
        } else if (date) {
          scenario.orbit.epochISO = new Date(`${date}T00:00:00.000Z`).toISOString();
        }
        const result = await simulateScenario(scenario, store.settings);
        runs.push({ source, scenario, result });
      }
      paint();
      toast('工况对比完成', 'success');
    } catch (e) {
      output.innerHTML = `<div class="banner error">对比失败：${(e as Error).message}</div>`;
    } finally {
      running = false;
      busyButton(runBtn, false);
    }
  }

  function paint() {
    if (!runs.length) return;
    const base = runs[0];
    const xMax = Math.max(...runs.map((r) => r.result.orbitPeriodSec));
    const series = runs.map((r, i) => ({
      name: r.source.name,
      color: COLORS[i % COLORS.length],
      points: r.result.power.map((p) => ({ x: p.tSec, y: p.solarW }))
    }));
    const bands = base.result.eclipseIntervals.map((b) => ({ x0: b.startSec, x1: b.endSec, label: '地影' }));
    const stride = Number(root.querySelector<HTMLSelectElement>('[data-role="stride"]')!.value);
    const rows = comparisonRows(runs, stride);

    output.innerHTML = `
      <div class="metric-cards">
        ${runs.map((r, i) => `
          <div class="metric-card" style="border-top:3px solid ${COLORS[i % COLORS.length]}">
            <span>${r.source.name}</span>
            <b>${formatNumber(r.result.minPower.powerW)} W</b>
            <small>最小 @ ${formatClock(r.result.minPower.tSec)}；耗时 ${r.result.elapsedMs.toFixed(0)} ms</small>
          </div>`).join('')}
      </div>
      <section class="card chart-card">
        <h2>同一天 / 同一轨功率叠加</h2>
        ${renderLineChart({ series, bands, xMax, yLabel: '发电功率 W' })}
      </section>
      <section class="card">
        <h2>功率差值表（相对基准：${base.source.name}）</h2>
        <div class="table-scroll compare-table">
          <table class="data-table sticky">
            <thead><tr><th>时刻</th>${runs.map((r) => `<th>${r.source.name}<br><small>W / ΔW</small></th>`).join('')}</tr></thead>
            <tbody>
              ${rows.map((row) => `
                <tr>
                  <td class="sticky-col">${formatClock(row.t)}</td>
                  ${row.values.map((v, i) => `<td class="${i === 0 ? 'base-col' : v.delta >= 0 ? 'pos' : 'neg'}">${v.w.toFixed(1)}${i === 0 ? '' : `<br><small>${v.delta >= 0 ? '+' : ''}${v.delta.toFixed(1)} W</small>`}</td>`).join('')}
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>`;
  }

  function exportCsv() {
    if (!runs.length) {
      toast('请先运行对比', 'error');
      return;
    }
    const rows = comparisonRows(runs, 60);
    const head = ['time_sec', 'time_clock', ...runs.flatMap((r) => [`${r.source.id}_W`, `${r.source.id}_delta_W`])];
    const lines = [head.join(',')];
    for (const row of rows) {
      lines.push([
        row.t, formatClock(row.t),
        ...row.values.flatMap((v, i) => [v.w.toFixed(3), i === 0 ? '0' : v.delta.toFixed(3)])
      ].join(','));
    }
    downloadText('case-comparison-delta.csv', lines.join('\n'));
    toast('对比差值 CSV 已导出', 'success');
  }

  return { el: root };
}

function nearestPower(result: SimResult, t: number): number {
  let best = result.power[0];
  let bd = Infinity;
  for (const p of result.power) {
    const d = Math.abs(p.tSec - t);
    if (d < bd) { bd = d; best = p; }
  }
  return best.solarW;
}

function comparisonRows(runs: CompareRun[], strideSec: number): Array<{ t: number; values: Array<{ w: number; delta: number }> }> {
  const base = runs[0].result;
  const times: number[] = [];
  if (strideSec > 0) {
    for (let t = 0; t <= base.orbitPeriodSec + 0.1; t += strideSec) times.push(t);
  }
  // Always include each run minimum and orbit end.
  for (const r of runs) times.push(r.result.minPower.tSec, r.result.orbitPeriodSec);
  const unique = Array.from(new Set(times.map((t) => Math.round(t / 10) * 10))).sort((a, b) => a - b);
  return unique.map((t) => {
    const baseW = nearestPower(base, t);
    return {
      t,
      values: runs.map((r) => {
        const w = nearestPower(r.result, t);
        return { w, delta: w - baseW };
      })
    };
  });
}
