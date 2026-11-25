import type { SimulationResult } from '../../types';
import { store } from '../store';
import { button, card, field, formatSeconds, h, selectInput, stat } from '../dom';
import { runSimulation } from '../../lib/simulation';
import { mountRenderer, type SatelliteRenderer } from '../../webgpu/renderer';
import { cellIlluminationScheduleWithMetaCSV, downloadText, powerCurveCSVWithLoad } from '../../lib/export';

type ColorMode = 'ratio' | 'shadow' | 'direct';

let renderer: SatelliteRenderer | null = null;
let playTimer: number | null = null;

function stopPlayback(): void {
  if (playTimer !== null) {
    window.clearInterval(playTimer);
    playTimer = null;
  }
}

export function renderSimulatePage(root: HTMLElement): () => void {
  let cancelled = false;
  let index = store.state.result ? Math.min(120, store.state.result.epochs.length - 1) : 0;
  let colorMode: ColorMode = 'ratio';
  let playing = false;
  let paintGeneration = 0;

  const paint = () => {
    if (cancelled) return;
    const generation = ++paintGeneration;
    stopPlayback();
    renderer?.dispose();
    renderer = null;
    root.replaceChildren();
    const plan = store.state.plan;
    const result = store.state.result;

    root.append(h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, '受照推演与三维阴影'), h('p', { class: 'page-desc' }, 'WebGPU 计算着色器按历元×电池片×分层采样点进行光线求交，计算星体、天线、遮光罩和太阳翼之间的自遮挡，并加入地球反照与多次反射。')),
      h('div', { class: 'head-actions' },
        field('步长 s', h('input', { type: 'number', class: 'input small', value: plan.settings.stepSec, min: 2, max: 120, onChange: (e: Event) => {
          store.updatePlan((p) => { p.settings.stepSec = Number((e.target as HTMLInputElement).value) || 10; });
        } }) as HTMLInputElement),
        button(store.state.running ? '推演中…' : '运行整轨推演', () => void execute(), { variant: 'primary', disabled: store.state.running }),
      ),
    ));

    const summary = h('div', { class: 'stat-grid' });
    if (result) {
      summary.append(
        stat('计算引擎', result.engine === 'webgpu' ? 'WebGPU' : result.engine === 'mixed' ? 'GPU→CPU 兜底' : 'CPU 兼容', `${result.epochCount} 历元 × ${result.cellCount} 片`, result.engine === 'webgpu' ? 'good' : 'warn'),
        stat('整轨耗时', `${result.elapsedMs.toFixed(0)} ms`, `10 s 步长目标 < 3000 ms`, result.elapsedMs < 3000 ? 'good' : 'bad'),
        stat('全轨最小功率', `${result.minTotal.powerW.toFixed(0)} W`, `${formatSeconds(result.minTotal.tSec)}`, 'bad'),
        stat('光照区最差', result.minSunlit ? `${result.minSunlit.powerW.toFixed(0)} W` : '—', result.minSunlit ? formatSeconds(result.minSunlit.tSec) : '', 'warn'),
      );
    } else {
      summary.append(stat('尚未推演', '—', '点击右上角运行', 'accent'));
    }
    root.append(summary);

    const grid = h('div', { class: 'sim-grid' });
    const viewerCard = card('实时三维受照',
      h('div', { class: 'viewer-wrap' },
        h('canvas', { id: 'sim-canvas', class: 'viewer' }),
        h('div', { id: 'viewer-overlay', class: 'viewer-overlay' }, result ? '' : '运行后显示逐片阴影'),
      ),
      h('div', { class: 'timeline' },
        h('button', { class: 'btn btn-icon-only', title: playing ? '暂停' : '播放', onClick: () => togglePlay() }, playing ? '⏸' : '▶'),
        h('input', { id: 'timeline', type: 'range', min: 0, max: result ? result.epochs.length - 1 : 0, value: index, class: 'range' }),
        h('span', { id: 'time-label', class: 'time-label' }, result ? formatSeconds(result.epochs[index]?.tSec ?? 0) : '00:00:00'),
        field('着色', selectInput<ColorMode>(colorMode, [
          ['ratio', '综合受照率'], ['shadow', '阴影采样率'], ['direct', '直接太阳'],
        ], (v) => { colorMode = v; updateFrame(); })),
      ),
      h('div', { class: 'legend-row' }, h('div', { class: 'legend' }, h('span', {}, '低'), h('div', { class: 'legend-bar' }), h('span', {}, '高'), h('em', {}, '蓝→青→黄→红表示受照强度'))),
    );

    const side = h('div', { class: 'stack' });
    const readout = card('当前历元', h('div', { id: 'epoch-readout', class: 'readout' }, '等待推演…'));
    const strings = card('电池串 / 旁路二极管', h('div', { id: 'string-table-wrap', class: 'table-wrap compact' }, '等待推演…'));
    const exports = card('导出',
      h('div', { class: 'button-row wrap' },
        button('功率曲线 CSV', () => { if (result) downloadText('power_curve.csv', powerCurveCSVWithLoad(result, plan.settings.nominalLoadW)); }, { variant: 'success' }),
        button('电池片受照时间表 CSV', () => { if (result) downloadText('cell_illumination_schedule.csv', cellIlluminationScheduleWithMetaCSV(plan, result)); }, { variant: 'success' }),
      ),
      h('p', { class: 'hint' }, '受照时间表为“历元 × 电池片”长表，包含 lit_fraction、入射角余弦、直接/反照/反照弹射辐照。'),
    );
    side.append(readout, strings, exports);
    grid.append(viewerCard, side);
    root.append(grid);

    const canvas = root.querySelector('#sim-canvas') as HTMLCanvasElement | null;
    if (canvas) {
      void mountRenderer(canvas, plan.model).then((r) => {
        if (cancelled || generation !== paintGeneration) { r?.dispose(); return; }
        renderer = r;
        if (!r) {
          const ov = root.querySelector('#viewer-overlay');
          if (ov) ov.innerHTML = '<div class="webgpu-fallback">WebGPU 不可用：页面仍可用 CPU 引擎完成推演和曲线，但三维加速渲染需要最新版 Chrome/Edge。</div>';
        }
        updateFrame();
      });
    }

    const timeline = root.querySelector('#timeline') as HTMLInputElement | null;
    timeline?.addEventListener('input', () => {
      index = Number(timeline.value);
      updateFrame();
    });
  };

  async function execute(): Promise<void> {
    stopPlayback();
    playing = false;
    store.setRunning(true, '正在提交 GPU/CPU 推演…');
    let result: SimulationResult | null = null;
    try {
      // Let the button paint disabled state before heavy synchronous prep.
      await new Promise((r) => setTimeout(r, 30));
      result = await runSimulation(store.state.plan);
      store.setResult(result);
    } catch (err) {
      console.error(err);
      store.toast(`推演失败：${(err as Error).message}`, 'error', 6000);
    } finally {
      store.setRunning(false);
    }
    if (result && !cancelled) {
      index = Math.min(index, result.epochs.length - 1);
      store.toast(`整轨推演完成：${result.elapsedMs.toFixed(0)} ms`, result.elapsedMs < 3000 ? 'success' : 'error');
      paint();
    }
  }

  function togglePlay(): void {
    const result = store.state.result;
    if (!result) return;
    playing = !playing;
    if (playing) {
      playTimer = window.setInterval(() => {
        index = (index + 1) % result.epochs.length;
        const slider = root.querySelector('#timeline') as HTMLInputElement | null;
        if (slider) slider.value = String(index);
        updateFrame();
      }, 180);
    } else stopPlayback();
    paintPlayButton();
  }

  function paintPlayButton(): void {
    const btn = root.querySelector('.timeline button');
    if (btn) btn.textContent = playing ? '⏸' : '▶';
  }

  function cellValues(result: SimulationResult, idx: number): number[] {
    const ep = result.epochs[idx];
    const s = store.state.plan.settings.solarConstantWm2;
    return ep.cellIllumination.map((ill) => {
      if (colorMode === 'shadow') return ill.litFraction;
      if (colorMode === 'direct') return Math.min(1, ill.directWm2 / s);
      return Math.min(1, ill.totalWm2 / s);
    });
  }

  function updateFrame(): void {
    const result = store.state.result;
    if (!result) return;
    const idx = Math.max(0, Math.min(index, result.epochs.length - 1));
    index = idx;
    const ep = result.epochs[idx];
    const state = result.orbitStates[idx];
    const values = cellValues(result, idx);
    renderer?.setFrame(state.bodyToECI, state.sunECI, values);

    const timeLabel = root.querySelector('#time-label');
    if (timeLabel) timeLabel.textContent = `${formatSeconds(ep.tSec)} · ${new Date(ep.dateISO).toISOString().slice(11, 19)}`;

    const litCount = ep.cellIllumination.filter((c) => c.litFraction > 0.999).length;
    const partialCount = ep.cellIllumination.filter((c) => c.litFraction > 0.001 && c.litFraction < 0.999).length;
    const darkCount = ep.cellIllumination.length - litCount - partialCount;
    const margin = ep.totalPowerW - store.state.plan.settings.nominalLoadW;
    const readout = root.querySelector('#epoch-readout');
    if (readout) {
      readout.innerHTML = `
        <div class="readout-grid">
          <div><span>总功率</span><strong class="${margin >= 0 ? 'good-text' : 'bad-text'}">${ep.totalPowerW.toFixed(1)} W</strong></div>
          <div><span>功率裕度</span><strong class="${margin >= 0 ? 'good-text' : 'bad-text'}">${margin >= 0 ? '+' : ''}${margin.toFixed(1)} W</strong></div>
          <div><span>直接/反照/反射</span><strong>${ep.directPowerW.toFixed(0)} / ${ep.albedoPowerW.toFixed(0)} / ${ep.bouncePowerW.toFixed(0)} W</strong></div>
          <div><span>日照系数</span><strong>${ep.eclipseFactor.toFixed(2)}（1=全日照）${ep.inEclipse ? ' · 地影' : ''}</strong></div>
          <div><span>全亮/半影/暗片</span><strong>${litCount} / ${partialCount} / ${darkCount}</strong></div>
          <div><span>太阳-本体Z夹角</span><strong>${ep.sunAngleDeg.toFixed(1)}°</strong></div>
        </div>`;
    }

    const wrap = root.querySelector('#string-table-wrap');
    if (wrap) {
      const rows = ep.stringResults.slice(0, 40).map((s) => `<tr>
        <td>${s.stringId.replace(store.state.plan.model.id + '_', '')}</td>
        <td>${s.currentA.toFixed(2)}</td><td>${s.voltageV.toFixed(1)}</td><td>${s.powerW.toFixed(1)}</td>
        <td>${s.bypassedGroups}/${s.totalGroups}</td>
      </tr>`).join('');
      wrap.innerHTML = `<table class="data-table compact"><thead><tr><th>串</th><th>A</th><th>V</th><th>W</th><th>旁路组</th></tr></thead><tbody>${rows}</tbody></table>
        ${ep.stringResults.length > 40 ? `<p class="hint">仅显示前 40 串，完整数据见导出/曲线页。</p>` : ''}`;
    }
  }

  // Paint immediately; if a result already exists the canvas will color at index.
  paint();
  return () => { cancelled = true; stopPlayback(); renderer?.dispose(); renderer = null; };
}
