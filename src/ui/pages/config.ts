import type { GeometricPrimitive, PrimitiveKind, SatelliteModel, SolarWing } from '../../types';
import { store } from '../store';
import { button, card, checkboxInput, field, h, numberInput, selectInput, textInput } from '../dom';
import { cellPositionsCSV, downloadText } from '../../lib/export';
import { createSatellite50, createSatellite500 } from '../../lib/defaults';
import { uid } from '../../lib/math';
import { mountRenderer, type SatelliteRenderer } from '../../webgpu/renderer';

let renderer: SatelliteRenderer | null = null;

function updateModel(mut: (m: SatelliteModel) => void): void {
  store.updatePlan((p) => mut(p.model));
}

function vec3Fields(value: [number, number, number], labels: [string, string, string], on: (v: [number, number, number]) => void) {
  return h('div', { class: 'vec3' }, ...value.map((v, i) => {
    const input = numberInput(v, (nv) => {
      const next: [number, number, number] = [...value];
      next[i] = nv;
      on(next);
    }, { step: 0.01 });
    return h('label', { class: 'vec-field' }, h('span', {}, labels[i]), input);
  }));
}

function eulerFields(value: { yaw: number; pitch: number; roll: number }, on: (v: { yaw: number; pitch: number; roll: number }) => void) {
  return h('div', { class: 'vec3' },
    h('label', { class: 'vec-field' }, h('span', {}, '偏航°'), numberInput(value.yaw, (yaw) => on({ ...value, yaw }), { step: 1 })),
    h('label', { class: 'vec-field' }, h('span', {}, '俯仰°'), numberInput(value.pitch, (pitch) => on({ ...value, pitch }), { step: 1 })),
    h('label', { class: 'vec-field' }, h('span', {}, '滚动°'), numberInput(value.roll, (roll) => on({ ...value, roll }), { step: 1 })),
  );
}

function primitiveEditor(p: GeometricPrimitive, repaint: () => void): HTMLElement {
  const details = h('details', { class: 'editor-item', open: p.role === 'bus' ? true : undefined }) as HTMLDetailsElement;
  const summary = h('summary', {},
    h('span', { class: `role-dot role-${p.role}` }),
    h('strong', {}, p.name),
    h('span', { class: 'tag' }, p.kind === 'box' ? '长方体/平板' : '圆柱'),
    h('span', { class: 'spacer' }),
    button('删除', () => {
      updateModel((m) => { m.primitives = m.primitives.filter((x) => x.id !== p.id); });
      store.toast('几何组件已删除', 'info');
      repaint();
    }, { variant: 'danger' }),
  );
  summary.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) e.preventDefault();
  });
  details.append(summary);

  const body = h('div', { class: 'editor-grid' });
  body.append(field('名称', textInput(p.name, (v) => updateModel((m) => { const x = m.primitives.find((q) => q.id === p.id); if (x) x.name = v; if (renderer) renderer.setModel(store.state.plan.model); }))));
  body.append(field('类型', selectInput<PrimitiveKind>(p.kind, [['box', '长方体'], ['plate', '平板（薄长方体）'], ['cylinder', '圆柱']], (kind) => {
    updateModel((m) => { const x = m.primitives.find((q) => q.id === p.id); if (x) x.kind = kind; });
    repaint();
  })));
  body.append(field('功能分类', selectInput(p.role, [
    ['bus', '星体'], ['antenna', '天线'], ['shroud', '遮光罩'], ['instrument', '载荷'], ['other', '其他'],
  ], (role) => updateModel((m) => { const x = m.primitives.find((q) => q.id === p.id); if (x) x.role = role as GeometricPrimitive['role']; }))));
  body.append(field('位置 m', vec3Fields(p.position, ['X', 'Y', 'Z'], (position) => updateModel((m) => { const x = m.primitives.find((q) => q.id === p.id); if (x) x.position = position; if (renderer) renderer.setModel(m); }))));
  body.append(field('姿态欧拉角', eulerFields(p.rotation, (rotation) => updateModel((m) => { const x = m.primitives.find((q) => q.id === p.id); if (x) x.rotation = rotation; if (renderer) renderer.setModel(m); }))));

  if (p.kind === 'cylinder') {
    body.append(field('半径 m', numberInput(p.radius, (radius) => updateModel((m) => { const x = m.primitives.find((q) => q.id === p.id); if (x) x.radius = radius; if (renderer) renderer.setModel(m); }), { step: 0.01, min: 0.001 })));
    body.append(field('高度 m（局部 Y 轴）', numberInput(p.height, (height) => updateModel((m) => { const x = m.primitives.find((q) => q.id === p.id); if (x) x.height = height; if (renderer) renderer.setModel(m); }), { step: 0.01, min: 0.001 })));
  } else {
    body.append(field('尺寸 X/Y/Z m', vec3Fields(p.size, ['X', 'Y', 'Z'], (size) => updateModel((m) => { const x = m.primitives.find((q) => q.id === p.id); if (x) x.size = size; if (renderer) renderer.setModel(m); }))));
  }
  body.append(field('反射率', numberInput(p.reflectivity, (reflectivity) => updateModel((m) => { const x = m.primitives.find((q) => q.id === p.id); if (x) x.reflectivity = reflectivity; }), { step: 0.02, min: 0, max: 1 })));
  body.append(field('颜色', h('input', { type: 'color', class: 'color-input', value: p.color, onInput: (e: Event) => {
    const color = (e.target as HTMLInputElement).value;
    updateModel((m) => { const x = m.primitives.find((q) => q.id === p.id); if (x) x.color = color; if (renderer) renderer.setModel(m); });
  } }) as HTMLInputElement));
  body.append(field('参与阴影投射', checkboxInput(p.castsShadow, (castsShadow) => updateModel((m) => { const x = m.primitives.find((q) => q.id === p.id); if (x) x.castsShadow = castsShadow; if (renderer) renderer.setModel(m); }))));
  details.append(body);
  return details;
}

