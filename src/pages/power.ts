import type { PageHandle } from './types';
import type { SimResult } from '../types';
import { store } from '../state';
import { el, toast, busyButton } from '../components/ui';
import { simulateScenario } from '../lib/sim';
import { renderLineChart } from '../components/chart';
import { powerCurveCsv, cellInsolationCsv, scenarioMarkdown, downloadText } from '../lib/export';
import { formatClock, formatNumber } from '../lib/format';

export function renderPowerPage(): PageHandle {
  const scenario = store.current();
  const root = el<HTMLElement>('<section class="page"></section>');
  root.innerHTML = `
    <header class="page-header">
      <div><h1>发电曲线</h1><p>整轨 10 秒步长结果；地影段以蓝色带标出，红点为全轨最小发电功率。电串模型包含串联限流和旁路二极管状态。</p></div>
      <div class="actions">
        <button class="btn" data-action="export-power">导出功率 CSV</button>
        <button class="btn" data-action="export-cells">导出每片受照时间表</button>
        <button class="btn" data-action="export-doc">导出工况说明 MD</button>
        <button class="btn primary" data-action="run">重新推演</button>
      </div>
    </header>
    <div data-role="content"></div>`;

  const content = root.querySelector<HTMLElement>('[data-role="content"]')!;
  const runButton = root.querySelector<HTMLButtonElement>('[data-action="run"]')!;
  let result = store.getResult(scenario.id);
  let running = false;

  root.querySelector('[data-action="export-power"]')?.addEventListener('click', () => {
    if (!ensure()) return;
    downloadText(`${scenario.id}-power-curve.csv`, powerCurveCsv(scenario, result!));
    toast('功率曲线 CSV 已导出', 'success');
  });
  root.querySelector('[data-action="export-cells"]')?.addEventListener('click', () => {
    if (!ensure()) return;
    downloadText(`${scenario.id}-cell-insolation-schedule.csv`, cellInsolationCsv(scenario, result!));
    toast('每片电池片受照时间表已导出', 'success');
  });
  root.querySelector('[data-action="export-doc"]')?.addEventListener('click', () => {
    downloadText(`${scenario.id}-scenario-description.md`, scenarioMarkdown(scenario, result), 'text/markdown;charset=utf-8');
    toast('工况说明已导出', 'success');
  });
  runButton.addEventListener('click', () => void run(true));

  function ensure(): boolean {
    if (result) return true;
    toast('请先运行整轨推演', 'error');
    return false;
  }

  async function run(force = false) {
    if (running) return;
    if (!force && store.getResult(scenario.id)) {
      result = store.getResult(scenario.id);
      paint();
      return;
    }
    running = true;
    busyButton(runButton, true, '推演中…');
    content.innerHTML = '<div class="card loading-card"><span class="spinner big"></span> 正在调用 WebGPU 计算逐片阴影与发电…</div>';
    try {
      result = await simulateScenario(scenario, store.settings, { attachValidation: true });
      store.setResult(result);
      paint();
    } catch (e) {
      content.innerHTML = `<div class="banner error">推演失败：${(e as Error).message}</div>`;
    } finally {
      running = false;
      busyButton(runButton, false);
    }
  }

  function paint() {
    if (!result) return;
    const r = result;
    const solarPoints = r.power.map((p) => ({ x: p.tSec, y: p.solarW }));
    const loadPoints = r.power.map((p) => ({ x: p.tSec, y: p.busLoadW + p.payloadLoadW }));
    const netPoints = r.power.map((p) => ({ x: p.tSec, y: p.netW }));
    const minLoadMargin = r.minPower.powerW - (scenario.geometry.busPowerW + scenario.geometry.payloadPowerW);
    const eclipseDuration = r.eclipseIntervals.reduce((s, i) => s + (i.endSec - i.startSec), 0);
    content.innerHTML = `
      <div class="metric-cards">
        ${metric('最小发电功率', `${formatNumber(r.minPower.powerW)} W`, `@ ${formatClock(r.minPower.tSec)}`, minLoadMargin >= 0 ? 'good' : 'bad')}
        ${metric('最大发电功率', `${formatNumber(r.maxPower.powerW)} W`, `@ ${formatClock(r.maxPower.tSec)}`, 'good')}
        ${metric('负载总功率', `${formatNumber(scenario.geometry.busPowerW + scenario.geometry.payloadPowerW, 0)} W`, `平台 ${scenario.geometry.busPowerW} + 载荷 ${scenario.geometry.payloadPowerW}`)}
        ${metric('最差功率裕量', `${formatNumber(minLoadMargin)} W`, minLoadMargin >= 0 ? '载荷可开机' : '需放电/限载荷', minLoadMargin >= 0 ? 'good' : 'bad')}
        ${metric('最长地影 / 总地影', `${formatClock(longest(r))}`, `整轨地影 ${Math.round(eclipseDuration)} s`)}
        ${metric('推演性能', `${r.elapsedMs.toFixed(0)} ms`, `${r.backend} · ${r.steps} 步 × ${r.cells} 片`, r.elapsedMs < 3000 ? 'good' : 'bad')}
      </div>
      <section class="card chart-card">
        <div class="card-title"><h2>一整轨发电曲线</h2><span class="hint">周期 ${formatClock(r.orbitPeriodSec)}；步长 ${scenario.simulation.stepSec} s</span></div>
        ${renderLineChart({
          series: [
            { name: '太阳翼发电', color: '#2563eb', points: solarPoints },
            { name: '总负载', color: '#dc2626', points: loadPoints, dashed: true },
            { name: '净功率', color: '#059669', points: netPoints }
          ],
          bands: r.eclipseIntervals.map((i) => ({ x0: i.startSec, x1: i.endSec, label: '地影' })),
          markers: [{ x: r.minPower.tSec, y: r.minPower.powerW, label: `最小 ${r.minPower.powerW.toFixed(0)} W @ ${formatClock(r.minPower.tSec)}` }],
          xMax: r.orbitPeriodSec,
          yLabel: '功率 W'
        })}
      </section>
      <div class="grid two">
        <section class="card">
          <h2>地影进出时刻</h2>
          <table class="data-table">
            <thead><tr><th>进入</th><th>退出</th><th>持续 s</th></tr></thead>
            <tbody>${r.eclipseIntervals.map((i) => `<tr><td>${formatClock(i.startSec)}</td><td>${formatClock(i.endSec)}</td><td>${Math.round(i.endSec - i.startSec)}</td></tr>`).join('') || '<tr><td colspan="3">本轨无地影</td></tr>'}</tbody>
          </table>
        </section>
        <section class="card">
          <h2>旁路动作最多时刻</h2>
          ${bypassTable(r)}
        </section>
      </div>`;
  }

  if (result) paint();
  else void run();
  return { el: root };
}

