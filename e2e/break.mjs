// Попытки сломать сеанс: «назад» во время счёта, смена камеры во время счёта, длинная подсказка на узком экране,
// «назад» во время загрузки и повторный вход, отказ в доступе к камере.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 5182;
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}/`;
const FILE = new URL('../test-videos/pushup_side.mjpeg', import.meta.url).pathname;
const server = process.env.BASE ? null : spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'ignore'] });
if (server) await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('Local') && r()));

const results = [];
const check = (name, ok, extra = '') => results.push({ name, ok, extra });
const fakeCam = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${FILE}`];

const browser = await chromium.launch({ headless: true, args: fakeCam });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const phase = () => page.evaluate(() => document.querySelector('.session')?.dataset.phase ?? null);

try {
  // 1–2. «назад» во время счёта сохраняет подход; кнопки смены камеры во время счёта нет
  await page.goto(BASE + '?delegate=CPU#/');
  await page.click('#start-pushup');
  await page.waitForFunction(() => document.querySelector('.session')?.dataset.phase === 'counting', null, { timeout: 120000 });
  const switchVisible = await page.evaluate(() => {
    const b = document.querySelector('[aria-label="Сменить камеру"]');
    return !!b && !b.classList.contains('hidden');
  });
  check('смены камеры нет во время счёта', !switchVisible);
  await page.waitForFunction(() => Number(document.querySelector('#counter')?.textContent) >= 1, null, { timeout: 60000 });
  await page.click('[aria-label="Назад"]');
  await page.waitForSelector('.summary', { timeout: 20000 });
  const saved = Number(await page.textContent('#sum-total'));
  check('«назад» во время счёта сохраняет подход', saved >= 1, `${saved} повт.`);

  // 3. длинная подсказка помещается в 390 px
  await page.goto(BASE + '?delegate=CPU#/session/pushup');
  await page.waitForFunction(() => document.querySelector('.session')?.dataset.phase === 'prepare', null, { timeout: 120000 });
  const box = await page.evaluate(() => {
    const tip = document.querySelector('#tip');
    tip.textContent = 'Прими упор лёжа боком к камере';
    tip.classList.remove('hidden');
    const r = tip.getBoundingClientRect();
    return { left: r.left, right: r.right };
  });
  check('длинная подсказка в пределах экрана', box.left >= 0 && box.right <= 390, `${Math.round(box.left)}…${Math.round(box.right)}`);

  // 4. «назад» во время загрузки и повторный вход
  const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  const p2 = await fresh.newPage();
  await p2.goto(BASE + '?delegate=CPU#/session/squat');
  await p2.waitForTimeout(150);
  await p2.click('[aria-label="Назад"]');
  await p2.waitForSelector('#start-squat');
  await p2.click('#start-squat');
  const seen = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    const st = await p2.evaluate(() => ({ ph: document.querySelector('.session')?.dataset.phase, txt: document.querySelector('.loading p')?.textContent }));
    if (st.txt) seen.add(st.txt);
    if (st.ph === 'prepare') break;
    await p2.waitForTimeout(100);
  }
  const ph2 = await p2.evaluate(() => document.querySelector('.session')?.dataset.phase);
  check('повторный вход после «назад» во время загрузки', ph2 === 'prepare', [...seen].filter((s) => /\d+%/.test(s)).slice(-2).join(' / '));
  await fresh.close();

  // 5. отказ в доступе к камере
  const denied = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await denied.grantPermissions([]);
  const p3 = await denied.newPage();
  await p3.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
  });
  await p3.goto(BASE + '?delegate=CPU#/session/squat');
  await p3.waitForSelector('.overlay.error:not(.hidden)', { timeout: 120000 });
  const msg = await p3.textContent('.overlay.error');
  check('отказ в камере — понятное сообщение', /Нет доступа к камере/.test(msg ?? ''));
  await denied.close();
  // 6. зависшая загрузка модели: первый запрос не отвечает, приложение повторяет попытку
  const stall = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  const p4 = await stall.newPage();
  let calls = 0;
  await p4.route('**/pose_landmarker_full.task', (route) => {
    calls += 1;
    if (calls === 1) return; // никогда не отвечаем
    return route.continue();
  });
  const texts = new Set();
  await p4.goto(BASE + '?delegate=CPU#/session/squat');
  const t1 = Date.now();
  while (Date.now() - t1 < 90000) {
    const st = await p4.evaluate(() => ({ ph: document.querySelector('.session')?.dataset.phase, txt: document.querySelector('.loading p')?.textContent }));
    if (st.txt) texts.add(st.txt);
    if (st.ph === 'prepare' || st.ph === 'error') break;
    await p4.waitForTimeout(250);
  }
  const ph4 = await p4.evaluate(() => document.querySelector('.session')?.dataset.phase);
  check('зависшая загрузка модели перезапускается', ph4 === 'prepare' && calls >= 2, `запросов ${calls}, ${[...texts].find((t) => t.includes('заново')) ?? 'без сообщения'}`);
  await stall.close();
} catch (e) {
  check('сценарий не упал', false, e.message);
}
await browser.close();
server?.kill();
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.extra ? ' — ' + r.extra : ''}`);
console.log('ошибки страницы:', errors.length ? errors : 'нет');
process.exit(results.every((r) => r.ok) ? 0 : 1);
