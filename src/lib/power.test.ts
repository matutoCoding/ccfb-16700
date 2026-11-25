import { describe, expect, it } from 'vitest';
import { cosineSelfTest, buildTopology, arrayPower } from './power';
import { createLargeSatelliteCase, createSmallSatelliteCase } from '../data/presets';
import { buildGeometry, validateCellCounts } from './geometry';

describe('electrical acceptance', () => {
  it('matches cosine law within 0.5% for unshaded uniform cells', () => {
    const cfg = createLargeSatelliteCase().electrical;
    const report = cosineSelfTest(cfg, 192);
    expect(report.maxRelativeErrorPct).toBeLessThan(0.5);
    expect(report.passed).toBe(true);
  });

  it('bypasses a shaded group instead of linearly scaling the whole string', () => {
    const scenario = createLargeSatelliteCase();
    const { cells } = buildGeometry(scenario.geometry);
    const specs = scenario.geometry.arrays.flatMap((a) =>
      a.strings.map((s) => ({ id: `${a.id}:${s.id}`, name: s.name, bypassGroupSize: s.bypassGroupSize }))
    );
    const topology = buildTopology(cells, specs);
    const firstString = topology[0];
    const uniform = new Map(cells.map((c) => [c.cellId, scenario.electrical.referenceIrradiance]));
    const normal = arrayPower(topology, uniform, scenario.electrical);

    // Shade one cell in the first bypass group to 5% irradiance.
    const shadedCell = firstString.cells[0];
    const shaded = new Map(uniform);
    shaded.set(shadedCell.cellId, scenario.electrical.referenceIrradiance * 0.05);
    const faulted = arrayPower(topology, shaded, scenario.electrical);
    const stringResult = faulted.strings.find((s) => s.stringId === firstString.stringId)!;

    expect(stringResult.bypassedGroups).toBeGreaterThan(0);
    // Naive area scaling would retain ~99.5% string power; bypass topology must be materially lower.
    expect(stringResult.powerW).toBeLessThan(normal.strings[0].powerW * 0.94);
  });
});

describe('built-in satellite configurations', () => {
  it('has valid cell/string counts for both 500 kg and 50 kg class', () => {
    for (const c of [createLargeSatelliteCase(), createSmallSatelliteCase()]) {
      expect(validateCellCounts(c.geometry)).toEqual([]);
      const g = buildGeometry(c.geometry);
      expect(g.cells.length).toBeGreaterThan(0);
      expect(g.occluders.length).toBeGreaterThan(0);
    }
  });
});
