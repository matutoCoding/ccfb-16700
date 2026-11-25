import type {
  EpochPowerResult, OrbitState, SimulationResult, SimulationSettings, WorkspacePlan,
} from '../types';
import { prepareGeometry } from './geometry';
import { buildOrbitStates, findEclipseIntervals } from './orbit';
import { attitudeQuatAt, bodyVectorsForState } from './attitude';
import { computeIlluminationCPU, readIllumination, type IlluminationBatch } from './illumination';
import { cosineLawSelfCheck, evaluateComponentPowers } from './electrical';
import { getWebGPUDevice } from '../webgpu/device';
import { computeIlluminationGPU } from '../webgpu/illuminationGpu';

export interface RunOptions {
  forceEngine?: 'cpu' | 'webgpu';
  onEngine?: (engine: 'cpu' | 'webgpu') => void;
}

function applyAttitude(states: OrbitState[], plan: WorkspacePlan): void {
  for (const state of states) {
    const q = attitudeQuatAt(plan.attitude, state);
    state.bodyToECI = q;
    const body = bodyVectorsForState(q, state);
    state.sunBody = body.sunBody;
    state.earthBody = body.earthBody;
  }
}

export async function runSimulation(plan: WorkspacePlan, options: RunOptions = {}): Promise<SimulationResult> {
  const started = performance.now();
  const settings: SimulationSettings = { ...plan.settings };
  const prepared = prepareGeometry(plan.model);
  const { states, periodSec } = buildOrbitStates(plan.orbit, plan.dateISO, settings.stepSec, settings.earthRadiusKm);
  applyAttitude(states, plan);

  let batch: IlluminationBatch;
  let engine: 'webgpu' | 'cpu' | 'mixed' = 'cpu';

  if (options.forceEngine === 'cpu' || !settings.useGpu) {
    batch = computeIlluminationCPU(prepared, states, settings);
    engine = 'cpu';
  } else {
    const device = options.forceEngine === 'webgpu' ? await getWebGPUDevice() : await getWebGPUDevice();
    if (!device) {
      batch = computeIlluminationCPU(prepared, states, settings);
      engine = 'cpu';
    } else {
      try {
        batch = await computeIlluminationGPU(device, prepared, states, settings);
        engine = 'webgpu';
        options.onEngine?.('webgpu');
      } catch (err) {
        console.error('WebGPU illumination failed; falling back to CPU.', err);
        batch = computeIlluminationCPU(prepared, states, settings);
        engine = 'mixed';
      }
    }
  }

  const epochs: EpochPowerResult[] = states.map((state, e) => {
    const n = prepared.cells.length;
    const cellIllumination = new Array(n);
    const direct = new Array<number>(n);
    const albedo = new Array<number>(n);
    const bounce = new Array<number>(n);
    for (let c = 0; c < n; c++) {
      const illum = readIllumination(batch, e, c);
      cellIllumination[c] = illum;
      direct[c] = illum.directWm2;
      albedo[c] = illum.albedoWm2;
      bounce[c] = illum.bounceWm2;
    }
    const power = evaluateComponentPowers(plan.model, prepared.cells, direct, albedo, bounce);
    return {
      index: e,
      tSec: state.tSec,
      dateISO: state.dateISO,
      eclipseFactor: state.eclipseFactor,
      inEclipse: state.inEclipse,
      sunAngleDeg: Math.acos(Math.max(-1, Math.min(1, state.sunBody[2]))) * 180 / Math.PI,
      directPowerW: power.directW,
      albedoPowerW: power.albedoW,
      bouncePowerW: power.bounceW,
      totalPowerW: power.totalW,
      stringResults: power.strings,
      cellIllumination,
    };
  });

  let minTotal = { powerW: Infinity, tSec: 0, index: 0, dateISO: states[0]?.dateISO ?? plan.dateISO };
  let minSunlit: SimulationResult['minSunlit'] = null;
  let energyWs = 0;
  for (let i = 0; i < epochs.length; i++) {
    const ep = epochs[i];
    if (ep.totalPowerW < minTotal.powerW) {
      minTotal = { powerW: ep.totalPowerW, tSec: ep.tSec, index: i, dateISO: ep.dateISO };
    }
    if (ep.eclipseFactor > 0.95) {
      if (!minSunlit || ep.totalPowerW < minSunlit.powerW) {
        minSunlit = { powerW: ep.totalPowerW, tSec: ep.tSec, index: i, dateISO: ep.dateISO };
      }
    }
    if (i > 0) {
      const dt = ep.tSec - epochs[i - 1].tSec;
      energyWs += ((ep.totalPowerW + epochs[i - 1].totalPowerW) / 2) * dt;
    }
  }
  if (!Number.isFinite(minTotal.powerW)) minTotal.powerW = 0;

  const eclipseIntervals = findEclipseIntervals(states);
  const cosineCheck = cosineLawSelfCheck();
  const elapsedMs = performance.now() - started;

  return {
    planId: plan.id,
    ranAt: Date.now(),
    engine,
    elapsedMs,
    epochCount: epochs.length,
    cellCount: prepared.cells.length,
    orbitPeriodSec: periodSec,
    epochs,
    orbitStates: states,
    minTotal,
    minSunlit,
    eclipseIntervals,
    energyWh: energyWs / 3600,
    cosineCheck,
  };
}

/** Lightweight run used by comparison charts; keeps full cell tables. */
export async function runComparisonCase(
  model: WorkspacePlan['model'],
  attitude: WorkspacePlan['attitude'],
  orbit: WorkspacePlan['orbit'],
  dateISO: string,
  settings: SimulationSettings,
): Promise<SimulationResult> {
  const plan: WorkspacePlan = {
    id: `compare_${model.id}`,
    name: model.name,
    model,
    orbit,
    attitude,
    dateISO,
    settings,
    updatedAt: Date.now(),
  };
  return runSimulation(plan);
}
