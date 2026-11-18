// Скриншоты экранов для визуальной проверки: npm run screens [-- --browser=webkit]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium, webkit } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const browserName = args.browser ?? 'chromium';
const PORT = 5180;
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = new URL(`./out/screens-${browserName}/`, import.meta.url);
mkdirSync(OUT, { recursive: true });

const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('Local') && r()));

const bt = browserName === 'webkit' ? webkit : chromium;
const browser = await bt.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: browserName === 'chromium', hasTouch: true, colorScheme: args.dark ? 'dark' : 'light' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (name) => page.screenshot({ path: new URL(name + '.png', OUT).pathname });

await page.goto(BASE + '#/history');
await page.waitForSelector('.history-body .empty, .setlist');
await shot('1-history-empty');
await page.goto(BASE + '#/');
await page.waitForSelector('#start-squat');
await shot('2-home');

// подход по видеофайлу в реальном времени (без покадрового режима), чтобы увидеть экран во время счёта
await page.goto(`${BASE}?delegate=CPU&video=${encodeURIComponent('/test-videos/pushup_side.mp4')}#/session/pushup`);
await page.waitForFunction(() => document.querySelector('.session')?.dataset.phase === 'counting', null, { timeout: 120000 });
await page.waitForFunction(() => Number(document.querySelector('#counter')?.textContent) >= 2, null, { timeout: 60000 });
await shot('3-session-counting');
await page.waitForFunction(() => window.__povtor?.done === true, null, { timeout: 120000 });
await page.waitForSelector('.summary');
await shot('4-summary');
await page.goto(BASE + '#/history');
await page.waitForSelector('.setlist');
await shot('5-history');

// подготовка: файл, где человек стоит анфас — должна быть просьба встать боком
await page.goto(`${BASE}?delegate=CPU&video=${encodeURIComponent('/test-videos/squat_front.mp4')}#/session/squat`);
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('боком'), null, { timeout: 120000 });
await shot('6-prepare-wrong-position');

// подготовка и обратный отсчёт: человек стоит боком
await page.goto(`${BASE}?delegate=CPU&countdown=3&ready=600&video=${encodeURIComponent('/test-videos/squat_side_two_people.mp4')}#/session/squat`);
await page.waitForFunction(() => document.querySelector('#status')?.classList.contains('ok'), null, { timeout: 120000 }).catch(() => undefined);
await shot('7-prepare-ok');
await page.waitForFunction(() => document.querySelector('.session')?.dataset.phase === 'countdown', null, { timeout: 60000 }).catch(() => undefined);
await shot('8-countdown');

console.log('ошибки страницы:', errors.length ? errors : 'нет');
await browser.close();
server.kill();
process.exit(0);