function wingEditor(w: SolarWing, repaint: () => void): HTMLElement {
  const details = h('details', { class: 'editor-item wing', open: true });
  details.append(h('summary', {}, h('strong', {}, w.name), h('span', { class: 'tag' }, `${w.cols}×${w.rows}`), h('span', { class: 'spacer' }),
    button('删除翼', () => {
      updateModel((m) => { m.wings = m.wings.filter((x) => x.id !== w.id); });
      repaint();
    }, { variant: 'danger' })));
  const grid = h('div', { class: 'editor-grid' });
  const bindNum = (label: string, key: keyof SolarWing, step = 1, min?: number) => field(label, numberInput(w[key] as number, (v) => {
    updateModel((m) => { const x = m.wings.find((q) => q.id === w.id); if (x) (x as unknown as Record<string, number>)[key] = v; if (renderer) renderer.setModel(m); });
  }, { step, min }));
  grid.append(field('名称', textInput(w.name, (v) => updateModel((m) => { const x = m.wings.find((q) => q.id === w.id); if (x) x.name = v; }))));
  grid.append(field('铰链位置 m', vec3Fields(w.position, ['X', 'Y', 'Z'], (position) => updateModel((m) => { const x = m.wings.find((q) => q.id === w.id); if (x) x.position = position; if (renderer) renderer.setModel(m); }))));
  grid.append(field('铰链轴', vec3Fields(w.hingeAxis, ['X', 'Y', 'Z'], (hingeAxis) => updateModel((m) => { const x = m.wings.find((q) => q.id === w.id); if (x) x.hingeAxis = hingeAxis; if (renderer) renderer.setModel(m); }))));
  grid.append(bindNum('铰链展开角°', 'deploymentAngleDeg', 1));
  grid.append(bindNum('驱动机构转角°', 'driveAngleDeg', 1));
  grid.append(bindNum('列数（跨向）', 'cols', 1, 1));
  grid.append(bindNum('行数（弦向）', 'rows', 1, 1));
  grid.append(bindNum('电池片长 m', 'cellLengthM', 0.005, 0.01));
  grid.append(bindNum('电池片宽 m', 'cellWidthM', 0.005, 0.01));
  grid.append(bindNum('X 间隙 m', 'gapXM', 0.002, 0));
  grid.append(bindNum('Y 间隙 m', 'gapYM', 0.002, 0));
  grid.append(bindNum('边距 m', 'edgeMarginM', 0.005, 0));
  grid.append(bindNum('单片效率', 'cellEfficiency', 0.005, 0.05));
  grid.append(bindNum('Vmp V', 'cellVmpV', 0.01, 0.1));
  grid.append(bindNum('每串片数（0=整列/行）', 'cellsPerString', 1, 0));
  grid.append(bindNum('每只旁路二极管跨片数', 'bypassGroupSize', 1, 1));
  grid.append(bindNum('旁路二极管压降 V', 'bypassDiodeVoltageV', 0.01, 0));
  grid.append(field('串联方向', selectInput(w.stringDirection, [['column', '按列串联'], ['row', '按行串联']], (stringDirection) => updateModel((m) => { const x = m.wings.find((q) => q.id === w.id); if (x) x.stringDirection = stringDirection; repaint(); }))));
  grid.append(field('启用旁路二极管', checkboxInput(w.bypassEnabled, (bypassEnabled) => updateModel((m) => { const x = m.wings.find((q) => q.id === w.id); if (x) x.bypassEnabled = bypassEnabled; }))));
  grid.append(field('每串独立 MPPT', checkboxInput(w.mpptPerString, (mpptPerString) => updateModel((m) => { const x = m.wings.find((q) => q.id === w.id); if (x) x.mpptPerString = mpptPerString; }))));
  details.append(grid);
  return details;
}

