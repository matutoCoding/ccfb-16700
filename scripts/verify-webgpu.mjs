import { chromium } from 'playwright-core';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.argv[2] ?? 'http://127.0.0.1:5174/#settings';

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: process.env.HEADED === '1' ? false : true,
  args: [
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--enable-unsafe-webgpu',
    '--enable-webgpu-developer-features',
    '--ignore-gpu-blocklist'
  ]
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const logs = [];
page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.stack ?? err.message}`));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const gpu = await page.evaluate(async () => {
  if (!navigator.gpu) return { gpu: false, adapter: false };
  const adapter = await navigator.gpu.requestAdapter();
  return { gpu: true, adapter: !!adapter, info: adapter?.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture } : null };
});
console.log('GPU', JSON.stringify(gpu));

if (gpu.adapter) {
  await page.click('[data-action="cosine"]');
  await page.waitForFunction(() => /最大相对误差/.test(document.querySelector('[data-role="validation"]')?.textContent ?? ''), null, { timeout: 30000 });
  console.log('COSINE\n', (await page.locator('[data-role="validation"]').innerText()).slice(0, 1200));

  await page.click('[data-action="benchmark"]');
  await page.waitForFunction(() => /页面端到端|基准失败/.test(document.querySelector('[data-role="validation"]')?.textContent ?? ''), null, { timeout: 30000 });
  console.log('BENCH\n', (await page.locator('[data-role="validation"]').innerText()).slice(0, 1200));
}

console.log('LOGS\n' + logs.filter((l) => /error|warning|pageerror|WebGPU|failed/i.test(l)).join('\n'));
await browser.close();
