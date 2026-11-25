import type { PowerSample, ScenarioCase, Settings, SimResult, StepEnvironment } from '../types';
import { buildGeometry } from './geometry';
import {
  EARTH_RADIUS_KM,
  earthShadowFactor,
  findEclipseIntervals,
  orbitalPeriodSec,
  propagateEci,
  sunDirectionEci,
  betaAngleDeg
} from './orbit';
import { attitudeAt, toBodyFrame } from './attitude';
import { arrayPower, buildTopology, cosineSelfTest } from './power';
import { runGpuInsolation } from '../gpu/insolation';
import { runCpuInsolation } from '../gpu/cpuInsolation';
import { getGpuDevice } from '../gpu/device';

export function buildEnvironments(scenario: ScenarioCase): { environments: StepEnvironment[]; period: number } {
  const period = orbitalPeriodSec(scenario.orbit);
  const step = scenario.simulation.stepSec;
  const count = Math.floor(period / step);
  const environments: StepEnvironment[] = [];
  const epoch = new Date(scenario.orbit.epochISO).getTime();
  const sunEpoch = sunDirectionEci(new Date(epoch));
  const beta = betaAngleDeg(scenario.orbit, sunEpoch);

  for (let i = 0; i <= count; i++) {
    const tSec = Math.min(period, i * step);
    const state = propagateEci(scenario.orbit, tSec);
    const date = new Date(epoch + tSec * 1000);
    const sunEci = sunDirectionEci(date);
    const q = attitudeAt(scenario.attitude, state, sunEci, tSec);
    const sunBody = toBodyFrame(q, sunEci);
    const earthEci = [-state.positionKm[0], -state.positionKm[1], -state.positionKm[2]] as [number, number, number];
    const earthBody = toBodyFrame(q, earthEci);
    const r = Math.hypot(...state.positionKm);
    environments.push({
      tSec,
      sunDirectionBody: sunBody,
      earthDirectionBody: earthBody,
      earthAngularRadiusRad: Math.asin(Math.min(0.999999, EARTH_RADIUS_KM / r)),
      sunDirectionEci: sunEci,
      inEarthShadow: earthShadowFactor(state.positionKm, sunEci) < 0.5,
      eclipseFactor: earthShadowFactor(state.positionKm, sunEci),
      betaAngleDeg: beta
    });
  }
  return { environments, period };
}

export async function simulateScenario(
  scenario: ScenarioCase,
  settings?: Settings,
  options: { attachValidation?: boolean } = {}
): Promise<SimResult> {
  const started = performance.now();
  const { cells, occluders } = buildGeometry(scenario.geometry);
  const { environments, period } = buildEnvironments(scenario);

  let backend: SimResult['backend'] = 'cpu-reference';
  let irradiance;
  const wantsGpu = !settings || settings.preferredBackend === 'auto' || settings.preferredBackend === 'webgpu';
  const gpuDevice = wantsGpu ? await getGpuDevice() : null;
  if (gpuDevice) {
    try {
      irradiance = await runGpuInsolation(cells, occluders, environments, scenario.simulation);
      backend = 'webgpu';
    } catch (err) {
      console.error('WebGPU insolation pass failed; falling back to CPU reference.', err);
      if (settings && !settings.unsafeCpuFallback) throw err;
      irradiance = await runCpuInsolation(cells, occluders, environments, scenario.simulation);
    }
  } else {
    if (settings && !settings.unsafeCpuFallback) throw new Error('WebGPU 不可用，且设置中未允许 CPU 参考后端');
    irradiance = await runCpuInsolation(cells, occluders, environments, scenario.simulation);
  }

  const stringSpecs = scenario.geometry.arrays.flatMap((a) =>
    a.strings.map((s) => ({ id: `${a.id}:${s.id}`, name: `${a.name} / ${s.name}`, bypassGroupSize: s.bypassGroupSize }))
  );
  const topology = buildTopology(cells, stringSpecs);

  const power: PowerSample[] = environments.map((env, stepIndex) => {
    const byCell = new Map<string, number>();
    irradiance[stepIndex].forEach((sample, cellIndex) => {
      byCell.set(cells[cellIndex].cellId, sample.totalWm2);
    });
    const solved = arrayPower(topology, byCell, scenario.electrical);
    const loadW = scenario.geometry.busPowerW + scenario.geometry.payloadPowerW;
    return {
      tSec: env.tSec,
      totalW: solved.totalW,
      solarW: solved.totalW,
      busLoadW: scenario.geometry.busPowerW,
      payloadLoadW: scenario.geometry.payloadPowerW,
      netW: solved.totalW - loadW,
      strings: solved.strings
    };
  });

  let minPower = power[0];
  let maxPower = power[0];
  for (const p of power) {
    if (p.solarW < minPower.solarW) minPower = p;
    if (p.solarW > maxPower.solarW) maxPower = p;
  }

  const sunEpoch = sunDirectionEci(new Date(scenario.orbit.epochISO));
  const eclipseIntervals = findEclipseIntervals(scenario.orbit, sunEpoch, period);
  const elapsedMs = performance.now() - started;

  return {
    caseId: scenario.id,
    startedAt: Date.now(),
    elapsedMs,
    backend,
    steps: environments.length,
    cells: cells.length,
    environments,
    irradiance,
    power,
    eclipseIntervals,
    minPower: { tSec: minPower.tSec, powerW: minPower.solarW },
    maxPower: { tSec: maxPower.tSec, powerW: maxPower.solarW },
    orbitPeriodSec: period,
    validation: options.attachValidation ? cosineSelfTest(scenario.electrical) : undefined
  };
}
