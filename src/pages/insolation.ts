import type { PageHandle } from './types';
import type { SimResult } from '../types';
import { store } from '../state';
import { el, toast, busyButton } from '../components/ui';
import { SatelliteSceneRenderer } from '../gpu/sceneRenderer';
import { CanvasFallbackRenderer } from '../gpu/canvasFallback';
import { simulateScenario } from '../lib/sim';
import { formatClock, formatNumber } from '../lib/format';

export function renderInsolationPage(): PageHandle {
  const scenario = store.current();
  const root = el<HTMLElement>('<section class="page simulation-page"></section>');
  root.innerHTML = `
    <header class="page-header">
      <div><h1>受照推演</h1><p>WGSL compute 按“时间步 × 电池片”分派，逐采样点发射太阳阴影射线；地球反照按经验系数加入，星体/帆板多阶反射用辐射度闭合近似。</p></div>
      <div class="actions">
        <label class="inline-field">步长 s
          <select data-role="step">
            <option value="10">10（验收）</option><option value="30">30</option><option value="60">60</option>
          </select>
        </label>
        <button class="btn primary" data-action="run">▶ 整轨 GPU 推演</button>
      </div>
    </header>

    <div class="sim-layout">
      <section class="card viewer-card">
        <div class="viewer-wrap">
          <canvas data-role="canvas"></canvas>
          <div class="viewer-badge" data-role="backend">正在初始化 WebGPU…</div>
          <div class="legend">
            <span>阴影</span><div class="legend-gradient"></div><span>全照</span>
          </div>
        </div>
        <div class="timeline">
          <button class="btn small" data-action="play">▶</button>
          <input data-role="timeline" type="range" min="0" max="100" value="0" />
          <span data-role="time" class="timecode">00:00:00</span>
        </div>
      </section>

      <aside class="side-stack">
        <section class="card stats-card"><h2>当前时刻</h2><div data-role="stats" class="stats-grid"></div></section>
        <section class="card model-card">
          <h2>模型与精度</h2>
          <div class="model-toggles">
            <label class="check-field"><input type="checkbox" data-model="enableSelfShadow" ${scenario.simulation.enableSelfShadow ? 'checked' : ''}/> 星体/帆板自身遮挡</label>
            <label class="check-field"><input type="checkbox" data-model="enableEarthAlbedo" ${scenario.simulation.enableEarthAlbedo ? 'checked' : ''}/> 地球经验反照</label>
            <label class="check-field"><input type="checkbox" data-model="enableMultiBounce" ${scenario.simulation.enableMultiBounce ? 'checked' : ''}/> 多阶反射辐射度闭合</label>
          </div>
          <div class="form-grid compact model-grid">
            <label class="field"><span>反照系数</span><input type="number" min="0" max="1" step="0.01" data-model="earthAlbedo" value="${scenario.simulation.earthAlbedo}"/></label>
            <label class="field"><span>反射闭合系数</span><input type="number" min="0" max="1" step="0.01" data-model="bounceCoefficient" value="${scenario.simulation.bounceCoefficient}"/></label>
            <label class="field"><span>每片采样边数</span><select data-model="samplesPerCellAxis"><option value="1" ${scenario.simulation.samplesPerCellAxis === 1 ? 'selected' : ''}>1 × 1（中心）</option><option value="2" ${scenario.simulation.samplesPerCellAxis === 2 ? 'selected' : ''}>2 × 2（验收默认）</option><option value="3" ${scenario.simulation.samplesPerCellAxis === 3 ? 'selected' : ''}>3 × 3（精细）</option></select></label>
          </div>
          <small class="hint">参数自动存入 IndexedDB，下一次整轨推演生效；余弦自检会使用无遮挡且关闭反照/反射的独立夹具。</small>
        </section>
        <section class="card"><h2>电池串 / 旁路二极管</h2><div data-role="strings" class="string-status"></div></section>
      </aside>
    </div>`;

  const canvas = root.querySelector<HTMLCanvasElement>('[data-role="canvas"]')!;
  const backendBadge = root.querySelector<HTMLElement>('[data-role="backend"]')!;
  const timeline = root.querySelector<HTMLInputElement>('[data-role="timeline"]')!;
  const timeLabel = root.querySelector<HTMLElement>('[data-role="time"]')!;
  const stats = root.querySelector<HTMLElement>('[data-role="stats"]')!;
  const stringsBox = root.querySelector<HTMLElement>('[data-role="strings"]')!;
  const runButton = root.querySelector<HTMLButtonElement>('[data-action="run"]')!;
  const playButton = root.querySelector<HTMLButtonElement>('[data-action="play"]')!;
  const stepSelect = root.querySelector<HTMLSelectElement>('[data-role="step"]')!;
  stepSelect.value = String(scenario.simulation.stepSec);

  let renderer: SatelliteSceneRenderer | null = null;
  let fallback: CanvasFallbackRenderer | null = null;
  let result: SimResult | undefined = store.getResult(scenario.id);
  let frameIndex = 0;
  let timer: number | undefined;
  let disposed = false;
  let running = false;

  const rendererReady = new Promise<void>((resolve) => {
    const r = new SatelliteSceneRenderer(canvas);
    renderer = r;
    r.init(scenario).then((ok) => {
      if (disposed) return resolve();
      if (ok) {
        backendBadge.textContent = 'WebGPU 三维 / WGSL';
      } else {
        backendBadge.textContent = 'WebGPU 不可用：Canvas2D 兼容预览 + CPU 参考推演';
        backendBadge.classList.add('warn');
        fallback = new CanvasFallbackRenderer(canvas, scenario);
        if (result) fallback.updateCellColors(result.irradiance[frameIndex]);
      }
      if (result) updateFrame(frameIndex);
      resolve();
    }).catch(() => resolve());
  });

  stepSelect.addEventListener('change', async () => {
    scenario.simulation.stepSec = Number(stepSelect.value);
    await store.updateCase(scenario, { silent: true });
  });

  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-model]').forEach((input) => {
    const apply = () => {
      const key = input.dataset.model as keyof typeof scenario.simulation;
      const bag = scenario.simulation as unknown as Record<string, number | boolean>;
      bag[key] = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : Number(input.value);
      void store.updateCase(scenario, { silent: true });
    };
    input.addEventListener('input', apply);
    input.addEventListener('change', apply);
  });

  runButton.addEventListener('click', () => void run());
  playButton.addEventListener('click', () => {
    if (timer) stopPlay();
    else startPlay();
  });
  timeline.addEventListener('input', () => {
    stopPlay();
    frameIndex = Number(timeline.value);
    updateFrame(frameIndex);
  });

  async function run() {
    if (running) return;
    running = true;
    busyButton(runButton, true, 'GPU 推演中…');
    try {
      await rendererReady;
      const current = store.current();
      current.simulation.stepSec = Number(stepSelect.value);
      result = await simulateScenario(current, store.settings);
      store.setResult(result);
      timeline.max = String(result.power.length - 1);
      frameIndex = Math.min(frameIndex, result.power.length - 1);
      timeline.value = String(frameIndex);
      updateFrame(frameIndex);
      toast(`推演完成：${result.steps} 步 × ${result.cells} 片，耗时 ${result.elapsedMs.toFixed(0)} ms（${result.backend}）`, result.elapsedMs < 3000 ? 'success' : 'error');
    } catch (err) {
      console.error(err);
      toast(`推演失败：${(err as Error).message}`, 'error');
    } finally {
      running = false;
      busyButton(runButton, false);
    }
  }

  function startPlay() {
    if (!result) {
      toast('请先运行整轨推演', 'info');
      return;
    }
    playButton.textContent = '⏸';
    timer = window.setInterval(() => {
      if (!result) return;
      frameIndex = (frameIndex + 1) % result.power.length;
      timeline.value = String(frameIndex);
      updateFrame(frameIndex);
    }, 160);
  }
  function stopPlay() {
    if (timer) window.clearInterval(timer);
    timer = undefined;
    playButton.textContent = '▶';
  }

  function updateFrame(i: number) {
    if (!result) {
      stats.innerHTML = '<div class="empty">点击“整轨 GPU 推演”生成逐片受照结果。</div>';
      return;
    }
    frameIndex = i;
    const env = result.environments[i];
    const power = result.power[i];
    const samples = result.irradiance[i];
    renderer?.setSunDirection(env.sunDirectionBody);
    renderer?.updateCellColors(samples);
    fallback?.setSunDirection(env.sunDirectionBody);
    fallback?.updateCellColors(samples);
    timeLabel.textContent = formatClock(env.tSec);
    const avgLit = samples.reduce((s, x) => s + x.litFraction, 0) / samples.length;
    const fullyShaded = samples.filter((x) => x.litFraction < 0.05).length;
    const avgG = samples.reduce((s, x) => s + x.totalWm2, 0) / samples.length;
    stats.innerHTML = `
      ${stat('轨道时刻', formatClock(env.tSec))}
      ${stat('地影因子', env.eclipseFactor.toFixed(2), env.inEarthShadow ? 'bad' : 'good')}
      ${stat('平均受照比例', `${(avgLit * 100).toFixed(1)}%`)}
      ${stat('近全阴电池片', `${fullyShaded} / ${result.cells}`, fullyShaded ? 'warn' : '')}
      ${stat('平均辐照度', `${formatNumber(avgG, 0)} W/m²`)}
      ${stat('发电功率', `${formatNumber(power.solarW, 1)} W`, 'good')}
      ${stat('载荷+平台', `${formatNumber(power.busLoadW + power.payloadLoadW, 0)} W`)}
      ${stat('净功率', `${formatNumber(power.netW, 1)} W`, power.netW >= 0 ? 'good' : 'bad')}
      ${stat('计算后端 / 耗时', `${result.backend} · ${result.elapsedMs.toFixed(0)} ms`)}`;

    stringsBox.innerHTML = power.strings.map((s) => {
      const pct = Math.min(100, (s.currentA / scenario.electrical.referenceCurrentA) * 100);
      return `<div class="string-card ${s.bypassedGroups ? 'bypassed' : ''}">
        <div class="string-head"><b>${s.name}</b><span>${formatNumber(s.powerW, 1)} W</span></div>
        <div class="meter"><i style="width:${pct}%"></i></div>
        <div class="string-meta">${s.currentA.toFixed(2)} A · ${s.voltageV.toFixed(1)} V · 旁路 ${s.bypassedGroups}/${s.totalGroups} 组</div>
        ${s.limitingCell ? `<small class="${s.bypassedGroups ? 'fault' : ''}">${s.bypassedGroups ? '旁路限制片' : '最低电流片'}：${s.limitingCell}</small>` : ''}
      </div>`;
    }).join('');
  }

  if (result) {
    timeline.max = String(result.power.length - 1);
    updateFrame(0);
  } else {
    updateFrame(0);
    void run();
  }

  return {
    el: root,
    destroy: () => {
      disposed = true;
      stopPlay();
      renderer?.destroy();
      fallback?.destroy();
    }
  };
}

function stat(label: string, value: string, tone = ''): string {
  return `<div class="stat ${tone}"><span>${label}</span><b>${value}</b></div>`;
}
