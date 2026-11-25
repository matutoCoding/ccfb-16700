import type { CompareCase, SimulationResult } from '../../types';
import { store } from '../store';
import { button, card, field, formatSeconds, h, numberInput, textInput } from '../dom';
import { caseFromPlan, createSatellite50, createSatellite500, defaultAttitude } from '../../lib/defaults';
import { runComparisonCase } from '../../lib/simulation';
import { compareChart } from '../charts';
import { downloadText, toCSV } from '../../lib/export';
import { uid } from '../../lib/math';

interface ComparedRun {
  id: string;
  name: string;
  color: string;
  mass: number;
  attitudeMode: string;
  result: SimulationResult;
}

const COLORS = ['#38bdf8', '#f97316', '#a78bfa', '#22c55e', '#f43f5e', '#eab308'];

export function renderComparePage(root: HTMLElement): () => void {
  let cancelled = false;
  let caseName = '';
  let selected = new Set<string>(store.state.cases.slice(0, 4).map((c) => c.id));
  let includeCurrent = true;
  let runs: ComparedRun[] = [];
  let running = false;
  let baselineId = 'current';

  const paint = () => {
    if (cancelled) return;
    root.replaceChildren();
    const plan = store.state.plan;
    const cases = store.state.cases;

    root.append(h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, '工况对比'), h('p', { class: 'page-desc' }, '保存多套“构型 + 姿态”，强制使用同一天日期和同一套轨道六根数，将整轨功率曲线叠加，并把最小功率、发电量和峰值差值列成表。')),
    ));

    const top = h('div', { class: 'compare-layout' });
    const left = h('div', { class: 'stack' });

    const saveCard = card('保存工况',
      h('div', { class: 'button-row' },
        textInput(caseName || `${plan.model.name}-${plan.attitude.mode}`, (v) => { caseName = v; }, { placeholder: '工况名称' }),
        button('保存当前构型+姿态', async () => {
          const item = caseFromPlan(plan, caseName.trim() || `${plan.model.name} / ${plan.attitude.mode}`);
          await store.addCompareCase(item);
          selected.add(item.id);
          caseName = '';
          store.toast('工况已存入 IndexedDB', 'success');
          paint();
        }, { variant: 'primary', icon: '＋' }),
      ),
      h('div', { class: 'button-row' },
        button('一键生成 500/50 测试对比组', async () => {
          const orbit = plan.orbit;
          const c500: CompareCase = {
            id: uid('case'), name: '500 kg 典型对地+机动', savedAt: Date.now(),
            model: createSatellite500(), attitude: defaultAttitude(), orbitSnapshot: orbit, dateSnapshot: plan.dateISO,
          };
          const att50 = defaultAttitude();
          att50.maneuvers = att50.maneuvers.slice(0, 1).map((m) => ({ ...m, angleDeg: 20 }));
          const c50: CompareCase = {
            id: uid('case'), name: '50 kg 轻量平台', savedAt: Date.now(),
            model: createSatellite50(), attitude: att50, orbitSnapshot: orbit, dateSnapshot: plan.dateISO,
          };
          await store.addCompareCase(c500);
          await store.addCompareCase(c50);
          selected = new Set([c500.id, c50.id]);
          store.toast('已生成两套测试构型工况', 'success');
          paint();
        }, { variant: 'success' }),
      ),
      h('div', { class: 'shared-orbit' },
        h('strong', {}, '统一比较基准'),
        h('span', {}, `日期 ${plan.dateISO}`),
        h('span', {}, `a=${plan.orbit.semiMajorAxisKm} km，i=${plan.orbit.inclinationDeg}°，Ω=${plan.orbit.raanDeg}°`),
        h('button', { class: 'link-btn', onClick: () => store.setRoute('orbit') }, '到轨道页修改 →'),
      ),
    );
    left.append(saveCard);

    const caseCard = card(`已存工况（${cases.length}）`,
      h('label', { class: 'case-row current' },
        h('input', { type: 'checkbox', checked: includeCurrent, onChange: (e: Event) => { includeCurrent = (e.target as HTMLInputElement).checked; } }),
        h('strong', {}, '当前工作区'),
        h('span', { class: 'tag' }, `${plan.model.massClassKg} kg`),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted' }, plan.attitude.mode),
      ),
      h('div', { class: 'case-list' }, ...cases.map((c, i) => {
        const checked = selected.has(c.id);
        return h('div', { class: 'case-row' },
          h('input', { type: 'checkbox', checked, onChange: (e: Event) => {
            if ((e.target as HTMLInputElement).checked) selected.add(c.id); else selected.delete(c.id);
          } }),
          h('span', { class: 'color-dot', style: `background:${COLORS[(i + 1) % COLORS.length]}` }),
          h('div', { class: 'case-main' }, h('strong', {}, c.name), h('small', {}, c.notes ?? `${c.model.massClassKg} kg · ${c.attitude.mode}`)),
          h('span', { class: 'tag' }, `${c.model.wings.reduce((s, w) => s + w.cols * w.rows, 0)} 片`),
          button('删除', async () => { await store.removeCompareCase(c.id); selected.delete(c.id); paint(); }, { variant: 'danger' }),
        );
      })),
      h('div', { class: 'button-row' },
        button(running ? '对比推演中…' : `运行选中工况（${selected.size + (includeCurrent ? 1 : 0)}）`, () => void execute(), { variant: 'primary', disabled: running }),
        button('导出对比差值 CSV', exportDiffCsv, { variant: 'success', disabled: runs.length === 0 }),
      ),
    );
    left.append(caseCard);

    const right = h('div', { class: 'stack compare-results' });
    if (runs.length) {
      right.append(card('功率曲线叠加', h('div', { class: 'chart-wrap', html: compareChart(runs.map((r) => ({ name: r.name, color: r.color, result: r.result })), plan.settings.nominalLoadW) }),
        h('div', { class: 'legend-inline' }, ...runs.map((r) => h('span', {}, h('i', { style: `background:${r.color}` }), r.name)))));
      right.append(buildDiffTable());
    } else {
      right.append(card('对比结果', h('div', { class: 'empty-state' }, h('p', {}, '选择工况后点击“运行选中工况”。所有工况会使用本页顶部显示的同一天、同一轨道。'))));
    }

    top.append(left, right);
    root.append(top);
  };

  async function execute(): Promise<void> {
    if (cancelled) return;
    running = true;
    paint();
    const plan = store.state.plan;
    const settings = { ...plan.settings };
    const next: ComparedRun[] = [];
    let colorIndex = 0;
    try {
      if (includeCurrent) {
        const result = await runComparisonCase(plan.model, plan.attitude, plan.orbit, plan.dateISO, settings);
        next.push({ id: 'current', name: `当前：${plan.model.name}`, color: COLORS[0], mass: plan.model.massClassKg, attitudeMode: plan.attitude.mode, result });
        baselineId = 'current';
      }
      for (const c of store.state.cases) {
        if (!selected.has(c.id)) continue;
        colorIndex++;
        const result = await runComparisonCase(c.model, c.attitude, plan.orbit, plan.dateISO, settings);
        next.push({ id: c.id, name: c.name, color: COLORS[colorIndex % COLORS.length], mass: c.model.massClassKg, attitudeMode: c.attitude.mode, result });
      }
      runs = next;
      if (!runs.some((r) => r.id === baselineId)) baselineId = runs[0]?.id ?? 'current';
      store.toast(`完成 ${runs.length} 套工况对比推演`, 'success');
    } catch (err) {
      console.error(err);
      store.toast(`对比失败：${(err as Error).message}`, 'error', 6000);
    } finally {
      running = false;
      paint();
    }
  }

  function metrics(r: ComparedRun) {
    const powers = r.result.epochs.map((e) => e.totalPowerW);
    return {
      peak: Math.max(...powers),
      min: r.result.minTotal.powerW,
      sunlitMin: r.result.minSunlit?.powerW ?? 0,
      energy: r.result.energyWh,
      elapsed: r.result.elapsedMs,
      minT: r.result.minTotal.tSec,
    };
  }

  function buildDiffTable(): HTMLElement {
    const baseline = runs.find((r) => r.id === baselineId) ?? runs[0];
    const base = metrics(baseline);
    const cardEl = card('差值表',
      h('div', { class: 'table-wrap' }, h('table', { class: 'data-table diff-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, '基线'),
          h('th', {}, '工况'), h('th', {}, '质量'), h('th', {}, '姿态'),
          h('th', {}, '峰值 W'), h('th', {}, 'Δ峰值'),
          h('th', {}, '全轨最小 W'), h('th', {}, 'Δ最小'),
          h('th', {}, '光照最差 W'), h('th', {}, 'Δ光照最差'),
          h('th', {}, '发电 Wh'), h('th', {}, 'ΔWh'),
          h('th', {}, '耗时 ms'),
        )),
        h('tbody', {}, ...runs.map((r) => {
          const m = metrics(r);
          const isBase = r.id === baseline.id;
          return h('tr', { class: isBase ? 'baseline-row' : '' },
            h('td', {}, h('input', { type: 'radio', name: 'baseline', checked: isBase, onChange: () => { baselineId = r.id; paint(); } })),
            h('td', {}, h('span', { class: 'table-name' }, h('i', { style: `background:${r.color}` }), r.name)),
            h('td', {}, String(r.mass)),
            h('td', {}, r.attitudeMode),
            h('td', {}, m.peak.toFixed(0)),
            h('td', { class: deltaClass(m.peak - base.peak) }, isBase ? '基线' : formatDelta(m.peak - base.peak, 'W')),
            h('td', {}, m.min.toFixed(1)),
            h('td', { class: deltaClass(m.min - base.min, true) }, isBase ? '0' : formatDelta(m.min - base.min, 'W')),
            h('td', {}, m.sunlitMin.toFixed(1)),
            h('td', { class: deltaClass(m.sunlitMin - base.sunlitMin, true) }, isBase ? '0' : formatDelta(m.sunlitMin - base.sunlitMin, 'W')),
            h('td', {}, m.energy.toFixed(1)),
            h('td', { class: deltaClass(m.energy - base.energy) }, isBase ? '0' : formatDelta(m.energy - base.energy, 'Wh')),
            h('td', {}, m.elapsed.toFixed(0)),
          );
        })),
      )),
      h('p', { class: 'hint' }, `最小功率时刻：${runs.map((r) => `${r.name} ${formatSeconds(metrics(r).minT)}`).join('；')}`),
    );
    return cardEl;
  }

  function exportDiffCsv(): void {
    if (!runs.length) return;
    const baseline = runs.find((r) => r.id === baselineId) ?? runs[0];
    const b = metrics(baseline);
    const csv = toCSV(
      ['case', 'mass_kg', 'attitude', 'peak_w', 'delta_peak_w', 'min_w', 'delta_min_w', 'sunlit_min_w', 'delta_sunlit_min_w', 'energy_wh', 'delta_energy_wh', 'elapsed_ms'],
      runs.map((r) => {
        const m = metrics(r);
        return [r.name, r.mass, r.attitudeMode, m.peak, m.peak - b.peak, m.min, m.min - b.min, m.sunlitMin, m.sunlitMin - b.sunlitMin, m.energy, m.energy - b.energy, m.elapsed];
      }),
    );
    downloadText('case_diff.csv', csv);
    store.toast('对比差值 CSV 已导出', 'success');
  }

  function formatDelta(v: number, unit: string): string {
    return `${v >= 0 ? '+' : ''}${v.toFixed(1)} ${unit}`;
  }
  function deltaClass(v: number, higherIsBetter = false): string {
    if (Math.abs(v) < 0.05) return 'muted';
    const good = higherIsBetter ? v > 0 : v > 0;
    return good ? 'good-text' : 'bad-text';
  }

  paint();
  return () => { cancelled = true; };
}
