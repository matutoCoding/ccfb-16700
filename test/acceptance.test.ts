import { describe, expect, it } from 'vitest';
import { cosineLawSelfCheck, evaluateArrayPower } from '../src/lib/electrical';
import { createDefaultPlan, createSatellite500 } from '../src/lib/defaults';
import { prepareGeometry } from '../src/lib/geometry';
import { runSimulation } from '../src/lib/simulation';

describe('electrical acceptance', () => {
  it('matches cosine law without shadows within 0.5 percent', () => {
    const check = cosineLawSelfCheck();
    expect(check.maxErrorPct).toBeLessThan(0.5);
    expect(check.passed).toBe(true);
  });

  it('one blocked cell limits an un-bypassed string but not a bypassed group', () => {
    const plan = createDefaultPlan();
    const prepared = prepareGeometry(plan.model);
    const stringId = prepared.cells[0].stringId;
    const stringCells = prepared.cells.filter((c) => c.stringId === stringId);
    const uniform = stringCells.map(() => 1000);
    const blocked = stringCells.map((_, i) => (i === 0 ? 120 : 1000));

    const bypassModel = plan.model;
    const bypassed = evaluateArrayPower(bypassModel, stringCells, blocked);
    const uniformPower = evaluateArrayPower(bypassModel, stringCells, uniform).totalW;
    // One 7-cell bypass subgroup is removed, so roughly half string voltage
    // remains instead of bottlenecking all 14 cells to the shaded current.
    expect(bypassed.totalW).toBeGreaterThan(uniformPower * 0.43);
    expect(bypassed.totalW).toBeLessThan(uniformPower * 0.56);
    expect(bypassed.strings[0].bypassedGroups).toBeGreaterThan(0);

    const noBypassModel = structuredClone(plan.model);
    for (const w of noBypassModel.wings) w.bypassEnabled = false;
    const limited = evaluateArrayPower(noBypassModel, stringCells, blocked);
    const expectedMinCurrent = Math.min(...stringCells.map((c) => c.ratedIscA * 120 / 1361));
    expect(limited.strings[0].currentA).toBeCloseTo(expectedMinCurrent, 5);
    expect(limited.totalW).toBeLessThan(uniformPower * 0.2);
  });
});

describe('simulation smoke and budget', () => {
  it('builds two demo geometries', () => {
    const p500 = prepareGeometry(createSatellite500());
    expect(p500.cells.length).toBe(224);
    expect(p500.occluders.length).toBeGreaterThan(5);
  });

  it('runs a full orbit on CPU without errors', async () => {
    const plan = createDefaultPlan();
    plan.settings.multiBounceEnabled = false;
    const t0 = performance.now();
    const r = await runSimulation(plan, { forceEngine: 'cpu' });
    const wall = performance.now() - t0;
    console.log('CPU direct simulation', { epochs: r.epochCount, cells: r.cellCount, ms: r.elapsedMs, wall });
    expect(r.epochs.length).toBeGreaterThan(30);
    expect(r.cellCount).toBe(224);
    expect(r.epochs.every((e) => Number.isFinite(e.totalPowerW))).toBe(true);
    expect(r.cosineCheck.passed).toBe(true);
  }, 20000);
});
