import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.stack || e.message));
await page.goto(process.env.URL ?? 'http://127.0.0.1:5174', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__solarView, { timeout: 10000 });

const result = await page.evaluate(async () => {
  const api = window.__solarView;
  const plan = api.store.state.plan;
  plan.settings.bounceRaysPerCell = 32;
  plan.settings.bounceCount = 1;
  const gpu = await api.runSimulation(structuredClone(plan), { forceEngine: 'webgpu' });
  const cpu = await api.runSimulation(structuredClone(plan), { forceEngine: 'cpu' });
  let maxPowerDiff = 0;
  let maxLitDiff = 0;
  let maxBounceDiff = 0;
  let maxI = 0;
  let maxC = 0;
  let maxBI = 0;
  let maxBC = 0;
  for (let i = 0; i < gpu.epochs.length; i++) {
    maxPowerDiff = Math.max(maxPowerDiff, Math.abs(gpu.epochs[i].totalPowerW - cpu.epochs[i].totalPowerW));
    const gc = gpu.epochs[i].cellIllumination;
    const cc = cpu.epochs[i].cellIllumination;
    for (let j = 0; j < gc.length; j++) {
      const d = Math.abs(gc[j].litFraction - cc[j].litFraction);
      if (d > maxLitDiff) { maxLitDiff = d; maxI = i; maxC = j; }
      const bd = Math.abs(gc[j].bounceWm2 - cc[j].bounceWm2);
      if (bd > maxBounceDiff) { maxBounceDiff = bd; maxBI = i; maxBC = j; }
    }
  }
  return {
    gpuEngine: gpu.engine, cpuEngine: cpu.engine,
    gpuMs: Math.round(gpu.elapsedMs), cpuMs: Math.round(cpu.elapsedMs),
    epochs: gpu.epochCount, cells: gpu.cellCount,
    maxPowerDiff: Number(maxPowerDiff.toFixed(4)),
    maxLitDiff: Number(maxLitDiff.toFixed(4)),
    maxBounceDiff: Number(maxBounceDiff.toFixed(3)),
    bounceAt: { epoch: maxBI, cell: maxBC, gpu: gpu.epochs[maxBI].cellIllumination[maxBC].bounceWm2, cpu: cpu.epochs[maxBI].cellIllumination[maxBC].bounceWm2 },
    at: { epoch: maxI, cell: maxC, gpu: gpu.epochs[maxI].cellIllumination[maxC], cpu: cpu.epochs[maxI].cellIllumination[maxC] },
  };
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
if (result.gpuEngine !== 'webgpu' || result.maxLitDiff > 0.08 || result.maxPowerDiff > 25) process.exit(1);
