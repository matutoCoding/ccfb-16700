import type { CellRecord, OccluderRuntime, Primitive, SatelliteConfig, Vec3 } from '../types';
import { composeMatrix, invertMat4, quatFromAxisAngle, quatFromEulerDeg, quatMultiply, rotateVec, scale, add } from './math';

export interface BuiltGeometry {
  cells: CellRecord[];
  occluders: OccluderRuntime[];
  radiusM: number;
  panelOccluderByArray: Record<string, number>;
}

function primitiveQuaternion(p: Primitive) {
  return quatFromEulerDeg(p.rotationDeg);
}

export function buildOccluders(config: SatelliteConfig): OccluderRuntime[] {
  const out: OccluderRuntime[] = [];
  for (const p of config.primitives) {
    if (!p.occluder) continue;
    const q = primitiveQuaternion(p);
    if (p.kind === 'cylinder') {
      const radius = p.dimensions[0];
      const length = p.dimensions[1];
      const model = composeMatrix(p.position, q, [1, 1, 1]);
      out.push({
        sourceId: p.id,
        name: p.name,
        kind: 1,
        model,
        inverse: invertMat4(model),
        radius,
        length,
        reflectivity: p.reflectivity
      });
    } else {
      const dims: Vec3 = p.kind === 'plate'
        ? [p.dimensions[0], p.dimensions[1], Math.max(0.02, p.dimensions[2] || 0.04)]
        : p.dimensions;
      const model = composeMatrix(p.position, q, dims);
      out.push({
        sourceId: p.id,
        name: p.name,
        kind: 0,
        model,
        inverse: invertMat4(model),
        radius: 0,
        length: 0,
        reflectivity: p.reflectivity
      });
    }
  }

  for (const a of config.arrays) {
    const qHinge = quatFromAxisAngle(a.hingeAxis, (a.hingeAngleDeg * Math.PI) / 180);
    const qDrive = quatFromAxisAngle(a.driveAxisLocal, (a.driveAngleDeg * Math.PI) / 180);
    const q = quatMultiply(qHinge, qDrive);
    const width = a.layout.cols * a.layout.cellWidth + Math.max(0, a.layout.cols - 1) * a.layout.gapX;
    const height = a.layout.rows * a.layout.cellHeight + Math.max(0, a.layout.rows - 1) * a.layout.gapY;
    const centerLocal = a.layout.centerOffset;
    const centerBody = add(a.rootPosition, rotateVec(q, centerLocal));
    const model = composeMatrix(centerBody, q, [width, height, a.panelThickness]);
    out.push({
      sourceId: a.id,
      name: a.name,
      kind: 0,
      model,
      inverse: invertMat4(model),
      radius: 0,
      length: 0,
      reflectivity: a.reflectivity
    });
  }
  return out;
}

export function buildGeometry(config: SatelliteConfig): BuiltGeometry {
  const occluders = buildOccluders(config);
  const panelOccluderByArray: Record<string, number> = {};
  // Panel occluders are appended after every primitive occluder in the same order.
  const primitiveOccluderCount = config.primitives.filter((p) => p.occluder).length;
  config.arrays.forEach((a, i) => {
    panelOccluderByArray[a.id] = primitiveOccluderCount + i;
  });

  const cells: CellRecord[] = [];
  for (const array of config.arrays) {
    const qHinge = quatFromAxisAngle(array.hingeAxis, (array.hingeAngleDeg * Math.PI) / 180);
    const qDrive = quatFromAxisAngle(array.driveAxisLocal, (array.driveAngleDeg * Math.PI) / 180);
    const q = quatMultiply(qHinge, qDrive);
    const uAxis = rotateVec(q, array.layout.axisU);
    const vAxis = rotateVec(q, array.layout.axisV);
    const normal = rotateVec(q, array.layout.normal);
    const centerOffsetBody = rotateVec(q, array.layout.centerOffset);
    const stringBounds: Array<{ id: string; start: number; end: number }> = [];
    let cursor = 0;
    for (const s of array.strings) {
      stringBounds.push({ id: `${array.id}:${s.id}`, start: cursor, end: cursor + s.cellCount });
      cursor += s.cellCount;
    }

    for (let r = 0; r < array.layout.rows; r++) {
      for (let c = 0; c < array.layout.cols; c++) {
        const indexInArray = r * array.layout.cols + c;
        const u = (c - (array.layout.cols - 1) / 2) * (array.layout.cellWidth + array.layout.gapX);
        const v = (r - (array.layout.rows - 1) / 2) * (array.layout.cellHeight + array.layout.gapY);
        const localOffset = add(scale(array.layout.axisU, u), scale(array.layout.axisV, v));
        const offset = add(centerOffsetBody, rotateVec(q, localOffset));
        // Cell centers sit on the outer faces of the honeycomb panel, not inside its thickness.
        const surfaceOffset = scale(normal, array.panelThickness / 2 + 0.004);
        const center = add(add(array.rootPosition, offset), surfaceOffset);
        const string = stringBounds.find((b) => indexInArray >= b.start && indexInArray < b.end);
        const w = array.layout.cellWidth;
        const h = array.layout.cellHeight;
        cells.push({
          cellId: `${array.id}-C${String(indexInArray + 1).padStart(3, '0')}`,
          arrayId: array.id,
          stringId: string?.id ?? `${array.id}:${array.strings[0]?.id ?? 'unassigned'}`,
          indexInArray,
          row: r,
          col: c,
          centerBody: center,
          normalBody: normal,
          tangentU: uAxis,
          tangentV: vAxis,
          width: w,
          height: h,
          areaM2: w * h,
          selfOccluder: panelOccluderByArray[array.id] ?? 0xffff
        });
      }
    }
  }

  const allPoints = [
    ...config.primitives.map((p) => p.position),
    ...cells.map((c) => c.centerBody)
  ];
  const radiusM = Math.max(2.5, ...allPoints.map((p) => Math.hypot(p[0], p[1], p[2]) * 2.2));
  return { cells, occluders, radiusM, panelOccluderByArray };
}

export function validateCellCounts(config: SatelliteConfig): string[] {
  const errors: string[] = [];
  for (const a of config.arrays) {
    const grid = a.layout.rows * a.layout.cols;
    const specified = a.strings.reduce((n, s) => n + s.cellCount, 0);
    if (grid !== specified) {
      errors.push(`${a.name}: 网格 ${grid} 片与灯串总数 ${specified} 不一致`);
    }
    for (const s of a.strings) {
      if (s.bypassGroupSize <= 0 || s.cellCount % s.bypassGroupSize !== 0) {
        errors.push(`${a.name}/${s.name}: 每串片数必须是旁路组长度的整数倍`);
      }
    }
  }
  return errors;
}
