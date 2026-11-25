import type { CellRecord, GeometricPrimitive, SatelliteModel, SolarWing, Vec3 } from '../types';
import { composeTRS, invertMat4, mat4FromQuat, mat4Multiply, mat4Translation, quatFromAxisAngle, deg2rad, transformDirection, transformPoint } from './math';

export const STANDARD_IRRADIANCE_WM2 = 1361;

export interface Occluder {
  id: string;
  name: string;
  kind: 0 | 1; // box/plate=0, cylinder=1
  model: Float32Array;
  inv: Float32Array;
  size: Vec3;
  radius: number;
  height: number;
  reflectivity: number;
  color: [number, number, number];
}

export interface PreparedGeometry {
  cells: CellRecord[];
  occluders: Occluder[];
  wingMatrices: Map<string, Float32Array>;
}

export function wingMatrix(wing: SolarWing): Float32Array {
  const deployQ = quatFromAxisAngle(wing.hingeAxis, deg2rad(wing.deploymentAngleDeg));
  const driveQ = quatFromAxisAngle([1, 0, 0], deg2rad(wing.driveAngleDeg));
  const rotation = mat4Multiply(mat4FromQuat(deployQ), mat4FromQuat(driveQ));
  return mat4Multiply(mat4Translation(wing.position), rotation);
}

export function wingGridExtent(wing: SolarWing): { x: number; y: number; pitchX: number; pitchY: number; totalY: number } {
  const pitchX = wing.cellLengthM + wing.gapXM;
  const pitchY = wing.cellWidthM + wing.gapYM;
  const x = wing.edgeMarginM * 2 + wing.cols * wing.cellLengthM + Math.max(0, wing.cols - 1) * wing.gapXM;
  const totalY = wing.rows * wing.cellWidthM + Math.max(0, wing.rows - 1) * wing.gapYM;
  const y = totalY + wing.edgeMarginM * 2;
  return { x, y, pitchX, pitchY, totalY };
}

function primitiveToOccluder(p: GeometricPrimitive): Occluder {
  const model = composeTRS(p.position, p.rotation);
  return {
    id: p.id,
    name: p.name,
    kind: p.kind === 'cylinder' ? 1 : 0,
    model,
    inv: invertMat4(model),
    size: p.size,
    radius: p.radius,
    height: p.height,
    reflectivity: p.reflectivity,
    color: hexToRgb(p.color),
  };
}

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h || '94a3b8', 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function wingSubstrateOccluder(wing: SolarWing, matrix: Float32Array): Occluder {
  const ext = wingGridExtent(wing);
  const thickness = 0.025;
  // Cell coordinates start at edgeMargin from root. Put substrate from x=0 to ext.x.
  const localCenter: Vec3 = [ext.x / 2, 0, -thickness / 2];
  const model = mat4Multiply(matrix, mat4Translation(localCenter));
  return {
    id: `${wing.id}_substrate`,
    name: `${wing.name}基板`,
    kind: 0,
    model,
    inv: invertMat4(model),
    size: [ext.x, ext.y, thickness],
    radius: 0,
    height: thickness,
    reflectivity: 0.18,
    color: hexToRgb(wing.substrateColor),
  };
}

