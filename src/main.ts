import './styles.css';
import { store } from './state';
import { renderConfigPage } from './pages/config';
import { renderOrbitPage } from './pages/orbit-attitude';
import { renderInsolationPage } from './pages/insolation';
import { renderPowerPage } from './pages/power';
import { renderComparePage } from './pages/compare';
import { renderSettingsPage } from './pages/settings';
import type { PageHandle } from './pages/types';

const NAV = [
  { hash: '#config', label: '卫星构型', icon: '🛰️' },
  { hash: '#orbit', label: '轨道与姿态', icon: '🧭' },
  { hash: '#insolation', label: '受照推演', icon: '☀️' },
  { hash: '#power', label: '发电曲线', icon: '📈' },
  { hash: '#compare', label: '工况对比', icon: '⇄' },
  { hash: '#settings', label: '设置', icon: '⚙️' }
] as const;

async function bootstrap() {
  const app = document.querySelector<HTMLDivElement>('#app')!;
  app.innerHTML = '<div class="boot"><span class="spinner big"></span><p>正在打开 IndexedDB 方案库…</p></div>';
  await store.init();

  let cleanup: (() => void) | undefined;

  function renderShell() {
    const hash = normalizeHash(location.hash);
    app.innerHTML = `
      <div class="shell">
        <aside class="sidebar">
          <div class="brand"><div class="brand-mark">☀</div><div><b>SolarArray Lab</b><small>卫星帆板受照与发电推演</small></div></div>
          <nav>${NAV.map((n) => `<a href="${n.hash}" class="nav-item ${hash === n.hash ? 'active' : ''}"><span class="nav-icon">${n.icon}</span>${n.label}</a>`).join('')}</nav>
          <div class="sidebar-foot">
            <label class="case-switch"><span>当前工况</span>
              <select data-role="current-case">${store.cases.map((c) => `<option value="${c.id}" ${c.id === store.currentId ? 'selected' : ''}>${c.name}</option>`).join('')}</select>
            </label>
            <div class="storage-dot"><i></i> IndexedDB 已连接</div>
          </div>
        </aside>
        <main class="main"><div data-role="page" class="page-host"></div></main>
      </div>`;

    app.querySelector<HTMLSelectElement>('[data-role="current-case"]')?.addEventListener('change', (e) => {
      store.currentId = (e.target as HTMLSelectElement).value;
      renderRoute();
    });
  }

  function renderRoute() {
    cleanup?.();
    if (!app.querySelector('.shell')) renderShell();
    else {
      // Update active nav and selector without rebuilding the whole shell.
      const hash = normalizeHash(location.hash);
      app.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === hash));
      const select = app.querySelector<HTMLSelectElement>('[data-role="current-case"]');
      if (select) select.value = store.currentId;
    }
    const host = app.querySelector<HTMLElement>('[data-role="page"]')!;
    host.innerHTML = '';
    const hash = normalizeHash(location.hash);
    let page: PageHandle;
    if (hash === '#orbit') page = renderOrbitPage();
    else if (hash === '#insolation') page = renderInsolationPage();
    else if (hash === '#power') page = renderPowerPage();
    else if (hash === '#compare') page = renderComparePage();
    else if (hash === '#settings') page = renderSettingsPage();
    else page = renderConfigPage();
    host.appendChild(page.el);
    cleanup = page.destroy;
  }

  window.addEventListener('hashchange', renderRoute);
  if (!location.hash) location.hash = '#config';
  renderShell();
  renderRoute();
}

function normalizeHash(hash: string): string {
  const known = NAV.some((n) => n.hash === hash);
  return known ? hash : '#config';
}

bootstrap().catch((err) => {
  console.error(err);
  const app = document.querySelector<HTMLDivElement>('#app')!;
  app.innerHTML = `<div class="boot error"><h1>应用初始化失败</h1><pre>${(err as Error).stack ?? err}</pre></div>`;
});
