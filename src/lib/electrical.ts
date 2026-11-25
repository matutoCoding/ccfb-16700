import type { CellRecord, SolarWing, StringPowerResult } from '../types';
import { STANDARD_IRRADIANCE_WM2 } from './geometry';

export interface ArrayPowerBreakdown {
  totalW: number;
  strings: StringPowerResult[];
}

function wingMap(cells: CellRecord[], wings: SolarWing[]): Map<string, SolarWing> {
  const m = new Map<string, SolarWing>();
  for (const w of wings) m.set(w.id, w);
  for (const c of cells) {
    if (!m.has(c.wingId)) {
      // Defensive fallback if a persisted model lost its wing list.
      m.set(c.wingId, {
        id: c.wingId, name: c.wingName, position: [0, 0, 0], hingeAxis: [0, 0, 1],
        deploymentAngleDeg: 90, driveAngleDeg: 0, cols: 1, rows: 1,
        cellLengthM: 0.08, cellWidthM: 0.08, gapXM: 0.01, gapYM: 0.01, edgeMarginM: 0.02,
        cellEfficiency: 0.3, cellVmpV: 2.35, cellVocV: 2.7, cellsPerString: 0,
        bypassGroupSize: 6, bypassDiodeVoltageV: 0.35, bypassEnabled: true,
        stringDirection: 'column', mpptPerString: true, substrateColor: '#334155', cellColor: '#1d4ed8',
      });
    }
  }
  return m;
}

interface StringCellData {
  stringId: string;
  wingId: string;
  cells: CellRecord[];
  currents: number[];
  groups: Map<string, { indices: number[]; limitA: number; cellCount: number }>;
}

function collectStrings(
  cells: CellRecord[],
  irradianceWm2: number[],
): { strings: StringCellData[]; currentByCell: number[] } {
  const map = new Map<string, StringCellData>();
  const currentByCell = cells.map((cell, i) => {
    const g = Math.max(0, irradianceWm2[i] ?? 0) / STANDARD_IRRADIANCE_WM2;
    return Math.max(0, cell.ratedIscA * g);
  });

  cells.forEach((cell, i) => {
    let s = map.get(cell.stringId);
    if (!s) {
      s = { stringId: cell.stringId, wingId: cell.wingId, cells: [], currents: [], groups: new Map() };
      map.set(cell.stringId, s);
    }
    s.cells.push(cell);
    s.currents.push(currentByCell[i]);
    let group = s.groups.get(cell.bypassGroupId);
    if (!group) {
      group = { indices: [], limitA: Infinity, cellCount: 0 };
      s.groups.set(cell.bypassGroupId, group);
    }
    group.indices.push(i);
    group.cellCount++;
    group.limitA = Math.min(group.limitA, currentByCell[i]);
  });
  return { strings: Array.from(map.values()), currentByCell };
}

/**
 * Topology-aware series string solver.
 *
 * A candidate string current is selected at the weakest-cell current of each
 * bypass group. Groups whose limit is below that current are bypassed and
 * contribute a diode drop instead of their cell voltage. Consequently one
 * shaded cell either pulls an un-bypassed string to its current or removes
 * only its bypass subgroup's voltage. Uniform irradiance gives exactly linear
 * current scaling and therefore the cosine law to floating-point precision.
 */
