import { store } from '../store';
import { button, card, checkboxInput, field, h, numberInput, selectInput, textInput, stat } from '../dom';
import { idbClearAll, idbDeletePlan, idbGetAllPlans, idbPutPlan } from '../../lib/db';
import { createDefaultPlan } from '../../lib/defaults';
import { runSimulation } from '../../lib/simulation';
import { cosineLawSelfCheck } from '../../lib/electrical';
import { getAdapterInfo, getWebGPUDevice, webgpuAvailableSync } from '../../webgpu/device';
import { downloadText } from '../../lib/export';
import { uid } from '../../lib/math';
import type { WorkspacePlan } from '../../types';

export function renderSettingsPage(root: HTMLElement): () => void {
  let cancelled = false;
  let validation: HTMLElement | null = null;
  let planName = '';
  let savedPlans: WorkspacePlan[] = [];

  const paint = () => {
    if (cancelled) return;
    root.replaceChildren();
    const s = store.state.plan.settings;

    root.append(h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, '设置与验收'), h('p', { class: 'page-desc' }, '配置太阳常数、地球反照经验系数、阴影采样、多次反照和载荷阈值；管理 IndexedDB 方案，并执行余弦定律与 3 秒性能验收。')),
      h('div', { class: 'head-actions' }, button('保存当前方案', async () => { await store.saveNow(); store.toast('已保存', 'success'); }, { variant: 'success', icon: '💾' })),
    ));

    const grid = h('div', { class: 'settings-grid' });
    const physics = card('物理与推演参数', h('div', { class: 'form-grid-3' },
      field('时间步长 s', numberInput(s.stepSec, (v) => store.updatePlan((p) => { p.settings.stepSec = Math.max(1, v); }), { min: 1 })),
      field('阴影采样每边点数', selectInput(String(s.shadowSamplesPerAxis), [['2', '2×2（快）'], ['4', '4×4（默认）'], ['6', '6×6'], ['8', '8×8（精细）']], (v) => store.updatePlan((p) => { p.settings.shadowSamplesPerAxis = Number(v); }))),
      field('太阳常数 W/m²', numberInput(s.solarConstantWm2, (v) => store.updatePlan((p) => { p.settings.solarConstantWm2 = v; }), { min: 1000 })),
      field('地球反照系数', numberInput(s.earthAlbedo, (v) => store.updatePlan((p) => { p.settings.earthAlbedo = v; }), { step: 0.01, min: 0, max: 1 })),
      field('地球半径 km', numberInput(s.earthRadiusKm, (v) => store.updatePlan((p) => { p.settings.earthRadiusKm = v; }), { step: 1 })),
      field('载荷开机阈值 W', numberInput(s.nominalLoadW, (v) => store.updatePlan((p) => { p.settings.nominalLoadW = v; }), { min: 0 })),
    ));

    physics.append(h('h3', { class: 'subhead' }, '多次反照 / 反射路径'));
    physics.append(h('div', { class: 'form-grid-3' },
      field('启用多次反照', checkboxInput(s.multiBounceEnabled, (v) => store.updatePlan((p) => { p.settings.multiBounceEnabled = v; }))),
      field('每片反射光线数', numberInput(s.bounceRaysPerCell, (v) => store.updatePlan((p) => { p.settings.bounceRaysPerCell = Math.round(v); }), { min: 1, max: 32 })),
      field('反射弹射次数', numberInput(s.bounceCount, (v) => store.updatePlan((p) => { p.settings.bounceCount = Math.round(v); }), { min: 0, max: 4 })),
      field('使用 WebGPU 计算', checkboxInput(s.useGpu, (v) => store.updatePlan((p) => { p.settings.useGpu = v; }))),
    ));
    grid.append(physics);

    const data = card('IndexedDB 方案管理',
      h('div', { class: 'button-row plan-save-row' },
        textInput(planName, (v) => { planName = v; }, { placeholder: '命名方案，例如 SSO-600km-偏航28°' }),
        button('另存命名方案', () => void saveNamedPlan(), { variant: 'primary', icon: '💾' }),
      ),
      h('div', { id: 'plan-library', class: 'plan-library' }, '正在读取本地方案…'),
      h('div', { class: 'button-row wrap' },
        button('导出当前方案 JSON', () => downloadText('workspace-plan.json', JSON.stringify(store.state.plan, null, 2), 'application/json;charset=utf-8'), { variant: 'ghost' }),
        button('导入方案 JSON', () => root.querySelector('#import-json')?.dispatchEvent(new MouseEvent('click')), { variant: 'ghost' }),
        h('input', { id: 'import-json', type: 'file', accept: '.json,application/json', hidden: true, onChange: importJson }) as HTMLInputElement,
        button('恢复默认 500 kg 方案', () => { store.set({ plan: createDefaultPlan(), result: null }); store.toast('已恢复默认方案', 'success'); paint(); }, { variant: 'ghost' }),
        button('清空 IndexedDB', async () => { await idbClearAll(); savedPlans = []; store.toast('IndexedDB 已清空，刷新后恢复内置构型', 'success'); void refreshPlanLibrary(); }, { variant: 'danger' }),
      ),
      h('p', { class: 'hint' }, '当前工作区会自动防抖保存；命名方案写入 plans 对象仓库，对比工况写入 cases 对象仓库。导出的 JSON 可用于评审归档。'),
    );
    grid.append(data);

    const gpu = card('WebGPU 状态', h('div', { id: 'gpu-status', class: 'status-list' }, '正在检测…'));
    grid.append(gpu);

    validation = card('验收：余弦定律与整轨性能',
      h('div', { class: 'button-row' },
        button('运行余弦定律自检', runCosine, { variant: 'primary' }),
        button('按 10 s 步长运行性能验收', () => void runAcceptance(), { variant: 'success' }),
      ),
      h('div', { id: 'validation-output', class: 'validation-output' }, '验收标准：无遮挡平面串 P(θ)=P₀cosθ，最大误差 < 0.5%；一整轨 10 s 步长页面推演 < 3000 ms。'),
    );
    grid.append(validation);

    root.append(grid);
    void detectGpu();
    void refreshPlanLibrary();
    runCosine(false);
  };

  async function saveNamedPlan(): Promise<void> {
    const plan = structuredClone(store.state.plan) as WorkspacePlan;
    plan.id = uid('plan');
    plan.name = planName.trim() || `命名方案 ${new Date().toLocaleString('zh-CN')}`;
    plan.updatedAt = Date.now();
    await idbPutPlan(plan);
    planName = '';
    store.toast('命名方案已存入 IndexedDB', 'success');
    await refreshPlanLibrary();
  }

  async function refreshPlanLibrary(): Promise<void> {
    try {
      savedPlans = (await idbGetAllPlans()).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      savedPlans = [];
    }
    const box = document.getElementById('plan-library');
    if (!box) return;
    if (!savedPlans.length) {
      box.innerHTML = '<div class="plan-empty">还没有命名方案；当前工作区仍会自动保存。</div>';
      return;
    }
    box.replaceChildren(...savedPlans.map((p) => h('div', { class: 'case-row plan-row' },
      h('div', { class: 'case-main' },
        h('strong', {}, p.name),
        h('small', {}, `${p.model.massClassKg} kg · ${p.attitude.mode} · ${new Date(p.updatedAt).toLocaleString('zh-CN')}`),
      ),
      button('载入', async () => {
        store.set({ plan: structuredClone(p), result: null });
        await store.saveNow();
        store.toast(`已载入方案：${p.name}`, 'success');
        paint();
      }, { variant: 'ghost' }),
      button('删除', async () => {
        await idbDeletePlan(p.id);
        await refreshPlanLibrary();
        store.toast('命名方案已删除', 'info');
      }, { variant: 'danger' }),
    )));
  }

  async function detectGpu(): Promise<void> {
    const box = document.getElementById('gpu-status');
    if (!box) return;
    if (!webgpuAvailableSync()) {
      box.innerHTML = '<div class="status-bad">navigator.gpu 不存在。请使用启用 WebGPU 的 Chrome/Edge；系统会自动使用 CPU 兼容引擎。</div>';
      return;
    }
    const device = await getWebGPUDevice();
    const info = getAdapterInfo();
    box.innerHTML = device
      ? `<div class="status-good">WebGPU 设备已就绪。</div><pre class="code-block">${JSON.stringify(info ?? { note: '适配器信息不可用' }, null, 2)}</pre>`
      : '<div class="status-warn">检测到 navigator.gpu，但未能取得 GPUDevice；已启用 CPU 兜底。</div>';
  }

  function runCosine(showToast = true): void {
    const r = cosineLawSelfCheck();
    const box = document.getElementById('validation-output');
    if (box) {
      box.innerHTML = `<div class="validation-head ${r.passed ? 'good-text' : 'bad-text'}">余弦自检最大误差 ${r.maxErrorPct.toFixed(6)}% — ${r.passed ? '通过' : '未通过'}</div>
        <table class="data-table compact"><thead><tr><th>入射角°</th><th>解析 W</th><th>模型 W</th><th>误差 %</th></tr></thead><tbody>
        ${r.details.map((d) => `<tr><td>${d.angleDeg}</td><td>${d.expectedW.toFixed(4)}</td><td>${d.actualW.toFixed(4)}</td><td>${d.errorPct.toFixed(6)}</td></tr>`).join('')}
        </tbody></table>`;
    }
    if (showToast) store.toast(r.passed ? `余弦自检通过：${r.maxErrorPct.toFixed(4)}%` : '余弦自检未通过', r.passed ? 'success' : 'error');
  }

  async function runAcceptance(): Promise<void> {
    const box = document.getElementById('validation-output');
    if (box) box.innerHTML = '<div class="status-warn">正在运行整轨验收，请稍候…</div>';
    const acceptancePlan = structuredClone(store.state.plan);
    acceptancePlan.settings.stepSec = 10;
    try {
      const r = await runSimulation(acceptancePlan, { forceEngine: acceptancePlan.settings.useGpu ? undefined : 'cpu' });
      store.setResult(r);
      const cos = r.cosineCheck;
      const perfPass = r.elapsedMs < 3000;
      if (box) {
        box.innerHTML = `<div class="acceptance-grid">
          ${stat('性能', `${r.elapsedMs.toFixed(0)} ms`, perfPass ? '小于 3000 ms' : '超过 3000 ms', perfPass ? 'good' : 'bad').outerHTML}
          ${stat('余弦误差', `${cos.maxErrorPct.toFixed(4)}%`, cos.passed ? '小于 0.5%' : '超标', cos.passed ? 'good' : 'bad').outerHTML}
          ${stat('引擎', r.engine, `${r.epochCount} 历元 × ${r.cellCount} 片`, r.engine === 'webgpu' ? 'good' : 'warn').outerHTML}
        </div>
        <p class="hint">已把本次验收结果写入全局结果，可切换到“受照推演”或“发电曲线”查看。${r.engine !== 'webgpu' ? '当前为 CPU 引擎；性能验收以支持 WebGPU 的目标浏览器为准。' : ''}</p>`;
      }
      store.toast(`验收完成：${r.elapsedMs.toFixed(0)} ms，余弦误差 ${cos.maxErrorPct.toFixed(4)}%`, perfPass && cos.passed ? 'success' : 'error', 5000);
    } catch (err) {
      if (box) box.innerHTML = `<div class="status-bad">验收失败：${(err as Error).message}</div>`;
    }
  }

  function importJson(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as ReturnType<typeof createDefaultPlan>;
        if (!parsed.model || !parsed.orbit || !parsed.attitude) throw new Error('缺少 model/orbit/attitude 字段');
        parsed.settings = { ...store.state.plan.settings, ...parsed.settings };
        store.set({ plan: parsed, result: null });
        void store.saveNow();
        paint();
        store.toast('方案导入成功', 'success');
      } catch (err) {
        store.toast(`导入失败：${(err as Error).message}`, 'error', 5000);
      }
    };
    reader.readAsText(file);
  }

  paint();
  return () => { cancelled = true; };
}