export function prepareGeometry(model: SatelliteModel): PreparedGeometry {
  const cells: CellRecord[] = [];
  const occluders: Occluder[] = model.primitives.filter((p) => p.castsShadow).map(primitiveToOccluder);
  const wingMatrices = new Map<string, Float32Array>();

  for (const wing of model.wings) {
    const matrix = wingMatrix(wing);
    wingMatrices.set(wing.id, matrix);
    occluders.push(wingSubstrateOccluder(wing, matrix));
    const ext = wingGridExtent(wing);
    const seriesIsColumn = wing.stringDirection === 'column';
    const seriesLength = seriesIsColumn ? wing.rows : wing.cols;
    const chunk = wing.cellsPerString > 0 ? Math.min(wing.cellsPerString, seriesLength) : seriesLength;
    const stringsPerOrthogonal = seriesIsColumn ? wing.cols : wing.rows;
    const stringCountWing = stringsPerOrthogonal * Math.ceil(seriesLength / chunk);
    let cellIndex = cells.length;

    for (let row = 0; row < wing.rows; row++) {
      for (let col = 0; col < wing.cols; col++) {
        const lx = wing.edgeMarginM + col * ext.pitchX + wing.cellLengthM / 2;
        const ly = -ext.totalY / 2 + row * ext.pitchY + wing.cellWidthM / 2;
        const localCenter: Vec3 = [lx, ly, 0.004];
        const center = transformPoint(matrix, localCenter);
        const normal = transformDirection(matrix, [0, 0, 1]);
        const axisU = transformDirection(matrix, [1, 0, 0]);
        const axisV = transformDirection(matrix, [0, 1, 0]);
        const seriesIndex = seriesIsColumn ? row : col;
        const orthogonalIndex = seriesIsColumn ? col : row;
        const chunkIndex = Math.floor(seriesIndex / chunk);
        const stringLocalIndex = orthogonalIndex * Math.ceil(seriesLength / chunk) + chunkIndex;
        const positionInChunk = seriesIndex - chunkIndex * chunk;
        const groupInString = Math.floor(positionInChunk / Math.max(1, wing.bypassGroupSize));
        const area = wing.cellLengthM * wing.cellWidthM;
        const ratedPower = wing.cellEfficiency * STANDARD_IRRADIANCE_WM2 * area;
        cells.push({
          cellId: `${wing.id}_c${col}_r${row}`,
          wingId: wing.id,
          wingName: wing.name,
          index: cellIndex++,
          col,
          row,
          stringId: `${wing.id}_string_${String(stringLocalIndex + 1).padStart(2, '0')}`,
          stringIndex: stringLocalIndex,
          bypassGroupId: `${wing.id}_string_${String(stringLocalIndex + 1).padStart(2, '0')}_bp_${groupInString + 1}`,
          centerBody: center,
          normalBody: normal,
          axisUBody: axisU,
          axisVBody: axisV,
          halfU: wing.cellLengthM / 2,
          halfV: wing.cellWidthM / 2,
          areaM2: area,
          ratedPowerW: ratedPower,
          ratedIscA: ratedPower / wing.cellVmpV,
        });
      }
    }
    // Avoid unused warning while documenting count.
    void stringCountWing;
  }

  // Assign globally ordered string indices for stable tables.
  const stringIds = Array.from(new Set(cells.map((c) => c.stringId))).sort();
  for (const c of cells) c.stringIndex = stringIds.indexOf(c.stringId);

  return { cells, occluders, wingMatrices };
}

export interface RayHit {
  t: number;
  occluder: Occluder;
  point: Vec3;
  normal: Vec3;
}

function intersectBoxLocal(size: Vec3, origin: Vec3, dir: Vec3): number | null {
  const hx = size[0] / 2, hy = size[1] / 2, hz = size[2] / 2;
  let tmin = -Infinity;
  let tmax = Infinity;
  const bounds: Array<[number, number, number]> = [
    [origin[0], dir[0], hx],
    [origin[1], dir[1], hy],
    [origin[2], dir[2], hz],
  ];
  for (const [o, d, h] of bounds) {
    if (Math.abs(d) < 1e-12) {
      if (o < -h || o > h) return null;
    } else {
      let t1 = (-h - o) / d;
      let t2 = (h - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  if (tmax < 0) return null;
  return tmin > 0 ? tmin : tmax;
}

function intersectCylinderLocal(radius: number, height: number, origin: Vec3, dir: Vec3): number | null {
  const halfH = height / 2;
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  let best: number | null = null;
  const consider = (t: number) => {
    if (t > 1e-5 && (best === null || t < best)) best = t;
  };

  // Side: x^2 + z^2 = r^2.
  const a = dx * dx + dz * dz;
  const b = 2 * (ox * dx + oz * dz);
  const c = ox * ox + oz * oz - radius * radius;
  if (a > 1e-14) {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t > 1e-5) {
          const y = oy + dy * t;
          if (y >= -halfH && y <= halfH) consider(t);
        }
      }
    }
  }

  // Caps.
  if (Math.abs(dy) > 1e-12) {
    for (const yCap of [-halfH, halfH]) {
      const t = (yCap - oy) / dy;
      if (t > 1e-5) {
        const x = ox + dx * t;
        const z = oz + dz * t;
        if (x * x + z * z <= radius * radius + 1e-9) consider(t);
      }
    }
  }
  return best;
}

