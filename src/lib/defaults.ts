import type {
  AttitudeConfig, CompareCase, OrbitalElements, SatelliteModel, SimulationSettings, WorkspacePlan,
} from '../types';
import { sunSynchronousInclinationDeg } from './orbit';
import { uid } from './math';

export const DEFAULT_SETTINGS: SimulationSettings = {
  stepSec: 10,
  shadowSamplesPerAxis: 4,
  solarConstantWm2: 1361,
  earthAlbedo: 0.3,
  earthRadiusKm: 6378.137,
  multiBounceEnabled: true,
  bounceRaysPerCell: 8,
  bounceCount: 2,
  bodyReflectance: 0.32,
  cellReflectance: 0.08,
  nominalLoadW: 650,
  useGpu: true,
  currentTablePoints: 240,
};

export function defaultOrbit(): OrbitalElements {
  const a = 6978;
  return {
    semiMajorAxisKm: a,
    eccentricity: 0.0012,
    inclinationDeg: Number(sunSynchronousInclinationDeg(a, 0.0012).toFixed(3)),
    raanDeg: 92,
    argPerigeeDeg: 90,
    meanAnomaly0Deg: 0,
    epochISO: '2026-06-21T04:00:00.000Z',
  };
}

export function defaultAttitude(): AttitudeConfig {
  return {
    mode: 'nadir',
    inertialEuler: { yaw: 0, pitch: -18, roll: 0 },
    sunTrackingAxis: 'normal',
    maneuvers: [
      {
        id: 'maneuver_yaw_demo',
        name: '中段偏航成像机动',
        startSec: 1450,
        enterDurationSec: 120,
        holdDurationSec: 420,
        exitDurationSec: 120,
        axis: 'yaw',
        angleDeg: 28,
      },
      {
        id: 'maneuver_roll_demo',
        name: '后段滚动侧摆',
        startSec: 3550,
        enterDurationSec: 90,
        holdDurationSec: 300,
        exitDurationSec: 90,
        axis: 'roll',
        angleDeg: 18,
      },
    ],
  };
}

function wing500(side: 1 | -1) {
  const plus = side === 1;
  return {
    id: plus ? 'wing_500_py' : 'wing_500_my',
    name: plus ? '+Y 左翼' : '-Y 右翼',
    position: [0, plus ? 0.74 : -0.74, 0] as [number, number, number],
    hingeAxis: [0, 0, 1] as [number, number, number],
    deploymentAngleDeg: plus ? 90 : -90,
    driveAngleDeg: plus ? 32 : -32,
    cols: 8,
    rows: 14,
    cellLengthM: 0.18,
    cellWidthM: 0.12,
    gapXM: 0.012,
    gapYM: 0.01,
    edgeMarginM: 0.04,
    cellEfficiency: 0.305,
    cellVmpV: 2.35,
    cellVocV: 2.72,
    cellsPerString: 14,
    bypassGroupSize: 7,
    bypassDiodeVoltageV: 0.35,
    bypassEnabled: true,
    stringDirection: 'column' as const,
    mpptPerString: true,
    substrateColor: '#334155',
    cellColor: '#1d4ed8',
  };
}

export function createSatellite500(): SatelliteModel {
  return {
    id: 'sat_500kg_demo',
    name: '“辰光-500”高分辨率平台',
    massClassKg: 500,
    description: '500 kg 级 SSO 遥感卫星：长方体平台、柱状天线、相机遮光罩与双太阳翼。',
    updatedAt: Date.now(),
    builtIn: true,
    primitives: [
      {
        id: 'bus_500', name: '卫星平台长方体', kind: 'box', role: 'bus',
        position: [0, 0, 0], rotation: { yaw: 0, pitch: 0, roll: 0 },
        size: [1.55, 1.42, 1.52], radius: 0, height: 0,
        color: '#cbd5e1', reflectivity: 0.42, castsShadow: true,
      },
      {
        id: 'mast_500', name: '数传天线支架', kind: 'cylinder', role: 'antenna',
        position: [0.18, 0.54, 1.28], rotation: { yaw: 0, pitch: 0, roll: 90 },
        size: [0.07, 0.07, 1.05], radius: 0.035, height: 1.05,
        color: '#94a3b8', reflectivity: 0.55, castsShadow: true,
      },
      {
        id: 'dish_500', name: '定向天线/圆盘', kind: 'cylinder', role: 'antenna',
        position: [0.18, 0.58, 1.86], rotation: { yaw: 0, pitch: 0, roll: 90 },
        size: [0.82, 0.82, 0.1], radius: 0.41, height: 0.1,
        color: '#e2e8f0', reflectivity: 0.68, castsShadow: true,
      },
      {
        id: 'shroud_500', name: '相机遮光罩', kind: 'cylinder', role: 'shroud',
        position: [-0.36, 0.5, 1.12], rotation: { yaw: 0, pitch: 0, roll: 90 },
        size: [0.34, 0.34, 0.58], radius: 0.17, height: 0.58,
        color: '#111827', reflectivity: 0.08, castsShadow: true,
      },
      {
        id: 'camera_box_500', name: '相机载荷箱体', kind: 'box', role: 'instrument',
        position: [-0.36, 0.34, 0.82], rotation: { yaw: 0, pitch: 0, roll: 0 },
        size: [0.46, 0.42, 0.34], radius: 0, height: 0,
        color: '#475569', reflectivity: 0.22, castsShadow: true,
      },
    ],
    wings: [wing500(1), wing500(-1)],
  };
}

