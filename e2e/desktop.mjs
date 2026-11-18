// Скриншоты экранов на широком экране: node e2e/desktop.mjs [--width=1440 --height=900 --out=desktop]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const W = Number(args.width ?? 1440);
const H = Number(args.height ?? 900);
const PORT = 5183;
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = new URL(`./out/${args.out ?? 'desktop'}-${W}x${H}/`, import.meta.url);
mkdirSync(OUT, { recursive: true });

const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('Local') && r()));

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (name) => page.screenshot({ path: new URL(name + '.png', OUT).pathname });

await page.goto(BASE + '#/');
await page.waitForSelector('#start-squat');
await shot('1-home');

await page.goto(`${BASE}?delegate=CPU&video=${encodeURIComponent('/test-videos/squat_front.mp4')}#/session/squat`);
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('боком'), null, { timeout: 120000 });
await shot('2-prepare');

await page.goto(`${BASE}?delegate=CPU&video=${encodeURIComponent('/test-videos/pushup_side.mp4')}#/session/pushup`);
await page.waitForFunction(() => Number(document.querySelector('#counter')?.textContent) >= 2, null, { timeout: 120000 });
await shot('3-counting');
// помещаются ли длинные значения в плашку счётчика (ширина текста против ширины плашки)
const fit = await page.evaluate(() => {
  const c = document.querySelector('#counter');
  const out = {};
  for (const [t, time] of [['8', false], ['88', false], ['128', false], ['200', false], ['0:45', true], ['10:00', true]]) {
    c.classList.toggle('time', time);
    c.textContent = t;
    c.style.setProperty('--chars', String(Math.max(t.length, time ? 4 : 2)));
    const r = document.createRange();
    r.selectNodeContents(c);
    const tw = r.getBoundingClientRect().width;
    const box = c.getBoundingClientRect();
    out[t] = tw <= box.width - 8 ? 'да' : `нет (${Math.round(tw)} > ${Math.round(box.width)})`;
  }
  c.classList.remove('time');
  return out;
});
console.log('помещается в плашку:', JSON.stringify(fit));
const layout = await page.evaluate(() => getComputedStyle(document.querySelector('.panel')).display);
console.log('раскладка экрана подхода:', layout === 'contents' ? 'телефон' : 'с панелью');
await page.waitForFunction(() => window.__povtor?.done === true, null, { timeout: 120000 });
await page.waitForSelector('.summary');
await shot('4-summary');

await page.goto(`${BASE}?delegate=CPU&video=${encodeURIComponent('/test-videos/plank_side.mp4')}#/session/plank`);
await page.waitForFunction(() => /^0:0[4-9]|^0:[1-5]/.test(document.querySelector('#counter')?.textContent ?? ''), null, { timeout: 120000 });
await shot('5-plank');

await page.goto(BASE + '#/history');
await page.waitForSelector('.setlist, .history-body .empty');
await shot('6-history');

console.log('ошибки страницы:', errors.length ? errors : 'нет');
await browser.close();
server.kill();
process.exit(0);
