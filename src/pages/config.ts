import type { PageHandle } from './types';
import type { Primitive, ScenarioCase, SolarArrayConfig } from '../types';
import { store } from '../state';
import { bindRoot, el, field, numInput, selectInput, textInput, toast, vec3Inputs } from '../components/ui';
import { setPath } from '../components/ui';
import { validateCellCounts } from '../lib/geometry';
import { cellPositionsCsv, downloadText } from '../lib/export';
import { uid } from '../lib/math';

export function renderConfigPage(): PageHandle {
  const draft: ScenarioCase = structuredClone(store.current());
  const root = el<HTMLElement>('<section class="page"></section>');

  function paint() {
    const errors = validateCellCounts(draft.geometry);
    root.innerHTML = `
      <header class="page-header">
        <div><h1>卫星构型</h1><p>长方体、圆柱和平板组合星体/天线/遮光罩；太阳翼由铰链展开角与驱动机构转角定位，电池片位置可逐片导出。</p></div>
        <div class="actions">
          <button class="btn" data-action="export-cells">导出电池片位置 CSV</button>
          <button class="btn" data-action="duplicate">另存为新工况</button>
          <span class="save-state" data-role="save-state">已保存到 IndexedDB</span>
        </div>
      </header>
      ${errors.length ? `<div class="banner error"><b>拓扑校验：</b>${errors.join('；')}</div>` : '<div class="banner success">电池片网格与灯串/旁路分组数量一致。</div>'}
      <div class="grid two">
        <section class="card">
          <h2>工况与总体参数</h2>
          <div class="form-grid">
            ${field('工况名称', textInput('name', draft.name))}
            ${field('质量等级 kg', numInput('geometry.massKg', draft.geometry.massKg, '1'), '两套测试构型：500 kg 级与 50 kg 级')}
            ${field('平台功耗 W', numInput('geometry.busPowerW', draft.geometry.busPowerW, '1'))}
            ${field('载荷功耗 W', numInput('geometry.payloadPowerW', draft.geometry.payloadPowerW, '1'))}
            ${field('工况说明', `<textarea data-bind="description" rows="3">${draft.description}</textarea>`)}
          </div>
        </section>
        <section class="card">
          <div class="card-title"><h2>几何基元</h2><button class="btn small" data-action="add-primitive">＋ 添加基元</button></div>
          <div class="primitive-list">${draft.geometry.primitives.map(primitiveCard).join('')}</div>
        </section>
      </div>
      <section class="card">
        <div class="card-title"><h2>太阳翼、电池片与旁路串</h2><button class="btn small" data-action="add-array">＋ 添加太阳翼</button></div>
        <div class="array-list">${draft.geometry.arrays.map(arrayCard).join('')}</div>
      </section>`;

    root.querySelectorAll<HTMLElement>('[data-primitive-index]').forEach((card) => {
      const i = Number(card.dataset.primitiveIndex);
      card.querySelector('[data-action="remove-primitive"]')?.addEventListener('click', () => {
        draft.geometry.primitives.splice(i, 1);
        void persist(true);
        paint();
      });
    });
    root.querySelectorAll<HTMLElement>('[data-array-index]').forEach((card) => {
      const ai = Number(card.dataset.arrayIndex);
      card.querySelector('[data-action="remove-array"]')?.addEventListener('click', () => {
        draft.geometry.arrays.splice(ai, 1);
        void persist(true);
        paint();
      });
      card.querySelector('[data-action="balance-strings"]')?.addEventListener('click', () => {
        balanceStrings(draft.geometry.arrays[ai]);
        void persist(true);
        paint();
      });
      card.querySelectorAll<HTMLButtonElement>('[data-action="remove-string"]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const si = Number(btn.dataset.stringIndex);
          draft.geometry.arrays[ai].strings.splice(si, 1);
          void persist(true);
          paint();
        });
      });
      card.querySelector('[data-action="add-string"]')?.addEventListener('click', () => {
        draft.geometry.arrays[ai].strings.push({ id: uid('str'), name: `串 ${draft.geometry.arrays[ai].strings.length + 1}`, cellCount: 12, bypassGroupSize: 6 });
        void persist(true);
        paint();
      });
    });

    root.querySelector('[data-action="add-primitive"]')?.addEventListener('click', () => {
      draft.geometry.primitives.push(newPrimitive());
      void persist(true);
      paint();
    });
    root.querySelector('[data-action="add-array"]')?.addEventListener('click', () => {
      draft.geometry.arrays.push(newArray(draft.geometry.arrays.length));
      void persist(true);
      paint();
    });
    root.querySelector('[data-action="export-cells"]')?.addEventListener('click', () => {
      downloadText(`${draft.id}-cell-positions.csv`, cellPositionsCsv(draft));
      toast('已导出每片电池片的本体坐标和法向', 'success');
    });
    root.querySelector('[data-action="duplicate"]')?.addEventListener('click', async () => {
      const copy = structuredClone(draft);
      copy.id = uid('case');
      copy.name = `${draft.name} 副本`;
      copy.builtIn = false;
      await store.updateCase(copy);
      store.currentId = copy.id;
      toast('已另存并切换到新工况', 'success');
      location.hash = '#compare';
    });
  }

  async function persist(immediate = false) {
    const state = root.querySelector<HTMLElement>('[data-role="save-state"]');
    if (state) state.textContent = '保存中…';
    await store.updateCase(draft, { silent: true });
    if (state) state.textContent = immediate ? '已保存到 IndexedDB' : '输入已自动保存';
  }

  const unbind = bindRoot(root, (path, value) => {
    setPath(draft, path, value);
    void persist();
  });

  root.addEventListener('input', () => {
    // bindRoot handles persistence; this hook only avoids unused lifecycle in some browsers.
  });

  paint();
  return {
    el: root,
    destroy: () => {
      unbind();
    }
  };
}

