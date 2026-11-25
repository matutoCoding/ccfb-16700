import './style.css';
import { store, type Route } from './ui/store';
import { h } from './ui/dom';
import { renderConfigPage } from './ui/pages/config';
import { renderOrbitPage } from './ui/pages/orbit';
import { renderSimulatePage } from './ui/pages/simulate';
import { renderPowerPage } from './ui/pages/power';
import { renderComparePage } from './ui/pages/compare';
import { renderSettingsPage } from './ui/pages/settings';
import { getWebGPUDevice } from './webgpu/device';
import { runSimulation } from './lib/simulation';

const NAV: Array<{ route: Route; label: string; icon: string; desc: string }> = [
  { route: 'config', label: '卫星构型', icon: '🛰', desc: '几何与电池串' },
  { route: 'orbit', label: '轨道与姿态', icon: '🧭', desc: '六根数 / 四元数' },
  { route: 'simulate', label: '受照推演', icon: '☀', desc: 'GPU 逐片阴影' },
  { route: 'power', label: '发电曲线', icon: '📈', desc: '全轨最小功率' },
  { route: 'compare', label: '工况对比', icon: '⇄', desc: '同轨叠加差值' },
  { route: 'settings', label: '设置', icon: '⚙', desc: '数据与验收' },
];

let pageCleanup: (() => void) | null = null;
let currentRoute: Route | null = null;

function renderShell(): void {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (!app) return;
  app.replaceChildren();
  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' },
      h('div', { class: 'brand-mark' }, 'SV'),
      h('div', {}, h('strong', {}, '帆影 SolarView'), h('small', {}, '卫星帆板受照与发电推演')),
    ),
    h('nav', { class: 'nav' }, ...NAV.map((item) => h('button', {
      class: `nav-item ${store.state.route === item.route ? 'active' : ''}`,
      onClick: () => store.setRoute(item.route),
    }, h('span', { class: 'nav-icon' }, item.icon), h('span', { class: 'nav-text' }, h('strong', {}, item.label), h('small', {}, item.desc))))),
    h('div', { class: 'sidebar-foot' },
      h('div', { id: 'engine-pill', class: 'engine-pill' }, 'WebGPU 检测中…'),
      h('small', {}, '方案与工况存储于 IndexedDB'),
    ),
  );

  const main = h('main', { class: 'main' }, h('div', { id: 'page-root', class: 'page-root' }));
  const toastHost = h('div', { id: 'toast-host', class: 'toast-host' });
  app.append(sidebar, main, toastHost);
}

function renderRoute(): void {
  if (currentRoute === store.state.route && document.querySelector('#page-root')?.children.length) return;
  currentRoute = store.state.route;
  pageCleanup?.();
  pageCleanup = null;
  document.querySelectorAll('.nav-item').forEach((btn, i) => btn.classList.toggle('active', NAV[i].route === store.state.route));
  const root = document.querySelector<HTMLElement>('#page-root');
  if (!root) return;
  root.scrollTop = 0;
  switch (store.state.route) {
    case 'config': pageCleanup = renderConfigPage(root); break;
    case 'orbit': pageCleanup = renderOrbitPage(root); break;
    case 'simulate': pageCleanup = renderSimulatePage(root); break;
    case 'power': pageCleanup = renderPowerPage(root); break;
    case 'compare': pageCleanup = renderComparePage(root); break;
    case 'settings': pageCleanup = renderSettingsPage(root); break;
  }
}

function renderToasts(): void {
  const host = document.querySelector<HTMLElement>('#toast-host');
  if (!host) return;
  host.replaceChildren(...store.state.toasts.map((t) => h('div', { class: `toast toast-${t.kind}`, onClick: () => store.dismissToast(t.id) }, t.text)));
}

async function main(): Promise<void> {
  renderShell();
  await store.init();
  renderRoute();
  store.subscribe(() => {
    renderToasts();
    if (currentRoute !== store.state.route) renderRoute();
  });

  // Prewarm the adapter/device so the first acceptance run is not paying
  // browser permission/device initialization latency.
  const device = await getWebGPUDevice();
  const pill = document.querySelector('#engine-pill');
  if (pill) {
    pill.textContent = device ? '● WebGPU 已就绪' : '● CPU 兼容引擎';
    pill.classList.add(device ? 'ready' : 'cpu');
  }
}

if (import.meta.env.DEV) {
  (window as unknown as { __solarView?: unknown }).__solarView = { store, runSimulation };
}

void main();
