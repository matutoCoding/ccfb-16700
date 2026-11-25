import type { PageHandle } from './types';
import type { ScenarioCase } from '../types';
import { store } from '../state';
import { el, toast, busyButton } from '../components/ui';
import { getGpuDevice, getAdapterInfo, webgpuAvailable } from '../gpu/device';
import { runCosineAcceptance } from '../lib/acceptance';
import { simulateScenario } from '../lib/sim';
import { putCase, deleteCase } from '../lib/db';
import { createLargeSatelliteCase, createSmallSatelliteCase } from '../data/presets';
import { downloadText } from '../lib/export';

export function renderSettingsPage(): PageHandle {
  const root = el<HTMLElement>('<section class="page"></section>');
  root.innerHTML = `
    <header class="page-header"><div><h1>设置与验收</h1><p>IndexedDB 方案管理、WebGPU 后端信息、余弦定律精度验收和整轨 10 秒步长性能验收。</p></div></header>
    <div class="grid two">
      <section class="card">
        <h2>计算后端</h2>
        <div data-role="gpu-info" class="info-box">正在请求 WebGPU 适配器…</div>
        <div class="form-grid">
          <label class="field"><span>后端策略</span>
            <select data-role="backend">
              <option value="auto">自动：WebGPU，失败时按下方开关回退</option>
              <option value="webgpu">优先 WebGPU</option>
            </select>
          </label>
          <label class="check-field big"><input type="checkbox" data-role="fallback" ${store.settings.unsafeCpuFallback ? 'checked' : ''}/> WebGPU 不可用或编译失败时允许 CPU 参考后端</label>
        </div>
      </section>

      <section class="card">
        <h2>验收面板</h2>
        <div class="actions wrap">
          <button class="btn primary" data-action="cosine">运行余弦精度自检</button>
          <button class="btn primary" data-action="benchmark">整轨 10 s 性能验收</button>
        </div>
        <div data-role="validation" class="validation-output"><div class="empty">尚未运行。精度阈值 0.5%，性能阈值 3000 ms。</div></div>
      </section>
    </div>

    <section class="card">
      <div class="card-title"><h2>IndexedDB 方案库</h2>
        <div class="actions">
          <button class="btn" data-action="export-all">导出全部方案 JSON</button>
          <label class="btn">导入 JSON<input type="file" accept="application/json,.json" hidden data-role="import"/></label>
          <button class="btn danger" data-action="reset-builtin">恢复两套内置构型</button>
        </div>
      </div>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>名称</th><th>ID</th><th>质量</th><th>更新时间</th><th></th></tr></thead>
        <tbody>${store.cases.map(caseRow).join('')}</tbody>
      </table></div>
    </section>`;

  const gpuInfo = root.querySelector<HTMLElement>('[data-role="gpu-info"]')!;
  const validation = root.querySelector<HTMLElement>('[data-role="validation"]')!;
  const backend = root.querySelector<HTMLSelectElement>('[data-role="backend"]')!;
  const fallback = root.querySelector<HTMLInputElement>('[data-role="fallback"]')!;
  backend.value = store.settings.preferredBackend;

  void getGpuDevice().then((device) => {
    if (!webgpuAvailable()) {
      gpuInfo.innerHTML = '<b class="bad">当前浏览器未暴露 navigator.gpu。</b><br>请使用最新版 Chrome/Edge 并启用 WebGPU；可勾选 CPU 参考后端完成功能演示，但性能验收以 WebGPU 为准。';
    } else if (!device) {
      gpuInfo.innerHTML = '<b class="warn">WebGPU 适配器/设备创建失败。</b><br>请检查浏览器硬件加速或远程桌面/GPU 驱动。';
    } else {
      const info = getAdapterInfo();
      gpuInfo.innerHTML = `<b class="good">WebGPU 设备已就绪。</b><br>Vendor：${info?.vendor ?? 'unknown'}；Architecture：${info?.architecture ?? 'generic'}；Device：${info?.device ?? 'adapter'}；Description：${info?.description ?? ''}`;
    }
  });

  backend.addEventListener('change', () => void store.persistSettings({ ...store.settings, preferredBackend: backend.value as 'auto' | 'webgpu' }));
  fallback.addEventListener('change', () => void store.persistSettings({ ...store.settings, unsafeCpuFallback: fallback.checked }));

  root.querySelector('[data-action="cosine"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    busyButton(btn, true, '余弦验收中…');
    validation.innerHTML = '<div class="loading-inline"><span class="spinner"></span> 正在构造无遮挡平板并运行端到端余弦验收…</div>';
    try {
      const report = await runCosineAcceptance(store.current().electrical, store.settings, 192);
      validation.innerHTML = `
        <div class="banner ${report.passed ? 'success' : 'error'}"><b>最大相对误差 ${report.maxRelativeErrorPct.toFixed(8)}%</b> — ${report.passed ? '通过 &lt; 0.5%' : '未通过'}；后端 ${report.backend}</div>
        <table class="data-table compact">
          <thead><tr><th>太阳入射角 θ</th><th>端到端推演功率 W</th><th>N Iref Vmp cosθ W</th><th>误差 %</th></tr></thead>
          <tbody>${report.points.map((p) => `<tr><td>${p.angleDeg}°</td><td>${p.simulatedW.toFixed(6)}</td><td>${p.analyticW.toFixed(6)}</td><td class="${p.errorPct < 0.5 ? 'pos' : 'neg'}">${p.errorPct.toFixed(8)}</td></tr>`).join('')}</tbody>
        </table>
        <p class="hint">验收夹具没有遮挡基元，并关闭地球反照与多阶反射；WGSL direct 项为 S0·cosθ，均匀电流使旁路组不动作，因此 MPP 功率严格按余弦比例变化。</p>`;
    } catch (err) {
      validation.innerHTML = `<div class="banner error">余弦验收失败：${(err as Error).message}</div>`;
    } finally {
      busyButton(btn, false);
    }
  });

  root.querySelector('[data-action="benchmark"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    busyButton(btn, true, '性能验收中…');
    validation.innerHTML = '<div class="loading-inline"><span class="spinner"></span> 正在以 10 s 步长推演完整轨道…</div>';
    try {
      const base = store.cases.find((c) => c.id === 'case-500kg') ?? store.current();
      const scenario = structuredClone(base);
      scenario.simulation.stepSec = 10;
      scenario.simulation.samplesPerCellAxis = 2;
      const t0 = performance.now();
      const result = await simulateScenario(scenario, store.settings);
      const wall = performance.now() - t0;
      const pass = wall < 3000 && result.backend === 'webgpu';
      validation.innerHTML = `
        <div class="banner ${wall < 3000 ? 'success' : 'error'}">
          <b>${wall < 3000 ? '性能通过' : '性能未通过'}</b>：页面端到端 ${wall.toFixed(0)} ms；仿真内部计时 ${result.elapsedMs.toFixed(0)} ms，阈值 3000 ms。
        </div>
        <div class="metric-line">工况：${scenario.name}；后端：<b>${result.backend}</b>；${result.steps} 个时间步 × ${result.cells} 片电池片。</div>
        <div class="metric-line">最小功率 ${result.minPower.powerW.toFixed(1)} W @ ${result.minPower.tSec} s；若首次运行包含 WGSL 编译，可再点一次查看热管线性能。</div>
        ${result.backend !== 'webgpu' ? '<div class="banner warn">当前结果来自 CPU 参考后端，不能作为 WebGPU 性能验收结论。</div>' : ''}
        ${pass ? '' : result.backend === 'webgpu' ? '<p class="hint">若接近阈值，可降低每片采样点数或电池片密度；当前工作项为 时间步×电池片，阴影射线和多阶反射均在 GPU 上。</p>' : ''}`;
    } catch (err) {
      validation.innerHTML = `<div class="banner error">基准失败：${(err as Error).message}</div>`;
    } finally {
      busyButton(btn, false);
    }
  });

  root.querySelector('[data-action="export-all"]')?.addEventListener('click', () => {
    downloadText('satellite-solar-cases.json', JSON.stringify(store.cases, null, 2), 'application/json;charset=utf-8');
  });

  root.querySelector<HTMLInputElement>('[data-role="import"]')?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as ScenarioCase[] | ScenarioCase;
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of arr) {
        if (!c.id || !c.geometry || !c.orbit) throw new Error('JSON 中存在缺少 id/geometry/orbit 的方案');
        await putCase(c);
      }
      toast(`已导入 ${arr.length} 套方案，刷新后生效`, 'success');
      await store.init();
      location.reload();
    } catch (err) {
      toast(`导入失败：${(err as Error).message}`, 'error');
    }
  });

  root.querySelector('[data-action="reset-builtin"]')?.addEventListener('click', async () => {
    const a = createLargeSatelliteCase();
    const b = createSmallSatelliteCase();
    // Preserve IDs but update timestamps/content.
    await putCase(a);
    await putCase(b);
    toast('两套内置构型已恢复，页面将刷新', 'success');
    setTimeout(() => location.reload(), 600);
  });

  root.querySelectorAll('[data-delete-case]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = (btn as HTMLElement).dataset.deleteCase!;
      if (id === 'case-500kg' || id === 'case-50kg') {
        toast('内置构型可使用“恢复两套内置构型”，不能直接删除', 'error');
        return;
      }
      await deleteCase(id);
      store.cases = store.cases.filter((c) => c.id !== id);
      toast('方案已删除，刷新视图', 'success');
      location.reload();
    });
  });

  return { el: root };
}

function caseRow(c: ScenarioCase): string {
  return `<tr>
    <td><b>${c.name}</b>${c.builtIn ? ' <span class="tag">内置</span>' : ''}</td>
    <td><code>${c.id}</code></td>
    <td>${c.geometry.massKg} kg</td>
    <td>${new Date(c.updatedAt).toLocaleString('zh-CN')}</td>
    <td><button class="btn danger tiny" data-delete-case="${c.id}">删除</button></td>
  </tr>`;
}