function primitiveCard(p: Primitive, i: number): string {
  const dimLabel = p.kind === 'cylinder' ? '半径 / 长度 / —' : 'X 长 / Y 长 / Z 厚';
  return `
  <div class="subcard" data-primitive-index="${i}">
    <div class="subcard-head">
      <input data-bind="geometry.primitives.${i}.name" value="${p.name}" />
      <button class="btn danger small" data-action="remove-primitive">删除</button>
    </div>
    <div class="form-grid compact">
      ${field('类型', selectInput(`geometry.primitives.${i}.kind`, p.kind, [['box', '长方体'], ['cylinder', '圆柱'], ['plate', '平板']]))}
      ${field('角色', selectInput(`geometry.primitives.${i}.role`, p.role, [['bus', '星体'], ['antenna', '天线'], ['shield', '遮光罩'], ['solar-panel', '太阳翼'], ['mechanism', '机构'], ['other', '其他']]))}
      ${field('位置 m', vec3Inputs(`geometry.primitives.${i}.position`, p.position))}
      ${field('姿态角 ° XYZ', vec3Inputs(`geometry.primitives.${i}.rotationDeg`, p.rotationDeg, '1'))}
      ${field(dimLabel, vec3Inputs(`geometry.primitives.${i}.dimensions`, p.dimensions))}
      ${field('反射率 0–1', numInput(`geometry.primitives.${i}.reflectivity`, p.reflectivity, '0.01', 0))}
      <label class="check-field"><input type="checkbox" data-bind="geometry.primitives.${i}.occluder" ${p.occluder ? 'checked' : ''}/> 参与 GPU 阴影遮挡</label>
    </div>
  </div>`;
}

