import { chromium } from 'playwright-core';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: process.env.HEADED === '1' ? false : true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack ?? e.message}`));

await page.goto('http://127.0.0.1:5174/#insolation', { waitUntil: 'networkidle' });
await page.waitForFunction(() => /WebGPU 三维|WebGPU 不可用/.test(document.querySelector('[data-role="backend"]')?.textContent ?? ''), null, { timeout: 30000 });
await page.waitForFunction(() => /计算后端/.test(document.querySelector('[data-role="stats"]')?.textContent ?? ''), null, { timeout: 30000 });
await page.waitForTimeout(1500);
const state = await page.evaluate(() => ({
  badge: document.querySelector('[data-role="backend"]')?.textContent,
  stats: document.querySelector('[data-role="stats"]')?.innerText,
  canvas: (() => { const c = document.querySelector('canvas'); return c ? { w: c.width, h: c.height } : null; })()
}));
console.log(JSON.stringify(state, null, 2));
await page.screenshot({ path: 'scripts/webgpu-insolation.png' });
console.log(logs.filter((l) => /error|pageerror|failed|WGSL/i.test(l)).join('\n') || 'NO_ERROR_LOGS');
await browser.close();