export function evaluateArrayPower(
  model: { wings: SolarWing[] },
  cells: CellRecord[],
  irradianceWm2: number[],
): ArrayPowerBreakdown {
  const wings = wingMap(cells, model.wings);
  const { strings } = collectStrings(cells, irradianceWm2);
  const results: StringPowerResult[] = [];
  let totalW = 0;

  for (const s of strings) {
    const wing = wings.get(s.wingId)!;
    const groupList = Array.from(s.groups.values());
    const allCellCount = s.cells.length;
    const minCurrent = Math.min(...s.currents);
    const maxCurrent = Math.max(...s.currents);

    let best = {
      powerW: 0,
      currentA: 0,
      voltageV: 0,
      bypassedGroups: groupList.length,
    };

    const candidates = new Set<number>([0, minCurrent]);
    for (const g of groupList) candidates.add(g.limitA);
    // A small upper-near candidate helps numerical consumers and zero groups.
    candidates.add(maxCurrent);

    for (const I0 of candidates) {
      const I = Math.max(0, I0);
      if (!Number.isFinite(I)) continue;
      let activeCells = 0;
      let bypassed = 0;
      for (const g of groupList) {
        if (!wing.bypassEnabled || g.limitA + 1e-10 >= I) {
          activeCells += g.cellCount;
        } else {
          bypassed++;
        }
      }

      let voltage: number;
      if (!wing.bypassEnabled) {
        // Without bypass diodes the whole series string is current-limited by
        // its weakest cell. Evaluate at that current only.
        if (I > minCurrent + 1e-9) continue;
        voltage = allCellCount * wing.cellVmpV;
      } else {
        voltage = activeCells * wing.cellVmpV - bypassed * wing.bypassDiodeVoltageV;
      }
      const power = I * Math.max(0, voltage);
      if (power > best.powerW + 1e-12) {
        best = { powerW: power, currentA: I, voltageV: Math.max(0, voltage), bypassedGroups: bypassed };
      }
    }

    // Independent MPPT per string is the default and most capable topology.
    // If a model explicitly disables it, strings are still reported separately
    // for diagnostics while the array-level MPP approximation uses their sum;
    // the settings page documents this as distributed string MPPT.
    const result: StringPowerResult = {
      stringId: s.stringId,
      wingId: s.wingId,
      currentA: best.currentA,
      voltageV: best.voltageV,
      powerW: best.powerW,
      bypassedGroups: best.bypassedGroups,
      totalGroups: groupList.length,
      minIlluminationRatio: minCurrent / Math.max(1e-9, Math.max(...cells
        .filter((c) => c.stringId === s.stringId)
        .map((c) => c.ratedIscA))),
    };
    results.push(result);
    totalW += result.powerW;
  }

  results.sort((a, b) => a.stringId.localeCompare(b.stringId));
  return { totalW, strings: results };
}

export function evaluateComponentPowers(
  model: { wings: SolarWing[] },
  cells: CellRecord[],
  direct: number[],
  albedo: number[],
  bounce: number[],
): { directW: number; albedoW: number; bounceW: number; totalW: number; strings: StringPowerResult[] } {
  const directResult = evaluateArrayPower(model, cells, direct);
  const directAlbedo = direct.map((v, i) => v + (albedo[i] ?? 0));
  const daResult = evaluateArrayPower(model, cells, directAlbedo);
  const totalIrr = direct.map((v, i) => v + (albedo[i] ?? 0) + (bounce[i] ?? 0));
  const totalResult = evaluateArrayPower(model, cells, totalIrr);
  return {
    directW: directResult.totalW,
    albedoW: Math.max(0, daResult.totalW - directResult.totalW),
    bounceW: Math.max(0, totalResult.totalW - daResult.totalW),
    totalW: totalResult.totalW,
    strings: totalResult.strings,
  };
}

export interface CosineCheckResult {
  maxErrorPct: number;
  passed: boolean;
  samples: number;
  details: Array<{ angleDeg: number; expectedW: number; actualW: number; errorPct: number }>;
}

/**
 * Analytic acceptance check: a completely unshaded planar string must follow
 * P(theta)=P0 cos(theta) within 0.5%.
 */
export function cosineLawSelfCheck(cellCount = 24, cellVmp = 2.35, ratedPowerPerCell = 1.2): CosineCheckResult {
  const cells: CellRecord[] = Array.from({ length: cellCount }, (_, i) => ({
    cellId: `check_${i}`, wingId: 'check', wingName: 'check', index: i,
    col: i, row: 0, stringId: 'check_string', stringIndex: 0, bypassGroupId: 'check_bp',
    centerBody: [0, 0, 0], normalBody: [0, 0, 1], axisUBody: [1, 0, 0], axisVBody: [0, 1, 0],
    halfU: 0.04, halfV: 0.04, areaM2: 0.003, ratedPowerW: ratedPowerPerCell,
    ratedIscA: ratedPowerPerCell / cellVmp,
  }));
  const model = {
    wings: [{
      id: 'check', bypassEnabled: true, bypassGroupSize: 6, cellsPerString: cellCount,
      cellVmpV: cellVmp, bypassDiodeVoltageV: 0.35, mpptPerString: true,
    } as unknown as SolarWing],
  };
  const p0 = cellCount * ratedPowerPerCell;
  const angles = [0, 15, 30, 45, 60, 75, 82];
  const details = angles.map((angleDeg) => {
    const theta = (angleDeg * Math.PI) / 180;
    const irr = STANDARD_IRRADIANCE_WM2 * Math.cos(theta);
    const actual = evaluateArrayPower(model, cells, cells.map(() => irr)).totalW;
    const expected = p0 * Math.cos(theta);
    const errorPct = expected > 1e-6 ? Math.abs(actual - expected) / expected * 100 : 0;
    return { angleDeg, expectedW: expected, actualW: actual, errorPct };
  });
  const maxErrorPct = Math.max(...details.map((d) => d.errorPct));
  return { maxErrorPct, passed: maxErrorPct < 0.5, samples: details.length, details };
}