export function intersectOccluder(occ: Occluder, originBody: Vec3, dirBody: Vec3): RayHit | null {
  const origin = transformPoint(occ.inv, originBody);
  const dir = transformDirection(occ.inv, dirBody);
  let tLocal: number | null = null;
  let normalLocal: Vec3 = [0, 0, 1];
  if (occ.kind === 1) {
    tLocal = intersectCylinderLocal(occ.radius, occ.height, origin, dir);
    if (tLocal !== null) {
      const p: Vec3 = [origin[0] + dir[0] * tLocal, origin[1] + dir[1] * tLocal, origin[2] + dir[2] * tLocal];
      const halfH = occ.height / 2;
      if (Math.abs(p[1] - halfH) < 1e-5) normalLocal = [0, 1, 0];
      else if (Math.abs(p[1] + halfH) < 1e-5) normalLocal = [0, -1, 0];
      else normalLocal = normalize3([p[0], 0, p[2]]);
    }
  } else {
    tLocal = intersectBoxLocal(occ.size, origin, dir);
    if (tLocal !== null) {
      const p: Vec3 = [origin[0] + dir[0] * tLocal, origin[1] + dir[1] * tLocal, origin[2] + dir[2] * tLocal];
      const h = occ.size.map((v) => v / 2) as Vec3;
      const eps = 1e-4;
      if (Math.abs(p[0] - h[0]) < eps) normalLocal = [1, 0, 0];
      else if (Math.abs(p[0] + h[0]) < eps) normalLocal = [-1, 0, 0];
      else if (Math.abs(p[1] - h[1]) < eps) normalLocal = [0, 1, 0];
      else if (Math.abs(p[1] + h[1]) < eps) normalLocal = [0, -1, 0];
      else if (Math.abs(p[2] - h[2]) < eps) normalLocal = [0, 0, 1];
      else normalLocal = [0, 0, -1];
    }
  }
  if (tLocal === null || tLocal <= 0.002) return null;
  // Model has rotation/translation only in this app, so t is frame invariant.
  const pointBody = transformPoint(occ.model, [
    origin[0] + dir[0] * tLocal,
    origin[1] + dir[1] * tLocal,
    origin[2] + dir[2] * tLocal,
  ]);
  const normalBody = transformDirection(occ.model, normalLocal);
  return { t: tLocal, occluder: occ, point: pointBody, normal: normalBody };
}

function normalize3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function anyShadowHit(occluders: Occluder[], origin: Vec3, dir: Vec3): boolean {
  for (const occ of occluders) {
    if (intersectOccluder(occ, origin, dir)) return true;
  }
  return false;
}

/** Stratified cell sample points in body frame, shifted slightly along normal. */
export function cellSamplePoints(cell: CellRecord, samplesPerAxis: number): Vec3[] {
  const n = Math.max(1, samplesPerAxis);
  const points: Vec3[] = [];
  const offset = 0.008;
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      // Half-texel stratified grid; deterministic and stable for tests.
      const u = ((ix + 0.5) / n) * 2 - 1;
      const v = ((iy + 0.5) / n) * 2 - 1;
      points.push([
        cell.centerBody[0] + cell.axisUBody[0] * u * cell.halfU + cell.axisVBody[0] * v * cell.halfV + cell.normalBody[0] * offset,
        cell.centerBody[1] + cell.axisUBody[1] * u * cell.halfU + cell.axisVBody[1] * v * cell.halfV + cell.normalBody[1] * offset,
        cell.centerBody[2] + cell.axisUBody[2] * u * cell.halfU + cell.axisVBody[2] * v * cell.halfV + cell.normalBody[2] * offset,
      ]);
    }
  }
  return points;
}
