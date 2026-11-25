import type { PageHandle } from './types';
import type { Maneuver } from '../types';
import { store } from '../state';
import { bindRoot, el, field, numInput, selectInput, toast, vec3Inputs } from '../components/ui';
import { setPath } from '../components/ui';
import { orbitalPeriodSec, ssoInclinationDeg, sunDirectionEci, findEclipseIntervals, betaAngleDeg } from '../lib/orbit';
import { formatClock } from '../lib/format';
import { uid } from '../lib/math';

export function renderOrbitPage(): PageHandle {
  const draft = structuredClone(store.current());
  const root = el<HTMLElement>('<section class="page"></section>');

  root.innerHTML = `
    <header class="page-header">
      <div><h1>轨道与姿态</h1><p>录入经典六根数或一键填入太阳同步倾角；日期驱动太阳方向、β 角和地影进出时刻。姿态支持对地、对日、惯性定向，机动使用四元数 slerp。</p></div>
      <div class="actions"><span class="save-state">修改自动存入 IndexedDB</span></div>
    </header>
    <div class="grid two">
      <section class="card">
        <div class="card-title"><h2>轨道六根数</h2><button class="btn" data-action="sso">应用太阳同步轨道倾角</button></div>
        <div class="form-grid">
          ${field('日期 / 历元（UTC）', `<input type="datetime-local" data-role="epoch" step="60" value="${toLocalInput(draft.orbit.epochISO)}"/>`, '改日期后太阳方向和地影时刻立即重算')}
          ${field('半长轴 a km', numInput('orbit.aKm', draft.orbit.aKm, '0.001'))}
          ${field('偏心率 e', numInput('orbit.eccentricity', draft.orbit.eccentricity, '0.0001', 0))}
          ${field('倾角 i °', numInput('orbit.inclinationDeg', draft.orbit.inclinationDeg, '0.001', 0))}
          ${field('升交点赤经 Ω °', numInput('orbit.raanDeg', draft.orbit.raanDeg, '0.01'))}
          ${field('近地点幅角 ω °', numInput('orbit.argPerigeeDeg', draft.orbit.argPerigeeDeg, '0.01'))}
          ${field('初始平近点角 M0 °', numInput('orbit.meanAnomalyDeg', draft.orbit.meanAnomalyDeg, '0.01'))}
        </div>
        <div class="metrics" data-role="orbit-metrics"></div>
      </section>

      <section class="card">
        <h2>姿态稳定模式</h2>
        <div class="form-grid">
          ${field('主模式', selectInput('attitude.mode', draft.attitude.mode, [['nadir', '对地定向（LVLH）'], ['sun', '对日定向（本体 +X 指日）'], ['inertial', '惯性定向']]))}
          ${field('固定偏置 XYZ °', vec3Inputs('attitude.offsetDeg', draft.attitude.offsetDeg, '0.1'))}
          ${field('惯性四元数 x,y,z,w', `<div class="vec3 four">${[0, 1, 2, 3].map((i) => `<input data-bind="attitude.inertialQuat.${i}" type="number" step="0.001" value="${draft.attitude.inertialQuat[i]}"/>`).join('')}</div>`)}
        </div>
        <div class="info-box">对地模式由 r/v 构造 LVLH；对日模式用最短弧四元数将本体 +X 对准太阳，并保留对地参考扭转。偏航绕本体 Z、滚动绕本体 X，均经 smoothstep 后做四元数插值。</div>
      </section>
    </div>

    <section class="card">
      <div class="card-title">
        <h2>姿态机动时间线</h2>
        <div class="actions">
          <button class="btn small" data-action="add-yaw">＋ 插入偏航机动</button>
          <button class="btn small" data-action="add-roll">＋ 插入滚动机动</button>
        </div>
      </div>
      <div class="table-scroll"><table class="data-table maneuvers">
        <thead><tr><th>类型</th><th>开始 s</th><th>持续 s</th><th>角度 °</th><th>插值</th><th></th></tr></thead>
        <tbody>
          ${draft.attitude.maneuvers.map((m, i) => maneuverRow(m, i)).join('')}
        </tbody>
      </table></div>
    </section>

    <section class="card"><h2>日期相关光照与地影预报</h2><div data-role="light-info" class="light-info"></div></section>`;

  const unbind = bindRoot(root, (path, value) => {
    setPath(draft, path, value);
    void store.updateCase(draft, { silent: true });
    updateInfo();
  });

  root.querySelector<HTMLInputElement>('[data-role="epoch"]')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLInputElement).value;
    if (v) {
      draft.orbit.epochISO = new Date(v).toISOString();
      void store.updateCase(draft, { silent: true });
      updateInfo();
      toast('太阳历与地影进出时刻已更新', 'success');
    }
  });

  root.querySelector('[data-action="sso"]')?.addEventListener('click', () => {
    draft.orbit.inclinationDeg = ssoInclinationDeg(draft.orbit.aKm);
    void store.updateCase(draft, { silent: true });
    paintFormValues();
    updateInfo();
    toast(`已按 J2 太阳同步回归率设置倾角 ${draft.orbit.inclinationDeg.toFixed(3)}°`, 'success');
  });

  root.querySelector('[data-action="add-yaw"]')?.addEventListener('click', () => addManeuver('yaw'));
  root.querySelector('[data-action="add-roll"]')?.addEventListener('click', () => addManeuver('roll'));
  root.querySelectorAll('[data-action="remove-maneuver"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.id!;
      draft.attitude.maneuvers = draft.attitude.maneuvers.filter((m) => m.id !== id);
      void store.updateCase(draft, { silent: true });
      repaintManeuvers();
    });
  });

  function addManeuver(kind: 'yaw' | 'roll') {
    const m: Maneuver = { id: uid('man'), kind, startSec: 600, durationSec: 120, angleDeg: kind === 'yaw' ? 20 : 15 };
    draft.attitude.maneuvers.push(m);
    void store.updateCase(draft, { silent: true });
    repaintManeuvers();
  }

  function repaintManeuvers() {
    const tbody = root.querySelector('.maneuvers tbody');
    if (!tbody) return;
    tbody.innerHTML = draft.attitude.maneuvers.map((m, i) => maneuverRow(m, i)).join('');
    tbody.querySelectorAll('[data-action="remove-maneuver"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id!;
        draft.attitude.maneuvers = draft.attitude.maneuvers.filter((m) => m.id !== id);
        void store.updateCase(draft, { silent: true });
        repaintManeuvers();
      });
    });
  }

  function paintFormValues() {
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-bind]').forEach((input) => {
      const path = input.dataset.bind!;
      const value = getPath(draft, path);
      if (input.type === 'checkbox') (input as HTMLInputElement).checked = !!value;
      else input.value = String(value ?? '');
    });
  }

  function updateInfo() {
    const period = orbitalPeriodSec(draft.orbit);
    const sso = ssoInclinationDeg(draft.orbit.aKm);
    const sun = sunDirectionEci(new Date(draft.orbit.epochISO));
    const beta = betaAngleDeg(draft.orbit, sun);
    const intervals = findEclipseIntervals(draft.orbit, sun, period);
    const metrics = root.querySelector('[data-role="orbit-metrics"]');
    if (metrics) {
      metrics.innerHTML = `
        <div><span>轨道周期</span><b>${formatClock(period)}（${(period / 60).toFixed(2)} min）</b></div>
        <div><span>平均运动</span><b>${(360 / (period / 60)).toFixed(4)} °/min</b></div>
        <div><span>该高度 SSO 倾角</span><b>${sso.toFixed(3)}°</b></div>
        <div><span>太阳 β 角</span><b>${beta.toFixed(2)}°</b></div>`;
    }
    const info = root.querySelector('[data-role="light-info"]');
    if (info) {
      info.innerHTML = `
        <div class="metric-line"><b>ECI 太阳单位矢量：</b> [${sun.map((x) => x.toFixed(5)).join(', ')}]</div>
        <div class="metric-line"><b>地影区间：</b>${intervals.length ? intervals.map((i) => `${formatClock(i.startSec)} → ${formatClock(i.endSec)}（${Math.round(i.endSec - i.startSec)} s）`).join('；') : '本轨无地影'}</div>
        <div class="metric-line hint">地影采用柱/半影软化模型，720 点粗扫描后对 0.5 阴影因子边界做 24 次二分精化。</div>`;
    }
  }

  updateInfo();
  return { el: root, destroy: unbind };
}

function maneuverRow(m: Maneuver, index: number): string {
  const p = `attitude.maneuvers.${index}`;
  return `
  <tr data-maneuver="${m.id}">
    <td>${m.kind === 'yaw' ? '偏航（绕 Z）' : m.kind === 'roll' ? '滚动（绕 X）' : '四元数'}</td>
    <td><input type="number" data-bind="${p}.startSec" value="${m.startSec}"/></td>
    <td><input type="number" data-bind="${p}.durationSec" value="${m.durationSec}"/></td>
    <td><input type="number" data-bind="${p}.angleDeg" value="${m.angleDeg}"/></td>
    <td>Quat.slerp + smoothstep</td>
    <td><button class="btn danger tiny" data-action="remove-maneuver" data-id="${m.id}">删除</button></td>
  </tr>`;
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, key) => {
    if (cur == null) return undefined;
    return (cur as Record<string, unknown>)[key];
  }, obj);
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