function wing50(side: 1 | -1) {
  const plus = side === 1;
  return {
    id: plus ? 'wing_50_py' : 'wing_50_my',
    name: plus ? '+Y 太阳翼' : '-Y 太阳翼',
    position: [0, plus ? 0.34 : -0.34, 0] as [number, number, number],
    hingeAxis: [0, 0, 1] as [number, number, number],
    deploymentAngleDeg: plus ? 90 : -90,
    driveAngleDeg: plus ? 24 : -24,
    cols: 5,
    rows: 8,
    cellLengthM: 0.1,
    cellWidthM: 0.08,
    gapXM: 0.008,
    gapYM: 0.008,
    edgeMarginM: 0.03,
    cellEfficiency: 0.295,
    cellVmpV: 2.28,
    cellVocV: 2.62,
    cellsPerString: 8,
    bypassGroupSize: 4,
    bypassDiodeVoltageV: 0.32,
    bypassEnabled: true,
    stringDirection: 'column' as const,
    mpptPerString: true,
    substrateColor: '#334155',
    cellColor: '#1e40af',
  };
}

export function createSatellite50(): SatelliteModel {
  const a = 6878;
  void a;
  return {
    id: 'sat_50kg_demo',
    name: '“微萤-50”技术试验星',
    massClassKg: 50,
    description: '50 kg 级微小卫星：小型长方体星体、柱状全向天线、遮光罩与双折叠太阳翼。',
    updatedAt: Date.now(),
    builtIn: true,
    primitives: [
      {
        id: 'bus_50', name: '微卫星平台', kind: 'box', role: 'bus',
        position: [0, 0, 0], rotation: { yaw: 0, pitch: 0, roll: 0 },
        size: [0.72, 0.62, 0.66], radius: 0, height: 0,
        color: '#bfdbfe', reflectivity: 0.38, castsShadow: true,
      },
      {
        id: 'antenna_50', name: '全向天线', kind: 'cylinder', role: 'antenna',
        position: [0.12, 0.22, 0.55], rotation: { yaw: 0, pitch: 0, roll: 90 },
        size: [0.05, 0.05, 0.5], radius: 0.018, height: 0.5,
        color: '#e5e7eb', reflectivity: 0.6, castsShadow: true,
      },
      {
        id: 'shroud_50', name: '星敏/相机遮光罩', kind: 'cylinder', role: 'shroud',
        position: [-0.16, 0.22, 0.48], rotation: { yaw: 0, pitch: 0, roll: 90 },
        size: [0.16, 0.16, 0.28], radius: 0.08, height: 0.28,
        color: '#111827', reflectivity: 0.1, castsShadow: true,
      },
    ],
    wings: [wing50(1), wing50(-1)],
  };
}

export function createDefaultPlan(): WorkspacePlan {
  return {
    id: 'workspace_current',
    name: '默认 SSO 典型工况',
    model: createSatellite500(),
    orbit: defaultOrbit(),
    attitude: defaultAttitude(),
    dateISO: '2026-06-21T04:00:00.000Z',
    settings: { ...DEFAULT_SETTINGS },
    updatedAt: Date.now(),
  };
}

export function cloneModel(model: SatelliteModel, newName?: string): SatelliteModel {
  const copy = structuredClone(model) as SatelliteModel;
  copy.id = uid('model');
  copy.name = newName ?? `${model.name} 副本`;
  copy.builtIn = false;
  copy.updatedAt = Date.now();
  return copy;
}

export function caseFromPlan(plan: WorkspacePlan, name: string): CompareCase {
  return {
    id: uid('case'),
    name,
    savedAt: Date.now(),
    model: structuredClone(plan.model),
    attitude: structuredClone(plan.attitude),
    orbitSnapshot: structuredClone(plan.orbit),
    dateSnapshot: plan.dateISO,
    notes: `${plan.model.massClassKg} kg 级；${plan.attitude.mode} 姿态；${plan.attitude.maneuvers.length} 段机动。`,
  };
}