function metric(label: string, value: string, sub: string, tone = ''): string {
  return `<div class="metric-card ${tone}"><span>${label}</span><b>${value}</b><small>${sub}</small></div>`;
}

function longest(r: SimResult): number {
  return r.eclipseIntervals.reduce((m, i) => Math.max(m, i.endSec - i.startSec), 0);
}

function bypassTable(r: SimResult): string {
  const worst = [...r.power].sort((a, b) => bypassCount(b) - bypassCount(a))[0];
  if (!worst) return '<div class="empty">无数据</div>';
  return `
    <div class="metric-line"><b>${formatClock(worst.tSec)}</b> 旁路组数最多：${bypassCount(worst)}</div>
    <table class="data-table">
      <thead><tr><th>电池串</th><th>功率 W</th><th>电流 A</th><th>电压 V</th><th>旁路组</th><th>限制片</th></tr></thead>
      <tbody>${worst.strings.map((s) => `<tr class="${s.bypassedGroups ? 'warn-row' : ''}"><td>${s.name}</td><td>${s.powerW.toFixed(1)}</td><td>${s.currentA.toFixed(2)}</td><td>${s.voltageV.toFixed(1)}</td><td>${s.bypassedGroups}/${s.totalGroups}</td><td>${s.limitingCell ?? '—'}</td></tr>`).join('')}</tbody>
    </table>`;
}
function bypassCount(p: SimResult['power'][number]): number {
  return p.strings.reduce((n, s) => n + s.bypassedGroups, 0);
}
