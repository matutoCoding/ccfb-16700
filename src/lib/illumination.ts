import type { CellIllumination, OrbitState, SimulationSettings } from '../types';
import { dot, normalize } from './math';
import { anyShadowHit, cellSamplePoints, intersectOccluder, type PreparedGeometry } from './geometry';

export const ILLUMINATION_STRIDE = 8;
// [litFraction, cosine, direct, albedo, bounce, total, viewFactor, reserved]

export interface IlluminationBatch {
  epochCount: number;
  cellCount: number;
  data: Float32Array;
  engine: 'cpu' | 'webgpu';
}

export function readIllumination(batch: IlluminationBatch, epochIndex: number, cellIndex: number): CellIllumination {
  const i = (epochIndex * batch.cellCount + cellIndex) * ILLUMINATION_STRIDE;
  return {
    litFraction: batch.data[i],
    cosine: batch.data[i + 1],
    directWm2: batch.data[i + 2],
    albedoWm2: batch.data[i + 3],
    bounceWm2: batch.data[i + 4],
    totalWm2: batch.data[i + 5],
  };
}

function tangentBasis(normal: [number, number, number]): { tangent: [number, number, number]; bitangent: [number, number, number] } {
  const helper = Math.abs(normal[2]) < 0.9 ? [0, 0, 1] as [number, number, number] : [1, 0, 0] as [number, number, number];
  const tangent = normalize([
    normal[1] * helper[2] - normal[2] * helper[1],
    normal[2] * helper[0] - normal[0] * helper[2],
    normal[0] * helper[1] - normal[1] * helper[0],
  ]);
  const bitangent = [
    normal[1] * tangent[2] - normal[2] * tangent[1],
    normal[2] * tangent[0] - normal[0] * tangent[2],
    normal[0] * tangent[1] - normal[1] * tangent[0],
  ];
  return { tangent, bitangent: normalize(bitangent as [number, number, number]) };
}

function fract01(x: number): number {
  return x - Math.floor(x);
}

function cosineHemisphereRay(normal: [number, number, number], rayIndex: number, rayCount: number, bounceIndex: number): [number, number, number] {
  const { tangent, bitangent } = tangentBasis(normal);
  // Deterministic stratified/Fibonacci-like samples. CPU and WGSL use the
  // same sequence, avoiding f32 trig-hash correlation.
  const u1 = (rayIndex + 0.5) / Math.max(1, rayCount);
  const u2 = fract01((rayIndex + 0.5) * 0.618033988749895 + bounceIndex * 0.31830988618);
  const r = Math.sqrt(u1);
  const phi = 2 * Math.PI * u2;
  const lx = r * Math.cos(phi);
  const ly = r * Math.sin(phi);
  const lz = Math.sqrt(Math.max(0, 1 - u1));
  return normalize([
    tangent[0] * lx + bitangent[0] * ly + normal[0] * lz,
    tangent[1] * lx + bitangent[1] * ly + normal[1] * lz,
    tangent[2] * lx + bitangent[2] * ly + normal[2] * lz,
  ]);
}

function computeBounceCPU(
  prepared: PreparedGeometry,
  cellIndex: number,
  sunBody: [number, number, number],
  solarConstant: number,
  eclipseFactor: number,
  settings: SimulationSettings,
  epochIndex: number,
): number {
  if (!settings.multiBounceEnabled || settings.bounceCount <= 0 || settings.bounceRaysPerCell <= 0) return 0;
  const cell = prepared.cells[cellIndex];
  let sum = 0;
  const rayCount = Math.max(1, settings.bounceRaysPerCell);

  for (let r = 0; r < rayCount; r++) {
    let origin: [number, number, number] = [
      cell.centerBody[0] + cell.normalBody[0] * 0.012,
      cell.centerBody[1] + cell.normalBody[1] * 0.012,
      cell.centerBody[2] + cell.normalBody[2] * 0.012,
    ];
    let normal = cell.normalBody;
    let throughput = 1;

    for (let bounce = 0; bounce < settings.bounceCount; bounce++) {
      const dir = cosineHemisphereRay(normal, r, rayCount, bounce);
      let nearest: ReturnType<typeof intersectOccluder> = null;
      for (const occ of prepared.occluders) {
        const hit = intersectOccluder(occ, origin, dir);
        if (hit && (!nearest || hit.t < nearest.t)) nearest = hit;
      }
      if (!nearest) break;
      throughput *= nearest.occluder.reflectivity;
      const hitCos = Math.max(0, dot(nearest.normal, sunBody));
      const shadowOrigin: [number, number, number] = [
        nearest.point[0] + nearest.normal[0] * 0.01,
        nearest.point[1] + nearest.normal[1] * 0.01,
        nearest.point[2] + nearest.normal[2] * 0.01,
      ];
      const sunlit = hitCos > 0.001 && !anyShadowHit(prepared.occluders, shadowOrigin, sunBody);
      if (sunlit) sum += throughput * solarConstant * eclipseFactor * hitCos;
      origin = [
        nearest.point[0] + nearest.normal[0] * 0.012,
        nearest.point[1] + nearest.normal[1] * 0.012,
        nearest.point[2] + nearest.normal[2] * 0.012,
      ];
      normal = nearest.normal;
    }
  }
  return sum / rayCount;
}

export function computeIlluminationCPU(
  prepared: PreparedGeometry,
  states: OrbitState[],
  settings: SimulationSettings,
): IlluminationBatch {
  const cellCount = prepared.cells.length;
  const epochCount = states.length;
  const data = new Float32Array(epochCount * cellCount * ILLUMINATION_STRIDE);
  const nAxis = Math.max(1, settings.shadowSamplesPerAxis);
  const sampleCount = nAxis * nAxis;

  for (let e = 0; e < epochCount; e++) {
    const state = states[e];
    const base = e * cellCount * ILLUMINATION_STRIDE;
    for (let c = 0; c < cellCount; c++) {
      const cell = prepared.cells[c];
      const cosine = dot(cell.normalBody, state.sunBody);
      let litSamples = 0;
      if (cosine > 1e-4 && state.eclipseFactor > 0.001) {
        const samples = cellSamplePoints(cell, nAxis);
        for (const p of samples) {
          if (!anyShadowHit(prepared.occluders, p, state.sunBody)) litSamples++;
        }
      }
      const litFraction = cosine <= 0 ? 0 : litSamples / sampleCount;
      const direct = settings.solarConstantWm2 * Math.max(0, cosine) * litFraction * state.eclipseFactor;

      const cosEarth = Math.max(0, dot(cell.normalBody, state.earthBody));
      const sinRho2 = Math.sin(state.earthAngularRadiusRad) ** 2;
      const viewFactor = sinRho2 * cosEarth;
      const albedo = settings.solarConstantWm2 * settings.earthAlbedo * state.earthSunlitFactor * viewFactor;
      const bounce = computeBounceCPU(prepared, c, state.sunBody, settings.solarConstantWm2, state.eclipseFactor, settings, e);
      const total = direct + albedo + bounce;
      const i = base + c * ILLUMINATION_STRIDE;
      data[i] = litFraction;
      data[i + 1] = cosine;
      data[i + 2] = direct;
      data[i + 3] = albedo;
      data[i + 4] = bounce;
      data[i + 5] = total;
      data[i + 6] = viewFactor;
      data[i + 7] = 0;
    }
  }
  return { epochCount, cellCount, data, engine: 'cpu' };
}
