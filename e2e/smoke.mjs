// Дымовая проверка собранной версии (dist/) под её настоящей политикой безопасности.
// Запуск: npm run build && node e2e/smoke.mjs. Выполняется и в публикации на GitHub перед выкладкой.
// Проверяет: главная открывается; модель грузится и камера включается (подготовка к подходу);
// история открывается; нет ни запросов к другим сайтам, ни нарушений политики, ни ошибок страницы.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 5186;
const BASE = `http://127.0.0.1:${PORT}/`;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite preview не запустился')), 30000);
  server.stdout.on('data', (d) => String(d).includes('Local') && (clearTimeout(t), resolve()));
});

const problems = [];
const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
const page = await ctx.newPage();
await page.addInitScript(() => {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
});
const external = [];
page.on('request', (r) => {
  const u = new URL(r.url());
  if (!['http:', 'https:'].includes(u.protocol)) return;
  if (u.hostname !== '127.0.0.1') external.push(r.url());
});
page.on('pageerror', (e) => problems.push('ошибка страницы: ' + e.message));

try {
  const csp = await (await fetch(BASE)).text();
  if (!/http-equiv="Content-Security-Policy" content="default-src 'none'/.test(csp)) problems.push('в собранной странице нет строгой политики безопасности');

  await page.goto(BASE + '#/');
  await page.waitForSelector('#start-squat', { timeout: 20000 });
  await page.click('#start-squat');
  await page.waitForFunction(() => ['prepare', 'error'].includes(document.querySelector('.session')?.dataset.phase ?? ''), null, { timeout: 180000 });
  const phase = await page.evaluate(() => document.querySelector('.session')?.dataset.phase);
  if (phase !== 'prepare') problems.push('подготовка не началась: ' + (await page.textContent('.overlay.error')));
  await page.waitForTimeout(2000);
  if (await page.evaluate(() => 'window' in globalThis && '__povtor' in window)) problems.push('окно отладки __povtor открыто без ?dev');

  await page.goto(BASE + '#/history');
  await page.waitForSelector('.history-body .empty, .setlist', { timeout: 20000 });

  const violations = await page.evaluate(() => window.__csp);
  if (violations.length) problems.push('нарушения политики безопасности: ' + violations.join(', '));
  if (external.length) problems.push('запросы к другим сайтам: ' + external.join(', '));
} catch (e) {
  problems.push(String(e));
} finally {
  await browser.close();
  server.kill();
}

console.log(problems.length ? 'FAIL\n' + problems.map((p) => '  ' + p).join('\n') : 'OK   сборка: модель, камера, история; внешних запросов и нарушений политики нет');
process.exit(problems.length ? 1 : 0);
