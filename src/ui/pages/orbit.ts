import type { AttitudeManeuver, ManeuverAxis } from '../../types';
import { store } from '../store';
import { button, card, field, h, numberInput, selectInput } from '../dom';
import { sunSynchronousInclinationDeg, buildOrbitStates } from '../../lib/orbit';
import { uid } from '../../lib/math';

function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToISO(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function maneuverEditor(mv: AttitudeManeuver, repaint: () => void): HTMLElement {
  const item = h('div', { class: 'maneuver-card' });
  const grid = h('div', { class: 'form-grid-4' });
  const bind = (label: string, key: keyof AttitudeManeuver, step = 1) => field(label, numberInput(mv[key] as number, (v) => {
    store.updatePlan((p) => { const x = p.attitude.maneuvers.find((q) => q.id === mv.id); if (x) (x as unknown as Record<string, number>)[key] = v; });
  }, { step }));
  grid.append(
    field('名称', h('input', { class: 'input', value: mv.name, onChange: (e: Event) => {
      const name = (e.target as HTMLInputElement).value;
      store.updatePlan((p) => { const x = p.attitude.maneuvers.find((q) => q.id === mv.id); if (x) x.name = name; });
    } }) as HTMLInputElement),
    field('类型', selectInput<ManeuverAxis>(mv.axis, [['yaw', '偏航 yaw'], ['pitch', '俯仰 pitch'], ['roll', '滚动 roll']], (axis) => {
      store.updatePlan((p) => { const x = p.attitude.maneuvers.find((q) => q.id === mv.id); if (x) x.axis = axis; });
      repaint();
    })),
    bind('开始 s', 'startSec', 10),
    bind('角度°', 'angleDeg', 1),
    bind('进入 s', 'enterDurationSec', 5),
    bind('保持 s', 'holdDurationSec', 10),
    bind('退出 s', 'exitDurationSec', 5),
  );
  item.append(h('div', { class: 'maneuver-head' }, h('strong', {}, '四元数 SLERP 机动'), h('span', { class: 'spacer' }), button('删除', () => {
    store.updatePlan((p) => { p.attitude.maneuvers = p.attitude.maneuvers.filter((x) => x.id !== mv.id); });
    repaint();
  }, { variant: 'danger' })), grid);
  return item;
}

export function renderOrbitPage(root: HTMLElement): () => void {
  let cancelled = false;
  let preview: HTMLElement | null = null;

  const paint = () => {
    if (cancelled) return;
    root.replaceChildren();
    const plan = store.state.plan;
    const o = plan.orbit;
    const a = plan.attitude;

    root.append(h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, '轨道与姿态'), h('p', { class: 'page-desc' }, '录入轨道六根数，一键设置太阳同步倾角；日期驱动太阳方向和地影进出时刻。姿态支持对地、对日、惯性定向，并可插入偏航/滚动四元数插值机动。')),
      h('div', { class: 'head-actions' }, button('保存方案到 IndexedDB', async () => { await store.saveNow(); store.toast('方案已保存到 IndexedDB', 'success'); }, { variant: 'success', icon: '💾' })),
    ));

    const layout = h('div', { class: 'two-col' });
    const left = h('div', { class: 'stack' });

    const orbitCard = card('轨道六根数与日期',
      h('div', { class: 'form-grid-3' },
        field('推演起始日期/时间 (本地输入)', h('input', {
          type: 'datetime-local', class: 'input', value: isoToLocalInput(plan.dateISO),
          onChange: (e: Event) => {
            const iso = localInputToISO((e.target as HTMLInputElement).value);
            store.updatePlan((p) => { p.dateISO = iso; p.orbit.epochISO = iso; });
            updatePreview();
          },
        }) as HTMLInputElement),
        field('半长轴 a km', numberInput(o.semiMajorAxisKm, (v) => store.updatePlan((p) => { p.orbit.semiMajorAxisKm = v; }), { step: 1 })),
        field('偏心率 e', numberInput(o.eccentricity, (v) => store.updatePlan((p) => { p.orbit.eccentricity = v; }), { step: 0.0001, min: 0, max: 0.9 })),
        field('倾角 i°', numberInput(o.inclinationDeg, (v) => store.updatePlan((p) => { p.orbit.inclinationDeg = v; }), { step: 0.01 })),
        field('升交点赤经 Ω°', numberInput(o.raanDeg, (v) => store.updatePlan((p) => { p.orbit.raanDeg = v; }), { step: 1 })),
        field('近地点幅角 ω°', numberInput(o.argPerigeeDeg, (v) => store.updatePlan((p) => { p.orbit.argPerigeeDeg = v; }), { step: 1 })),
        field('初始平近点角 M₀°', numberInput(o.meanAnomaly0Deg, (v) => store.updatePlan((p) => { p.orbit.meanAnomaly0Deg = v; }), { step: 1 })),
      ),
      h('div', { class: 'button-row' },
        button('设为太阳同步轨道', () => {
          const inc = sunSynchronousInclinationDeg(o.semiMajorAxisKm, o.eccentricity);
          store.updatePlan((p) => { p.orbit.inclinationDeg = Number(inc.toFixed(3)); });
          paint();
          store.toast(`已按 J2 回归条件设置倾角 ${inc.toFixed(3)}°`, 'success');
        }, { variant: 'primary' }),
        button('刷新地影预报', updatePreview),
      ),
      h('p', { class: 'hint' }, '修改日期后，太阳矢量按低精度天文公式计算；地影采用地球视圆盘/太阳视圆盘的棱锥半影模型。'),
    );
    preview = h('div', { class: 'preview-box' }, '点击“刷新地影预报”查看本轨地影区间。');
    orbitCard.append(preview);
    left.append(orbitCard);

    const attCard = card('姿态主模式',
      h('div', { class: 'form-grid-3' },
        field('姿态模式', selectInput(a.mode, [['nadir', '对地定向'], ['sun', '对日定向'], ['inertial', '惯性定向']], (mode) => {
          store.updatePlan((p) => { p.attitude.mode = mode; });
          paint();
        })),
        a.mode === 'sun' ? field('对日跟踪轴', selectInput(a.sunTrackingAxis, [['normal', '基准法向/本体 Z'], ['z', '本体 Z'], ['x', '本体 X']], (sunTrackingAxis) => store.updatePlan((p) => { p.attitude.sunTrackingAxis = sunTrackingAxis; }))) : h('div', {}),
        a.mode === 'inertial' ? field('惯性姿态 yaw/pitch/roll', h('div', { class: 'vec3' },
          h('label', { class: 'vec-field' }, h('span', {}, 'Y'), numberInput(a.inertialEuler.yaw, (yaw) => store.updatePlan((p) => { p.attitude.inertialEuler.yaw = yaw; }))),
          h('label', { class: 'vec-field' }, h('span', {}, 'P'), numberInput(a.inertialEuler.pitch, (pitch) => store.updatePlan((p) => { p.attitude.inertialEuler.pitch = pitch; }))),
          h('label', { class: 'vec-field' }, h('span', {}, 'R'), numberInput(a.inertialEuler.roll, (roll) => store.updatePlan((p) => { p.attitude.inertialEuler.roll = roll; }))),
        )) : h('div', {}),
      ),
      h('p', { class: 'hint' }, a.mode === 'nadir'
        ? '本体 +Z 指向星下点，+X 跟踪速度方向；机动以本体系四元数偏置叠加。'
        : a.mode === 'sun' ? '所选本体轴通过最短弧四元数对准太阳方向。' : '整个轨道保持给定惯性欧拉角。'),
    );
    left.append(attCard);

    const manCard = card(`机动序列（${a.maneuvers.length}）`,
      h('div', { class: 'button-row' },
        button('插入偏航机动', () => addManeuver('yaw', 25), { variant: 'primary' }),
        button('插入滚动机动', () => addManeuver('roll', 18), { variant: 'primary' }),
        button('插入俯仰机动', () => addManeuver('pitch', 12)),
      ),
      h('div', { class: 'stack' }, ...a.maneuvers.map((mv) => maneuverEditor(mv, paint))),
      h('p', { class: 'hint' }, '进入/退出段在单位四元数和目标四元数之间 SLERP；保持段锁定目标角。时间轴单位为从推演起点计的秒。'),
    );
    left.append(manCard);

    const right = h('div', { class: 'stack' },
      card('评审关注', h('ul', { class: 'check-list' },
        h('li', {}, '地影段内发电为零，需由蓄电池承担载荷；页面同时给出光照区最差功率，用于回答“阴影最大时还够不够开机”。'),
        h('li', {}, '偏航/滚动机动会改变太阳翼入射角和投影关系，可在受照推演页拖动时间轴逐片检查。'),
        h('li', {}, '工况对比页会固定同一天和同一轨道，只叠加不同构型/姿态结果。'),
      )),
    );

    layout.append(left, right);
    root.append(layout);
    updatePreview();
  };

  function addManeuver(axis: ManeuverAxis, angle: number): void {
    const mv: AttitudeManeuver = {
      id: uid('maneuver'), name: `${axis === 'yaw' ? '偏航' : axis === 'roll' ? '滚动' : '俯仰'}机动`,
      startSec: 1800, enterDurationSec: 90, holdDurationSec: 300, exitDurationSec: 90,
      axis, angleDeg: angle,
    };
    store.updatePlan((p) => p.attitude.maneuvers.push(mv));
    paint();
  }

  function updatePreview(): void {
    if (!preview || cancelled) return;
    try {
      const plan = store.state.plan;
      const { states, periodSec } = buildOrbitStates(plan.orbit, plan.dateISO, 30);
      const intervals: string[] = [];
      let start: number | null = null;
      for (let i = 0; i < states.length; i++) {
        const ecl = states[i].inEclipse;
        if (ecl && start === null) start = states[i].tSec;
        if ((!ecl || i === states.length - 1) && start !== null) {
          const end = states[Math.max(0, i - 1)].tSec;
          intervals.push(`${Math.round(start / 60)}–${Math.round(end / 60)} min`);
          start = null;
        }
      }
      const sun = states[0].sunECI;
      preview.innerHTML = `<div class="preview-grid">
        <div><span>轨道周期</span><strong>${(periodSec / 60).toFixed(1)} min</strong></div>
        <div><span>初始太阳 ECI</span><strong>${sun.map((v) => v.toFixed(3)).join(', ')}</strong></div>
        <div class="span-2"><span>地影区间</span><strong>${intervals.length ? intervals.join('；') : '本采样未检测到地影'}</strong></div>
      </div>`;
    } catch (err) {
      preview.textContent = `轨道参数有误：${(err as Error).message}`;
    }
  }

  paint();
  return () => { cancelled = true; };
}