export function renderConfigPage(root: HTMLElement): () => void {
  let cancelled = false;
  let paintGeneration = 0;

  const paint = () => {
    if (cancelled) return;
    const generation = ++paintGeneration;
    renderer?.dispose();
    renderer = null;
    root.replaceChildren();
    const plan = store.state.plan;
    const m = plan.model;

    const head = h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, '卫星构型'),
        h('p', { class: 'page-desc' }, '用长方体、圆柱和平板搭建星体、天线与遮光罩；太阳翼按铰链展开角和驱动机构转角参数化，逐片生成电池片与串/旁路分组。'),
      ),
      h('div', { class: 'head-actions' },
        button('载入 500 kg 级', () => { store.updatePlan((p) => { p.model = createSatellite500(); }); paint(); store.toast('已载入 500 kg 级测试构型', 'success'); }, { variant: 'primary' }),
        button('载入 50 kg 级', () => { store.updatePlan((p) => { p.model = createSatellite50(); p.settings.nominalLoadW = 120; }); paint(); store.toast('已载入 50 kg 级测试构型', 'success'); }, { variant: 'primary' }),
        button('导出电池片位置 CSV', () => { downloadText(`${m.id}_cell_positions.csv`, cellPositionsCSV(m)); store.toast('已导出每片电池片本体坐标', 'success'); }, { variant: 'success', icon: '⬇' }),
      ),
    );
    root.append(head);

    const layout = h('div', { class: 'config-layout' });
    const left = h('div', { class: 'config-forms' });

    const info = card('构型信息',
      h('div', { class: 'form-grid-3' },
        field('构型名称', textInput(m.name, (name) => updateModel((x) => { x.name = name; }))),
        field('质量等级 kg', numberInput(m.massClassKg, (massClassKg) => updateModel((x) => { x.massClassKg = massClassKg; }), { min: 1 })),
        field('构型编号', textInput(m.id, () => {}, { placeholder: 'id' })),
      ),
      field('说明', textInput(m.description, (description) => updateModel((x) => { x.description = description; }))),
    );
    left.append(info);

    const primCard = card(`几何组件（${m.primitives.length}）`,
      h('div', { class: 'button-row' },
        button('加长方体', () => addPrimitive('box')),
        button('加平板', () => addPrimitive('plate')),
        button('加圆柱', () => addPrimitive('cylinder')),
      ),
      h('div', { class: 'editor-list' }, ...m.primitives.map((p) => primitiveEditor(p, paint))),
    );
    left.append(primCard);

    const wingCard = card(`太阳翼与电池串（${m.wings.length}）`,
      h('div', { class: 'button-row' }, button('新增太阳翼', addWing, { variant: 'primary' })),
      h('div', { class: 'editor-list' }, ...m.wings.map((w) => wingEditor(w, paint))),
    );
    left.append(wingCard);

    const right = h('div', { class: 'config-preview-col' });
    const previewCard = card('构型三维预览', h('canvas', { id: 'config-canvas', class: 'viewer canvas-lg' }), h('div', { class: 'viewer-hint' }, '拖拽旋转 · 滚轮缩放 · 双击复位'));
    right.append(previewCard);
    const count = m.wings.reduce((s, w) => s + w.cols * w.rows, 0);
    right.append(card('导出与检查',
      h('div', { class: 'kpi-line' }, h('span', {}, '电池片总数'), h('strong', {}, String(count))),
      h('div', { class: 'kpi-line' }, h('span', {}, '几何遮挡体'), h('strong', {}, String(m.primitives.filter((p) => p.castsShadow).length + m.wings.length))),
      h('p', { class: 'hint' }, '导出的 CSV 包含每片电池片中心、法向、串号和旁路二极管组号，可用于总装坐标核对。'),
      button('再次导出位置 CSV', () => downloadText(`${m.id}_cell_positions.csv`, cellPositionsCSV(m)), { variant: 'success' }),
    ));

    layout.append(left, right);
    root.append(layout);

    const canvas = root.querySelector('#config-canvas') as HTMLCanvasElement | null;
    if (canvas) {
      void mountRenderer(canvas, m).then((r) => {
        if (cancelled || generation !== paintGeneration) { r?.dispose(); return; }
        renderer = r;
        if (!r) {
          const parent = canvas.parentElement;
          if (parent) parent.append(h('div', { class: 'webgpu-fallback' }, '当前浏览器未提供 WebGPU，构型参数仍可编辑；受照推演将使用 CPU 兼容引擎。建议使用最新版 Chrome/Edge。'));
        }
      });
    }
  };

  function addPrimitive(kind: PrimitiveKind): void {
    const isCylinder = kind === 'cylinder';
    const isPlate = kind === 'plate';
    const p: GeometricPrimitive = {
      id: uid('prim'), name: isCylinder ? '新圆柱' : isPlate ? '新平板' : '新长方体', kind, role: 'other',
      position: [0, 0, 1], rotation: { yaw: 0, pitch: 0, roll: 0 },
      size: isCylinder ? [0.1, 0.1, 0.6] : isPlate ? [0.7, 0.5, 0.035] : [0.5, 0.5, 0.5],
      radius: 0.15, height: 0.6, color: '#94a3b8', reflectivity: 0.35, castsShadow: true,
    };
    updateModel((m) => m.primitives.push(p));
    paint();
  }

  function addWing(): void {
    const w: SolarWing = {
      id: uid('wing'), name: '新太阳翼', position: [0, 0.6, 0], hingeAxis: [0, 0, 1],
      deploymentAngleDeg: 90, driveAngleDeg: 0, cols: 6, rows: 10,
      cellLengthM: 0.12, cellWidthM: 0.1, gapXM: 0.01, gapYM: 0.01, edgeMarginM: 0.035,
      cellEfficiency: 0.3, cellVmpV: 2.35, cellVocV: 2.7, cellsPerString: 10,
      bypassGroupSize: 5, bypassDiodeVoltageV: 0.35, bypassEnabled: true,
      stringDirection: 'column', mpptPerString: true, substrateColor: '#334155', cellColor: '#1d4ed8',
    };
    updateModel((m) => m.wings.push(w));
    paint();
  }

  paint();
  return () => { cancelled = true; renderer?.dispose(); renderer = null; };
}
