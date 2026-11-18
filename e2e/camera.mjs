// Дымовой тест настоящего пути «камера → модель → счёт» на фейковой камере Chrome.
// Камера отдаёт зацикленный MJPEG, подход идёт в реальном времени, поэтому это проверка работоспособности, а не точности.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 5181;
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}/`;
const FILE = new URL('../test-videos/pushup_side.mjpeg', import.meta.url).pathname;

// BASE=https://… — проверка опубликованной версии, локальный сервер не нужен
const server = process.env.BASE ? null : spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'ignore'] });
if (server) await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('Local') && r()));

const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${FILE}`, '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, permissions: ['camera'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const external = [];
page.on('request', (r) => {
  const u = new URL(r.url());
  if (!['127.0.0.1', 'localhost', new URL(BASE).hostname].includes(u.hostname) && !u.protocol.startsWith('blob') && !u.protocol.startsWith('data')) external.push(r.url());
});
let code = 0;
try {
  await page.goto(BASE + '?dev&delegate=CPU#/');
  await page.click('#start-pushup');
  await page.waitForFunction(() => document.querySelector('.session')?.dataset.phase === 'prepare', null, { timeout: 120000 });
  console.log('камера включена, подготовка');
  await page.waitForFunction(() => document.querySelector('.session')?.dataset.phase === 'counting', null, { timeout: 60000 });
  console.log('отсчёт прошёл, идёт счёт');
  await page.waitForTimeout(25000);
  const fps = await page.evaluate(() => window.__povtor.fps);
  await page.click('#finish');
  await page.waitForSelector('.summary', { timeout: 30000 });
  const total = Number(await page.textContent('#sum-total').catch(() => '0'));
  const clean = Number(await page.textContent('#sum-clean').catch(() => '0'));
  console.log(`итог: ${total} повторений, ${clean} чистых, обработка ~${fps} кадров/с`);
  await page.click('text=История');
  await page.waitForSelector('.setlist li');
  const rows = await page.$$eval('.setlist li', (els) => els.map((e) => e.textContent));
  console.log('история:', rows);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  const path = await download.path();
  const { readFileSync } = await import('node:fs');
  const csv = readFileSync(path, 'utf8');
  console.log('CSV:', JSON.stringify(csv.slice(0, 200)));
  if (total < 2) code = 1;
} catch (e) {
  console.error('ОШИБКА', e.message);
  await page.screenshot({ path: new URL('./out/camera-fail.png', import.meta.url).pathname });
  code = 1;
}
console.log('ошибки страницы:', errors.length ? errors : 'нет');
console.log('запросы к другим сайтам:', external.length ? external : 'нет');
await browser.close();
server?.kill();
process.exit(code);
