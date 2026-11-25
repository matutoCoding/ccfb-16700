import type { CellRecord, ElectricalConfig, StringPower } from '../types';

export interface ElectricalGroup {
  stringId: string;
  groupIndex: number;
  cells: CellRecord[];
}

export interface ElectricalStringTopology {
  stringId: string;
  name: string;
  cells: CellRecord[];
  groups: CellRecord[][];
}

export function buildTopology(cells: CellRecord[], geometryStrings?: Array<{ id: string; name: string; bypassGroupSize: number }>): ElectricalStringTopology[] {
  const byString = new Map<string, CellRecord[]>();
  for (const c of cells) {
    if (!byString.has(c.stringId)) byString.set(c.stringId, []);
    byString.get(c.stringId)!.push(c);
  }
  const result: ElectricalStringTopology[] = [];
  for (const [stringId, list] of byString) {
    list.sort((a, b) => a.indexInArray - b.indexInArray);
    const spec = geometryStrings?.find((s) => s.id === stringId);
    const groupSize = spec?.bypassGroupSize ?? Math.max(1, Math.floor(list.length / 4));
    const groups: CellRecord[][] = [];
    for (let i = 0; i < list.length; i += groupSize) groups.push(list.slice(i, i + groupSize));
    result.push({ stringId, name: spec?.name ?? stringId, cells: list, groups });
  }
  return result;
}

function cellCurrentA(irradianceWm2: number, cfg: ElectricalConfig): number {
  const g = Math.max(0, irradianceWm2) / cfg.referenceIrradiance;
  // MPP current is represented as a linear photogenerated current source.
  return cfg.referenceCurrentA * g * (1 + cfg.temperatureCoefficient * 0);
}

export function solveString(
  topology: ElectricalStringTopology,
  irradianceByCellId: Map<string, number>,
  cfg: ElectricalConfig
): StringPower {
  const groupCaps = topology.groups.map((group) => {
    let cap = Infinity;
    let limiting: CellRecord | null = null;
    for (const cell of group) {
      const i = cellCurrentA(irradianceByCellId.get(cell.cellId) ?? 0, cfg);
      if (i < cap) {
        cap = i;
        limiting = cell;
      }
    }
    return { cap: Number.isFinite(cap) ? cap : 0, limiting };
  });

  if (!topology.cells.length || groupCaps.every((g) => g.cap <= 1e-8)) {
    return {
      stringId: topology.stringId,
      name: topology.name,
      currentA: 0,
      voltageV: 0,
      powerW: 0,
      bypassedGroups: topology.groups.length,
      totalGroups: topology.groups.length,
      limitingCell: groupCaps.find((g) => g.limiting)?.limiting?.cellId ?? null
    };
  }

  const candidates = Array.from(new Set(groupCaps.map((g) => g.cap).filter((x) => x > 1e-8)));
  let best: StringPower = {
    stringId: topology.stringId,
    name: topology.name,
    currentA: 0,
    voltageV: 0,
    powerW: 0,
    bypassedGroups: topology.groups.length,
    totalGroups: topology.groups.length,
    limitingCell: null
  };

  for (const candidateCap of candidates) {
    // Evaluate exactly at the knee and a hair below; the latter is the physically safe MPP side.
    for (const factor of [1, 0.999, 0.992]) {
      const current = candidateCap * factor;
      let activeCells = 0;
      let bypassed = 0;
      let limitingCell: string | null = null;
      let minCap = Infinity;
      groupCaps.forEach((g, idx) => {
        if (g.cap + 1e-9 >= current) {
          activeCells += topology.groups[idx]?.length ?? 0;
          if (g.cap < minCap) {
            minCap = g.cap;
            limitingCell = g.limiting?.cellId ?? null;
          }
        } else {
          bypassed += 1;
        }
      });
      const voltage = activeCells * cfg.mppCellVoltageV - bypassed * cfg.bypassDiodeDropV;
      const power = Math.max(0, current * voltage);
      if (power > best.powerW + 1e-9) {
        best = {
          stringId: topology.stringId,
          name: topology.name,
          currentA: current,
          voltageV: voltage,
          powerW: power,
          bypassedGroups: bypassed,
          totalGroups: topology.groups.length,
          limitingCell
        };
      }
    }
  }
  return best;
}

export function arrayPower(
  topologies: ElectricalStringTopology[],
  irradianceByCellId: Map<string, number>,
  cfg: ElectricalConfig
): { strings: StringPower[]; totalW: number } {
  const strings = topologies.map((t) => solveString(t, irradianceByCellId, cfg));
  return { strings, totalW: strings.reduce((s, x) => s + x.powerW, 0) };
}

export function analyticCosinePowerW(thetaDeg: number, cellCount: number, cfg: ElectricalConfig): number {
  return cellCount * cfg.referenceCurrentA * cfg.mppCellVoltageV * Math.cos((thetaDeg * Math.PI) / 180);
}

export function cosineSelfTest(cfg: ElectricalConfig, cellCount = 96) {
  const angles = [0, 10, 20, 30, 45, 60, 75, 85];
  const points = angles.map((angleDeg) => {
    const g = cfg.referenceIrradiance * Math.cos((angleDeg * Math.PI) / 180);
    const cells: CellRecord[] = Array.from({ length: cellCount }, (_, i) => ({ cellId: `T${i}` } as CellRecord));
    const topology = buildTopology(cells, [{ id: 's', name: 'S', bypassGroupSize: 12 }])[0];
    const map = new Map<string, number>(cells.map((c) => [c.cellId, g]));
    const s = solveString(topology, map, cfg);
    const analyticW = analyticCosinePowerW(angleDeg, cellCount, cfg);
    const errorPct = Math.abs((s.powerW - analyticW) / analyticW) * 100;
    return { angleDeg, simulatedW: s.powerW, analyticW, errorPct };
  });
  const maxRelativeErrorPct = Math.max(...points.map((p) => p.errorPct));
  return { points, maxRelativeErrorPct, passed: maxRelativeErrorPct < 0.5 };
}
