import type { CellRecord, ElectricalConfig, Settings, SimResult, StepEnvironment } from '../types';
import { runGpuInsolation } from '../gpu/insolation';
import { runCpuInsolation } from '../gpu/cpuInsolation';
import { getGpuDevice } from '../gpu/device';
import { arrayPower, buildTopology, analyticCosinePowerW } from './power';

export interface CosineAcceptanceReport {
  backend: SimResult['backend'];
  maxRelativeErrorPct: number;
  passed: boolean;
  points: Array<{ angleDeg: number; simulatedW: number; analyticW: number; errorPct: number }>;
}

export async function runCosineAcceptance(
  cfg: ElectricalConfig,
  settings?: Settings,
  cellCount = 192
): Promise<CosineAcceptanceReport> {
  const cells: CellRecord[] = Array.from({ length: cellCount }, (_, i) => {
    const col = i % 16;
    const row = Math.floor(i / 16);
    return {
      cellId: `ACC-${i}`,
      arrayId: 'acceptance-array',
      stringId: 'acceptance:string',
      indexInArray: i,
      row,
      col,
      centerBody: [(col - 7.5) * 0.2, (row - 5.5) * 0.14, 0],
      normalBody: [0, 0, 1],
      tangentU: [1, 0, 0],
      tangentV: [0, 1, 0],
      width: 0.18,
      height: 0.12,
      areaM2: 0.0216,
      selfOccluder: 0xffff
    };
  });

  const angles = [0, 10, 20, 30, 45, 60, 75, 85];
  const environments: StepEnvironment[] = angles.map((angleDeg) => {
    const theta = (angleDeg * Math.PI) / 180;
    return {
      tSec: angleDeg,
      sunDirectionBody: [Math.sin(theta), 0, Math.cos(theta)],
      earthDirectionBody: [0, 0, -1],
      earthAngularRadiusRad: 0.24,
      sunDirectionEci: [Math.sin(theta), 0, Math.cos(theta)],
      inEarthShadow: false,
      eclipseFactor: 1,
      betaAngleDeg: 0
    };
  });

  const cleanSimulation = {
    stepSec: 1,
    samplesPerCellAxis: 1,
    earthAlbedo: 0,
    bounceCoefficient: 0,
    enableEarthAlbedo: false,
    enableMultiBounce: false,
    enableSelfShadow: false
  };

  let backend: SimResult['backend'] = 'cpu-reference';
  let irradiance;
  const wantsGpu = !settings || settings.preferredBackend === 'auto' || settings.preferredBackend === 'webgpu';
  const gpuDevice = wantsGpu ? await getGpuDevice() : null;
  if (gpuDevice) {
    try {
      irradiance = await runGpuInsolation(cells, [], environments, cleanSimulation);
      backend = 'webgpu';
    } catch (err) {
      if (settings && !settings.unsafeCpuFallback) throw err;
      console.warn('Cosine acceptance GPU failed, using CPU.', err);
      irradiance = await runCpuInsolation(cells, [], environments, cleanSimulation);
    }
  } else {
    if (settings && !settings.unsafeCpuFallback) throw new Error('WebGPU 不可用，且设置中未允许 CPU 参考后端');
    irradiance = await runCpuInsolation(cells, [], environments, cleanSimulation);
  }

  const topology = buildTopology(cells, [{ id: 'acceptance:string', name: 'Acceptance', bypassGroupSize: 12 }]);
  const points = angles.map((angleDeg, step) => {
    const map = new Map<string, number>();
    irradiance[step].forEach((sample, i) => map.set(cells[i].cellId, sample.totalWm2));
    const { totalW } = arrayPower(topology, map, cfg);
    const analyticW = analyticCosinePowerW(angleDeg, cellCount, cfg);
    const errorPct = Math.abs((totalW - analyticW) / analyticW) * 100;
    return { angleDeg, simulatedW: totalW, analyticW, errorPct };
  });
  const maxRelativeErrorPct = Math.max(...points.map((p) => p.errorPct));
  return { backend, points, maxRelativeErrorPct, passed: maxRelativeErrorPct < 0.5 };
}
