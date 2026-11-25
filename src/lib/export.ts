import type { SatelliteModel, SimulationResult, WorkspacePlan } from '../types';
import { prepareGeometry } from './geometry';

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(headers: string[], rows: Array<Array<unknown>>): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob(['﻿', text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function cellPositionsCSV(model: SatelliteModel): string {
  const prepared = prepareGeometry(model);
  return toCSV(
    ['cell_id', 'wing', 'col', 'row', 'string_id', 'bypass_group', 'center_x_m', 'center_y_m', 'center_z_m', 'normal_x', 'normal_y', 'normal_z', 'area_m2', 'rated_power_w'],
    prepared.cells.map((c) => [
      c.cellId, c.wingName, c.col, c.row, c.stringId, c.bypassGroupId,
      c.centerBody[0].toFixed(6), c.centerBody[1].toFixed(6), c.centerBody[2].toFixed(6),
      c.normalBody[0].toFixed(6), c.normalBody[1].toFixed(6), c.normalBody[2].toFixed(6),
      c.areaM2.toFixed(6), c.ratedPowerW.toFixed(4),
    ]),
  );
}

export function powerCurveCSV(result: SimulationResult): string {
  return toCSV(
    ['elapsed_sec', 'datetime_utc', 'sunlight_factor_1_full_sun_0_umbra', 'in_eclipse', 'sun_body_angle_deg', 'direct_power_w', 'albedo_power_w', 'bounce_power_w', 'total_power_w', 'nominal_load_w', 'power_margin_w'],
    result.epochs.map((e) => [
      e.tSec.toFixed(0), e.dateISO, e.eclipseFactor.toFixed(4), e.inEclipse ? 1 : 0,
      e.sunAngleDeg.toFixed(3), e.directPowerW.toFixed(3), e.albedoPowerW.toFixed(3),
      e.bouncePowerW.toFixed(3), e.totalPowerW.toFixed(3), '', '',
    ]),
  );
}

export function powerCurveCSVWithLoad(result: SimulationResult, loadW: number): string {
  return toCSV(
    ['elapsed_sec', 'datetime_utc', 'sunlight_factor_1_full_sun_0_umbra', 'in_eclipse', 'sun_body_angle_deg', 'direct_power_w', 'albedo_power_w', 'bounce_power_w', 'total_power_w', 'nominal_load_w', 'power_margin_w'],
    result.epochs.map((e) => [
      e.tSec.toFixed(0), e.dateISO, e.eclipseFactor.toFixed(4), e.inEclipse ? 1 : 0,
      e.sunAngleDeg.toFixed(3), e.directPowerW.toFixed(3), e.albedoPowerW.toFixed(3),
      e.bouncePowerW.toFixed(3), e.totalPowerW.toFixed(3), loadW.toFixed(1),
      (e.totalPowerW - loadW).toFixed(3),
    ]),
  );
}

export function cellIlluminationScheduleCSV(result: SimulationResult): string {
  const rows: Array<Array<unknown>> = [];
  result.epochs.forEach((epoch) => {
    epoch.cellIllumination.forEach((c, i) => {
      // Cell metadata is stable and repeated by cell index.
      rows.push([
        epoch.tSec.toFixed(0), epoch.dateISO, i,
        c.litFraction.toFixed(4), c.cosine.toFixed(5),
        c.directWm2.toFixed(3), c.albedoWm2.toFixed(3), c.bounceWm2.toFixed(3), c.totalWm2.toFixed(3),
      ]);
    });
  });
  return toCSV(
    ['elapsed_sec', 'datetime_utc', 'cell_index', 'lit_fraction', 'cosine_incidence', 'direct_wm2', 'earth_albedo_wm2', 'bounce_wm2', 'total_wm2'],
    rows,
  );
}

export function cellIlluminationScheduleWithMetaCSV(plan: WorkspacePlan, result: SimulationResult): string {
  const prepared = prepareGeometry(plan.model);
  const meta = new Map(prepared.cells.map((c) => [c.index, c]));
  const rows: Array<Array<unknown>> = [];
  result.epochs.forEach((epoch) => {
    epoch.cellIllumination.forEach((ill, i) => {
      const c = meta.get(i);
      rows.push([
        epoch.tSec.toFixed(0), epoch.dateISO, c?.cellId ?? i, c?.wingName ?? '', c?.stringId ?? '',
        c?.bypassGroupId ?? '', ill.litFraction.toFixed(4), ill.cosine.toFixed(5),
        ill.directWm2.toFixed(3), ill.albedoWm2.toFixed(3), ill.bounceWm2.toFixed(3), ill.totalWm2.toFixed(3),
      ]);
    });
  });
  return toCSV(
    ['elapsed_sec', 'datetime_utc', 'cell_id', 'wing', 'string_id', 'bypass_group', 'lit_fraction', 'cosine_incidence', 'direct_wm2', 'earth_albedo_wm2', 'bounce_wm2', 'total_wm2'],
    rows,
  );
}

export function scenarioMarkdown(plan: WorkspacePlan, result?: SimulationResult): string {
  const m = plan.model;
  const o = plan.orbit;
  const a = plan.attitude;
  const lines = [
    `# 卫星帆板受照与发电推演工况说明`,
    ``,
    `## 1. 工况标识`,
    `- 方案名称：${plan.name}`,
    `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
    `- 推演起始时刻：${plan.dateISO}`,
    `- 时间步长：${plan.settings.stepSec} s`,
    ``,
    `## 2. 卫星构型`,
    `- 构型名称：${m.name}`,
    `- 质量等级：${m.massClassKg} kg 级`,
    `- 几何组件：${m.primitives.length} 个（星体/天线/遮光罩等）`,
    `- 太阳翼：${m.wings.length} 片`,
    ...m.wings.map((w) => `  - ${w.name}：${w.cols}×${w.rows} 片，展开角 ${w.deploymentAngleDeg}°，驱动角 ${w.driveAngleDeg}°，旁路二极管每 ${w.bypassGroupSize} 片一只`),
    ``,
    `## 3. 轨道`,
    `- 半长轴：${o.semiMajorAxisKm} km`,
    `- 偏心率：${o.eccentricity}`,
    `- 倾角：${o.inclinationDeg}°`,
    `- RAAN：${o.raanDeg}°`,
    `- 近地点幅角：${o.argPerigeeDeg}°`,
    `- 初始平近点角：${o.meanAnomaly0Deg}°`,
    ``,
    `## 4. 姿态与机动`,
    `- 主模式：${a.mode === 'nadir' ? '对地定向' : a.mode === 'sun' ? '对日定向' : '惯性定向'}`,
    `- 惯性姿态：yaw ${a.inertialEuler.yaw}°, pitch ${a.inertialEuler.pitch}°, roll ${a.inertialEuler.roll}°`,
    ...a.maneuvers.map((x) => `  - ${x.name}：${x.axis} ${x.angleDeg}°，${x.startSec}s 开始，进入 ${x.enterDurationSec}s / 保持 ${x.holdDurationSec}s / 退出 ${x.exitDurationSec}s`),
    ``,
    `## 5. 物理模型`,
    `- 太阳常数：${plan.settings.solarConstantWm2} W/m²`,
    `- 地球反照经验系数：${plan.settings.earthAlbedo}`,
    `- 阴影采样：每片电池片 ${plan.settings.shadowSamplesPerAxis}×${plan.settings.shadowSamplesPerAxis} 点`,
    `- 多次反照：${plan.settings.multiBounceEnabled ? `${plan.settings.bounceCount} 次弹射，${plan.settings.bounceRaysPerCell} 条/片` : '关闭'}`,
    `- 电学模型：串联电池片电流瓶颈 + 旁路二极管分组；MPPT 按串求和。`,
    ``,
  ];
  if (result) {
    lines.push(
      `## 6. 推演结果摘要`,
      `- 计算引擎：${result.engine}`,
      `- 历元数：${result.epochCount}；电池片数：${result.cellCount}`,
      `- 页面推演耗时：${result.elapsedMs.toFixed(0)} ms`,
      `- 轨道周期：${(result.orbitPeriodSec / 60).toFixed(1)} min`,
      `- 全轨最小功率：${result.minTotal.powerW.toFixed(1)} W @ ${result.minTotal.tSec.toFixed(0)} s`,
      result.minSunlit ? `- 光照区最小功率：${result.minSunlit.powerW.toFixed(1)} W @ ${result.minSunlit.tSec.toFixed(0)} s` : `- 光照区最小功率：无`,
      `- 全轨发电量：${result.energyWh.toFixed(1)} Wh`,
      `- 余弦定律自检最大误差：${result.cosineCheck.maxErrorPct.toFixed(4)}%（${result.cosineCheck.passed ? '通过 <0.5%' : '未通过'}）`,
      ``,
    );
  }
  lines.push(`> 注：该工具用于方案阶段典型工况快速评估，不能替代热控、电源和总装专业的详细仿真。`);
  return lines.join('\n');
}
