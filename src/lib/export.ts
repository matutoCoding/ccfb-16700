import type { ScenarioCase, SimResult } from '../types';
import { buildGeometry } from './geometry';
import { formatClock } from './format';

export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob(['﻿' + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function powerCurveCsv(_scenario: ScenarioCase, result: SimResult): string {
  const head = ['time_sec', 'time_hh:mm:ss', 'solar_power_W', 'bus_load_W', 'payload_load_W', 'net_power_W', 'in_eclipse', 'sun_beta_deg'];
  const rows = result.power.map((p, i) => [
    p.tSec.toFixed(1),
    formatClock(p.tSec),
    p.solarW.toFixed(3),
    p.busLoadW.toFixed(1),
    p.payloadLoadW.toFixed(1),
    p.netW.toFixed(3),
    result.environments[i].inEarthShadow ? 1 : 0,
    result.environments[i].betaAngleDeg.toFixed(3)
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

export function cellInsolationCsv(scenario: ScenarioCase, result: SimResult): string {
  const geometry = buildGeometry(scenario.geometry);
  const head = [
    'time_sec', 'time_utc', 'cell_id', 'array_id', 'string_id', 'row', 'col',
    'lit_fraction', 'direct_Wm2', 'earth_albedo_Wm2', 'multi_bounce_Wm2', 'total_Wm2',
    'center_x_m', 'center_y_m', 'center_z_m', 'normal_x', 'normal_y', 'normal_z'
  ];
  const rows: string[] = [head.join(',')];
  const epoch = new Date(scenario.orbit.epochISO).getTime();
  result.irradiance.forEach((stepSamples, s) => {
    const t = result.environments[s].tSec;
    const utc = new Date(epoch + t * 1000).toISOString();
    stepSamples.forEach((sample, c) => {
      const cell = geometry.cells[c];
      rows.push([
        t.toFixed(0), utc, cell.cellId, cell.arrayId, cell.stringId, cell.row + 1, cell.col + 1,
        sample.litFraction.toFixed(4), sample.directWm2.toFixed(2), sample.albedoWm2.toFixed(2),
        sample.bounceWm2.toFixed(2), sample.totalWm2.toFixed(2),
        cell.centerBody[0].toFixed(4), cell.centerBody[1].toFixed(4), cell.centerBody[2].toFixed(4),
        cell.normalBody[0].toFixed(5), cell.normalBody[1].toFixed(5), cell.normalBody[2].toFixed(5)
      ].map(csvCell).join(','));
    });
  });
  return rows.join('\n');
}

export function cellPositionsCsv(scenario: ScenarioCase): string {
  const { cells } = buildGeometry(scenario.geometry);
  const head = ['cell_id', 'array_id', 'string_id', 'row', 'col', 'x_m', 'y_m', 'z_m', 'nx', 'ny', 'nz', 'width_m', 'height_m', 'area_m2'];
  const rows = cells.map((c) => [
    c.cellId, c.arrayId, c.stringId, c.row + 1, c.col + 1,
    c.centerBody[0].toFixed(5), c.centerBody[1].toFixed(5), c.centerBody[2].toFixed(5),
    c.normalBody[0].toFixed(6), c.normalBody[1].toFixed(6), c.normalBody[2].toFixed(6),
    c.width, c.height, c.areaM2.toFixed(5)
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

export function scenarioMarkdown(scenario: ScenarioCase, result?: SimResult): string {
  const g = scenario.geometry;
  const lines: string[] = [];
  lines.push(`# 工况说明：${scenario.name}`);
  lines.push('');
  lines.push(`- 工况编号：${scenario.id}`);
  lines.push(`- 说明：${scenario.description}`);
  lines.push(`- 质量等级：${g.massKg} kg`);
  lines.push(`- 平台/载荷功耗：${g.busPowerW} W / ${g.payloadPowerW} W`);
  lines.push(`- 历元：${scenario.orbit.epochISO}`);
  lines.push('');
  lines.push('## 轨道六根数');
  lines.push(`- a = ${scenario.orbit.aKm.toFixed(3)} km`);
  lines.push(`- e = ${scenario.orbit.eccentricity}`);
  lines.push(`- i = ${scenario.orbit.inclinationDeg.toFixed(3)}°`);
  lines.push(`- RAAN = ${scenario.orbit.raanDeg.toFixed(2)}°`);
  lines.push(`- ω = ${scenario.orbit.argPerigeeDeg.toFixed(2)}°`);
  lines.push(`- M0 = ${scenario.orbit.meanAnomalyDeg.toFixed(2)}°`);
  lines.push('');
  lines.push('## 姿态与机动');
  lines.push(`- 稳定模式：${({ nadir: '对地定向', sun: '对日定向', inertial: '惯性定向' } as const)[scenario.attitude.mode]}`);
  lines.push(`- 固定偏置 XYZ：${scenario.attitude.offsetDeg.join(', ')}°`);
  for (const m of scenario.attitude.maneuvers) {
    lines.push(`- ${m.kind === 'yaw' ? '偏航' : m.kind === 'roll' ? '滚动' : '四元数'}机动：${formatClock(m.startSec)} 开始，${m.durationSec} s，${m.angleDeg}°`);
  }
  lines.push('');
  lines.push('## 太阳翼与电池串');
  for (const a of g.arrays) {
    lines.push(`### ${a.name}`);
    lines.push(`- 根节点：(${a.rootPosition.join(', ')}) m；铰链轴 ${a.hingeAxis.join(',')}，展开角 ${a.hingeAngleDeg}°`);
    lines.push(`- 驱动机构：局部轴 ${a.driveAxisLocal.join(',')}，转角 ${a.driveAngleDeg}°`);
    lines.push(`- 电池片：${a.layout.rows} × ${a.layout.cols} = ${a.layout.rows * a.layout.cols}；片尺寸 ${a.layout.cellWidth} × ${a.layout.cellHeight} m`);
    for (const s of a.strings) lines.push(`- ${s.name}：${s.cellCount} 片，每 ${s.bypassGroupSize} 片一个旁路二极管`);
  }
  lines.push('');
  lines.push('## 推演设置');
  lines.push(`- 时间步长：${scenario.simulation.stepSec} s；每片采样：${scenario.simulation.samplesPerCellAxis ** 2} 点`);
  lines.push(`- 地球反照系数：${scenario.simulation.earthAlbedo}；多阶反射系数：${scenario.simulation.bounceCoefficient}`);
  if (result) {
    lines.push('');
    lines.push('## 结果摘要');
    lines.push(`- 后端：${result.backend}；步数：${result.steps}；电池片：${result.cells}`);
    lines.push(`- 计算耗时：${result.elapsedMs.toFixed(0)} ms`);
    lines.push(`- 最小发电功率：${result.minPower.powerW.toFixed(1)} W @ ${formatClock(result.minPower.tSec)}`);
    lines.push(`- 最大发电功率：${result.maxPower.powerW.toFixed(1)} W @ ${formatClock(result.maxPower.tSec)}`);
    lines.push(`- 地影区间：${result.eclipseIntervals.map((i) => `${formatClock(i.startSec)}–${formatClock(i.endSec)}`).join('；') || '本轨未检测到地影'}`);
  }
  lines.push('');
  lines.push('## 验收口径');
  lines.push('无遮挡、关闭反照/多阶反射且电池片法向与太阳夹角为 θ 时，线性 MPP 电流源模型给出 P(θ)=N·Iref·Vmp·cosθ。');
  if (result?.validation) lines.push(`余弦自检最大误差：${result.validation.maxRelativeErrorPct.toFixed(6)}%（${result.validation.passed ? '通过' : '未通过'}，阈值 0.5%）。`);
  return lines.join('\n');
}
