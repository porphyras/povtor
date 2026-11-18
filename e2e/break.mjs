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

  // 4. «На главную» во время загрузки и повторный вход. Нажимаем, пока идёт загрузка, и проверяем, что это так.
  const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  const p2 = await fresh.newPage();
  await p2.goto(BASE + '?delegate=CPU#/session/squat');
  await p2.waitForSelector('#loading-home', { state: 'visible' });
  const phAtClick = await p2.evaluate(() => {
    const ph = document.querySelector('.session')?.dataset.phase;
    document.querySelector('#loading-home').click();
    return ph;
  });
  await p2.waitForSelector('#start-squat');
  check('«На главную» нажимается во время загрузки', phAtClick === 'loading', `фаза в момент нажатия: ${phAtClick}`);
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
  // 7. системная «назад» во время счёта сохраняет подход; 8. отключение камеры во время счёта — тоже
  for (const [name, act] of [
    ['системная «назад» во время счёта сохраняет подход', (pg) => pg.evaluate(() => history.back())],
    ['отключение камеры во время счёта сохраняет подход', (pg) => pg.evaluate(() => document.querySelector('video').srcObject.getVideoTracks()[0].dispatchEvent(new Event('ended')))],
  ]) {
    const c2 = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
    const pg = await c2.newPage();
    await pg.goto(BASE + '?delegate=CPU#/');
    await pg.click('#start-pushup');
    await pg.waitForFunction(() => Number(document.querySelector('#counter')?.textContent) >= 1, null, { timeout: 150000 });
    await act(pg);
    await pg.waitForTimeout(1500);
    await pg.goto(BASE + '?delegate=CPU#/history');
    await pg.waitForSelector('.history-body .empty, .setlist', { timeout: 20000 });
    const rows = await pg.$$eval('.setlist li', (els) => els.length);
    check(name, rows >= 1, `записей в истории ${rows}`);
    await c2.close();
  }

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

  // 9. зависшая загрузка WebAssembly: раньше экран загрузки висел навсегда, теперь загрузка повторяется
  const wstall = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  const p5 = await wstall.newPage();
  let wcalls = 0;
  await p5.route(/vision_wasm(_nosimd)?_internal\.wasm$/, (route) => {
    wcalls += 1;
    if (wcalls === 1) return; // никогда не отвечаем
    return route.continue();
  });
  await p5.goto(BASE + '?delegate=CPU#/session/squat');
  await p5.waitForFunction(() => ['prepare', 'error'].includes(document.querySelector('.session')?.dataset.phase ?? ''), null, { timeout: 150000 }).catch(() => undefined);
  const ph5 = await p5.evaluate(() => document.querySelector('.session')?.dataset.phase);
  check('зависшая загрузка wasm перезапускается', ph5 === 'prepare' && wcalls >= 2, `запросов wasm ${wcalls}, фаза ${ph5}`);
  await wstall.close();

  // 10. системная «назад» с экрана итога не включает камеру снова
  const c3 = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  const p6 = await c3.newPage();
  await p6.goto(BASE + '?delegate=CPU#/');
  await p6.click('#start-pushup');
  await p6.waitForFunction(() => Number(document.querySelector('#counter')?.textContent) >= 1, null, { timeout: 150000 });
  await p6.click('#finish');
  await p6.waitForSelector('.summary');
  await p6.evaluate(() => history.back());
  await p6.waitForTimeout(1500);
  const hash6 = await p6.evaluate(() => location.hash);
  check('«назад» с итога ведёт на главную', !hash6.startsWith('#/session'), `адрес ${hash6 || '(пусто)'}`);
  await c3.close();

  // 11. перезагрузка страницы посреди подхода: сделанные повторения уже в истории (черновик после каждого повторения)
  const c4 = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  const p7 = await c4.newPage();
  await p7.goto(BASE + '?delegate=CPU#/');
  await p7.click('#start-pushup');
  await p7.waitForFunction(() => Number(document.querySelector('#counter')?.textContent) >= 2, null, { timeout: 150000 });
  const before = Number(await p7.textContent('#counter'));
  await p7.waitForTimeout(300);
  await p7.reload();
  await p7.goto(BASE + '?delegate=CPU#/history');
  await p7.waitForSelector('.history-body .empty, .setlist', { timeout: 20000 });
  const savedAfterReload = await p7.$$eval('.setlist li .count b', (els) => els.map((e) => Number(e.textContent)));
  check('перезагрузка во время счёта не теряет подход', savedAfterReload.length === 1 && savedAfterReload[0] >= Math.min(before, 2), `на счётчике было ${before}, в истории ${savedAfterReload.join(', ') || 'пусто'}`);
  await c4.close();
} catch (e) {
  check('сценарий не упал', false, e.message);
}
await browser.close();
server?.kill();
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.extra ? ' — ' + r.extra : ''}`);
console.log('ошибки страницы:', errors.length ? errors : 'нет');
process.exit(results.every((r) => r.ok) ? 0 : 1);