function arrayCard(a: SolarArrayConfig, ai: number): string {
  return `
  <div class="subcard wide" data-array-index="${ai}">
    <div class="subcard-head">
      <input data-bind="geometry.arrays.${ai}.name" value="${a.name}" />
      <div class="actions">
        <button class="btn small" data-action="balance-strings">按网格检查/保留串定义</button>
        <button class="btn danger small" data-action="remove-array">删除翼</button>
      </div>
    </div>
    <div class="form-grid four">
      ${field('根节点 m', vec3Inputs(`geometry.arrays.${ai}.rootPosition`, a.rootPosition))}
      ${field('铰链轴', vec3Inputs(`geometry.arrays.${ai}.hingeAxis`, a.hingeAxis, '0.1'))}
      ${field('铰链展开角 °', numInput(`geometry.arrays.${ai}.hingeAngleDeg`, a.hingeAngleDeg, '1'))}
      ${field('驱动轴（局部）', vec3Inputs(`geometry.arrays.${ai}.driveAxisLocal`, a.driveAxisLocal, '0.1'))}
      ${field('驱动机构转角 °', numInput(`geometry.arrays.${ai}.driveAngleDeg`, a.driveAngleDeg, '1'))}
      ${field('反射率', numInput(`geometry.arrays.${ai}.reflectivity`, a.reflectivity, '0.01', 0))}
      ${field('行数', numInput(`geometry.arrays.${ai}.layout.rows`, a.layout.rows, '1', 1))}
      ${field('列数', numInput(`geometry.arrays.${ai}.layout.cols`, a.layout.cols, '1', 1))}
      ${field('片宽 m', numInput(`geometry.arrays.${ai}.layout.cellWidth`, a.layout.cellWidth, '0.001', 0.001))}
      ${field('片高 m', numInput(`geometry.arrays.${ai}.layout.cellHeight`, a.layout.cellHeight, '0.001', 0.001))}
      ${field('X 间隙 m', numInput(`geometry.arrays.${ai}.layout.gapX`, a.layout.gapX, '0.001', 0))}
      ${field('Y 间隙 m', numInput(`geometry.arrays.${ai}.layout.gapY`, a.layout.gapY, '0.001', 0))}
    </div>
    <div class="string-list">
      <div class="string-head"><b>电池串 / 旁路二极管分组</b><button class="btn small" data-action="add-string">＋ 添加串</button></div>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>名称</th><th>片数</th><th>旁路组长度</th><th>组数</th><th></th></tr></thead>
        <tbody>
          ${a.strings.map((s, si) => `
            <tr>
              <td><input data-bind="geometry.arrays.${ai}.strings.${si}.name" value="${s.name}"/></td>
              <td><input type="number" min="1" data-bind="geometry.arrays.${ai}.strings.${si}.cellCount" value="${s.cellCount}"/></td>
              <td><input type="number" min="1" data-bind="geometry.arrays.${ai}.strings.${si}.bypassGroupSize" value="${s.bypassGroupSize}"/></td>
              <td>${Math.floor(s.cellCount / s.bypassGroupSize)} 个二极管</td>
              <td><button class="btn danger tiny" data-action="remove-string" data-string-index="${si}">删</button></td>
            </tr>`).join('')}
        </tbody>
      </table></div>
    </div>
  </div>`;
}

function newPrimitive(): Primitive {
  return {
    id: uid('prim'), name: '新基元', kind: 'box', role: 'other',
    position: [0, 0, 0], rotationDeg: [0, 0, 0], dimensions: [0.5, 0.5, 0.5],
    reflectivity: 0.3, occluder: true
  };
}

function newArray(index: number): SolarArrayConfig {
  const side = index % 2 === 0 ? -1 : 1;
  return {
    id: uid('array'), name: `太阳翼 ${index + 1}`, rootPosition: [side, 0, 0],
    hingeAxis: [0, 1, 0], hingeAngleDeg: side * 90, driveAngleDeg: 0, driveAxisLocal: [0, 1, 0],
    panelThickness: 0.04, reflectivity: 0.25,
    layout: {
      rows: 6, cols: 8, cellWidth: 0.16, cellHeight: 0.12, gapX: 0.01, gapY: 0.01,
      axisU: [1, 0, 0], axisV: [0, 1, 0], normal: [0, 0, 1], centerOffset: [0, 0, 0]
    },
    strings: [{ id: uid('str'), name: '串 1', cellCount: 48, bypassGroupSize: 12 }]
  };
}

function balanceStrings(a: SolarArrayConfig) {
  // Intentionally conservative: only normalize IDs/names and leave electrical design editable.
  a.strings.forEach((s, i) => {
    if (!s.id) s.id = uid('str');
    if (!s.name) s.name = `串 ${i + 1}`;
  });
}
