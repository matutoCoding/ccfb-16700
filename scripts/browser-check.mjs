import { chromium } from 'playwright-core';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.env.URL ?? 'http://127.0.0.1:5174';

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--use-angle=d3d11',
    '--ignore-gpu-blocklist',
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.stack || err.message}`));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
const gpuInfo = await page.evaluate(async () => {
  if (!navigator.gpu) return { gpu: false };
  const adapter = await navigator.gpu.requestAdapter();
  return { gpu: true, adapter: !!adapter, info: adapter?.info ? { ...adapter.info } : null };
});

await page.waitForTimeout(1200);
await page.screenshot({ path: 'webgpu-config-check.png' });

await page.getByRole('button', { name: /受照推演/ }).first().click();
await page.waitForTimeout(200);
await page.getByRole('button', { name: /运行整轨推演/ }).click();
await page.waitForFunction(() => {
  const text = document.querySelector('.stat-grid')?.textContent ?? '';
  return /ms/.test(text) && !text.includes('推演中…');
}, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(500);

await page.evaluate(() => {
  const slider = document.querySelector('#timeline');
  if (slider) {
    slider.value = '290';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
await page.waitForTimeout(500);
await page.screenshot({ path: 'webgpu-sim-peak-check.png' });
await page.screenshot({ path: 'webgpu-sim-check.png' });

const sim = await page.evaluate(() => ({
  stats: [...document.querySelectorAll('.stat .stat-value')].map((e) => e.textContent),
  engine: document.querySelector('.stat .stat-value')?.textContent,
  strings: document.querySelectorAll('#string-table-wrap tbody tr').length,
  readout: document.querySelector('#epoch-readout')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 500),
  firstStringRow: document.querySelector('#string-table-wrap tbody tr')?.textContent,
  errors: [...document.querySelectorAll('.toast-error')].map((e) => e.textContent),
}));

await page.getByRole('button', { name: /发电曲线/ }).first().click();
await page.waitForTimeout(300);
const chart = await page.evaluate(() => ({ svg: !!document.querySelector('.chart-svg'), paths: document.querySelectorAll('.chart-svg path').length }));

console.log(JSON.stringify({ gpuInfo, sim, chart, logs: logs.slice(-30) }, null, 2));
await browser.close();
if (sim.errors?.length || logs.some((l) => l.includes('[pageerror]') || l.includes('Shader') || l.includes('WGSL'))) process.exit(1);
