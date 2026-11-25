import type { CellRecord, CellSample, OccluderRuntime, SimulationConfig, StepEnvironment, Vec3 } from '../types';
import { dot, normalize } from '../lib/math';
import { SOLAR_CONSTANT_WM2 } from '../lib/orbit';

function transformPoint(m: Float32Array, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]
  ];
}
function transformDir(m: Float32Array, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2]
  ];
}

function intersect(origin: Vec3, dir: Vec3, oc: OccluderRuntime): number {
  const lo = transformPoint(oc.inverse, origin);
  const ld = normalize(transformDir(oc.inverse, dir));
  if (oc.kind === 0) {
    let tmin = -Infinity;
    let tmax = Infinity;
    for (let axis = 0; axis < 3; axis++) {
      const o = lo[axis], d = ld[axis];
      if (Math.abs(d) < 1e-10) {
        if (o < -0.5 || o > 0.5) return -1;
      } else {
        let t1 = (-0.5 - o) / d;
        let t2 = (0.5 - o) / d;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
      }
    }
    if (tmax < Math.max(tmin, 0.002)) return -1;
    let t = tmin;
    if (t < 0.002) t = tmax;
    return t > 0.002 ? t : -1;
  }

  const r = oc.radius;
  const half = oc.length / 2;
  const a = ld[0] ** 2 + ld[2] ** 2;
  const b = 2 * (lo[0] * ld[0] + lo[2] * ld[2]);
  const c = lo[0] ** 2 + lo[2] ** 2 - r ** 2;
  let best = Infinity;
  if (a > 1e-10) {
    const d = b * b - 4 * a * c;
    if (d >= 0) {
      const root = Math.sqrt(d);
      for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
        if (t > 0.002) {
          const y = lo[1] + t * ld[1];
          if (y >= -half && y <= half) best = Math.min(best, t);
        }
      }
    }
  }
  if (Math.abs(ld[1]) > 1e-10) {
    for (const yCap of [-half, half]) {
      const t = (yCap - lo[1]) / ld[1];
      if (t > 0.002) {
        const x = lo[0] + t * ld[0];
        const z = lo[2] + t * ld[2];
        if (x * x + z * z <= r * r) best = Math.min(best, t);
      }
    }
  }
  return Number.isFinite(best) ? best : -1;
}

function shadowed(origin: Vec3, dir: Vec3, skip: number, occluders: OccluderRuntime[], enabled: boolean): boolean {
  if (!enabled) return false;
  for (let i = 0; i < occluders.length; i++) {
    if (i === skip) continue;
    if (intersect(origin, dir, occluders[i]) > 0) return true;
  }
  return false;
}

export async function runCpuInsolation(
  cells: CellRecord[],
  occluders: OccluderRuntime[],
  environments: StepEnvironment[],
  simulation: SimulationConfig
): Promise<CellSample[][]> {
  const n = Math.max(1, simulation.samplesPerCellAxis);
  return environments.map((env) =>
    cells.map((cell) => {
      const sun = normalize(env.sunDirectionBody);
      let lit = 0;
      for (let ix = 0; ix < n; ix++) {
        for (let iy = 0; iy < n; iy++) {
          const fx = (ix + 0.5) / n - 0.5;
          const fy = (iy + 0.5) / n - 0.5;
          const p: Vec3 = [
            cell.centerBody[0] + cell.tangentU[0] * fx * cell.width + cell.tangentV[0] * fy * cell.height + cell.normalBody[0] * 0.012,
            cell.centerBody[1] + cell.tangentU[1] * fx * cell.width + cell.tangentV[1] * fy * cell.height + cell.normalBody[1] * 0.012,
            cell.centerBody[2] + cell.tangentU[2] * fx * cell.width + cell.tangentV[2] * fy * cell.height + cell.normalBody[2] * 0.012
          ];
          if (!shadowed(p, sun, cell.selfOccluder, occluders, simulation.enableSelfShadow)) lit++;
        }
      }
      const litFraction = lit / (n * n);
      const cos = Math.max(0, dot(cell.normalBody, sun));
      const directWm2 = SOLAR_CONSTANT_WM2 * env.eclipseFactor * cos * litFraction;
      const earth = normalize(env.earthDirectionBody);
      const earthView = simulation.enableEarthAlbedo
        ? Math.max(0, dot(cell.normalBody, earth)) * Math.sin(env.earthAngularRadiusRad) ** 2
        : 0;
      const phase = Math.max(0.08, dot([-earth[0], -earth[1], -earth[2]], sun));
      const albedoWm2 = simulation.enableEarthAlbedo ? SOLAR_CONSTANT_WM2 * simulation.earthAlbedo * phase * earthView : 0;

      let bounceWm2 = 0;
      if (simulation.enableMultiBounce) {
        // Lightweight empirical body/panel reflection closure used when WebGPU is unavailable.
        for (const oc of occluders) {
          if (oc.sourceId === cell.arrayId) continue;
          const center: Vec3 = [oc.model[12], oc.model[13], oc.model[14]];
          const d: Vec3 = [center[0] - cell.centerBody[0], center[1] - cell.centerBody[1], center[2] - cell.centerBody[2]];
          const dist2 = Math.max(0.25, dot(d, d));
          const proximity = Math.min(1, 1 / dist2);
          bounceWm2 += SOLAR_CONSTANT_WM2 * env.eclipseFactor * oc.reflectivity * simulation.bounceCoefficient * proximity * 0.08;
        }
      }
      return { litFraction, directWm2, albedoWm2, bounceWm2, totalWm2: directWm2 + albedoWm2 + bounceWm2 };
    })
  );
}
