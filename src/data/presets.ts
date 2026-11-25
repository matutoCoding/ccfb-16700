import type { ScenarioCase, Settings, SolarArrayConfig, StringSpec } from '../types';
import { ssoInclinationDeg } from '../lib/orbit';
import { uid } from '../lib/math';

function strings(prefix: string, count: number, eachCount: number, bypass: number): StringSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-STR${i + 1}`,
    name: `串 ${i + 1}`,
    cellCount: eachCount,
    bypassGroupSize: bypass
  }));
}

function makeLargeArray(side: -1 | 1): SolarArrayConfig {
  const cols = 16;
  const rows = 12;
  return {
    id: side < 0 ? 'array-left' : 'array-right',
    name: side < 0 ? '左太阳翼' : '右太阳翼',
    rootPosition: [side * 1.35, 0, 0],
    hingeAxis: [0, 1, 0],
    hingeAngleDeg: side * 90,
    driveAngleDeg: 0,
    driveAxisLocal: [0, 1, 0],
    panelThickness: 0.05,
    reflectivity: 0.22,
    layout: {
      rows,
      cols,
      cellWidth: 0.18,
      cellHeight: 0.12,
      gapX: 0.012,
      gapY: 0.01,
      axisU: [1, 0, 0],
      axisV: [0, 1, 0],
      normal: [0, 0, 1],
      centerOffset: [0, 0, 0]
    },
    strings: strings(side < 0 ? 'L' : 'R', 4, 48, 12)
  };
}

function makeSmallArray(side: -1 | 1): SolarArrayConfig {
  const cols = 10;
  const rows = 6;
  return {
    id: side < 0 ? 'array-l' : 'array-r',
    name: side < 0 ? '左太阳翼' : '右太阳翼',
    rootPosition: [side * 0.43, 0, 0],
    hingeAxis: [0, 1, 0],
    hingeAngleDeg: side * 90,
    driveAngleDeg: 0,
    driveAxisLocal: [0, 1, 0],
    panelThickness: 0.025,
    reflectivity: 0.25,
    layout: {
      rows,
      cols,
      cellWidth: 0.155,
      cellHeight: 0.115,
      gapX: 0.01,
      gapY: 0.008,
      axisU: [1, 0, 0],
      axisV: [0, 1, 0],
      normal: [0, 0, 1],
      centerOffset: [0, 0, 0]
    },
    strings: strings(side < 0 ? 'SL' : 'SR', 2, 30, 10)
  };
}

export function createLargeSatelliteCase(): ScenarioCase {
  const now = Date.now();
  const aKm = 6378.137 + 545;
  return {
    id: 'case-500kg',
    name: 'FY-500 公斤级平台（投影遮挡考核）',
    description: '长方体平台、抛物面天线、相机遮光罩与双太阳翼；四串/翼，每 12 片一个旁路二极管。',
    builtIn: true,
    createdAt: now,
    updatedAt: now,
    geometry: {
      name: 'FY-500',
      massKg: 500,
      busPowerW: 650,
      payloadPowerW: 1400,
      primitives: [
        {
          id: 'bus',
          name: '平台星体',
          kind: 'box',
          role: 'bus',
          position: [0, 0, 0],
          rotationDeg: [0, 0, 0],
          dimensions: [2.2, 1.8, 2.0],
          reflectivity: 0.35,
          occluder: true
        },
        {
          id: 'antenna-dish',
          name: '数传天线',
          kind: 'cylinder',
          role: 'antenna',
          position: [-0.35, 0.1, 1.22],
          rotationDeg: [90, 0, 0],
          dimensions: [0.68, 0.16, 0],
          reflectivity: 0.55,
          occluder: true
        },
        {
          id: 'antenna-mast',
          name: '天线支架',
          kind: 'cylinder',
          role: 'antenna',
          position: [-0.35, 0.1, 1.02],
          rotationDeg: [0, 0, 0],
          dimensions: [0.055, 0.55, 0],
          reflectivity: 0.4,
          occluder: true
        },
        {
          id: 'camera-baffle',
          name: '相机遮光罩',
          kind: 'cylinder',
          role: 'shield',
          position: [0.55, -0.15, 1.35],
          rotationDeg: [90, 0, 0],
          dimensions: [0.34, 0.9, 0],
          reflectivity: 0.12,
          occluder: true
        },
        {
          id: 'camera-box',
          name: '相机载荷',
          kind: 'box',
          role: 'other',
          position: [0.55, -0.15, 0.92],
          rotationDeg: [0, 0, 0],
          dimensions: [0.62, 0.55, 0.55],
          reflectivity: 0.22,
          occluder: true
        }
      ],
      arrays: [makeLargeArray(-1), makeLargeArray(1)]
    },
    orbit: {
      aKm,
      eccentricity: 0.0012,
      inclinationDeg: ssoInclinationDeg(aKm),
      raanDeg: 93,
      argPerigeeDeg: 90,
      meanAnomalyDeg: 0,
      epochISO: '2026-06-21T02:00:00.000Z'
    },
    attitude: {
      mode: 'nadir',
      inertialQuat: [0, 0, 0, 1],
      offsetDeg: [0, 0, 0],
      maneuvers: [
        { id: uid('man'), kind: 'yaw', startSec: 1500, durationSec: 180, angleDeg: 25 },
        { id: uid('man'), kind: 'roll', startSec: 3300, durationSec: 150, angleDeg: -18 }
      ]
    },
    electrical: {
      referenceIrradiance: 1361,
      referenceCurrentA: 11.4,
      mppCellVoltageV: 0.62,
      bypassDiodeDropV: 0.32,
      temperatureCoefficient: -0.004
    },
    simulation: {
      stepSec: 10,
      samplesPerCellAxis: 2,
      earthAlbedo: 0.3,
      bounceCoefficient: 0.14,
      enableEarthAlbedo: true,
      enableMultiBounce: true,
      enableSelfShadow: true
    }
  };
}

export function createSmallSatelliteCase(): ScenarioCase {
  const now = Date.now();
  const aKm = 6378.137 + 420;
  const base = createLargeSatelliteCase();
  return {
    ...base,
    id: 'case-50kg',
    name: 'NX-50 公斤级微纳卫星（机动敏捷考核）',
    description: '小型长方体星体、柱状天线与遮光罩、双折叠太阳翼；两串/翼，每 10 片一个旁路二极管。',
    createdAt: now,
    updatedAt: now,
    geometry: {
      name: 'NX-50',
      massKg: 50,
      busPowerW: 45,
      payloadPowerW: 110,
      primitives: [
        {
          id: 'small-bus',
          name: '微纳星体',
          kind: 'box',
          role: 'bus',
          position: [0, 0, 0],
          rotationDeg: [0, 0, 0],
          dimensions: [0.62, 0.62, 0.72],
          reflectivity: 0.32,
          occluder: true
        },
        {
          id: 'small-antenna',
          name: '全向天线',
          kind: 'cylinder',
          role: 'antenna',
          position: [-0.16, 0.05, 0.48],
          rotationDeg: [0, 0, 0],
          dimensions: [0.035, 0.42, 0],
          reflectivity: 0.5,
          occluder: true
        },
        {
          id: 'small-baffle',
          name: '星敏/相机遮光罩',
          kind: 'cylinder',
          role: 'shield',
          position: [0.18, -0.08, 0.48],
          rotationDeg: [90, 0, 0],
          dimensions: [0.13, 0.34, 0],
          reflectivity: 0.1,
          occluder: true
        }
      ],
      arrays: [makeSmallArray(-1), makeSmallArray(1)]
    },
    orbit: {
      aKm,
      eccentricity: 0.0008,
      inclinationDeg: 51.6,
      raanDeg: 120,
      argPerigeeDeg: 0,
      meanAnomalyDeg: 0,
      epochISO: '2026-06-21T02:00:00.000Z'
    },
    attitude: {
      mode: 'nadir',
      inertialQuat: [0, 0, 0, 1],
      offsetDeg: [0, 0, 0],
      maneuvers: [
        { id: uid('man'), kind: 'roll', startSec: 2100, durationSec: 90, angleDeg: 35 }
      ]
    },
    electrical: {
      referenceIrradiance: 1361,
      referenceCurrentA: 7.8,
      mppCellVoltageV: 0.56,
      bypassDiodeDropV: 0.28,
      temperatureCoefficient: -0.004
    },
    simulation: {
      stepSec: 10,
      samplesPerCellAxis: 2,
      earthAlbedo: 0.32,
      bounceCoefficient: 0.1,
      enableEarthAlbedo: true,
      enableMultiBounce: true,
      enableSelfShadow: true
    }
  };
}

export const defaultSettings: Settings = {
  preferredBackend: 'auto',
  benchmarkSteps: 560,
  unsafeCpuFallback: true
};
