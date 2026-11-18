// Прогон приложения в настоящем браузере на видеофайлах (режим проверки, покадрово).
// Запуск: npm run e2e [-- --browser=webkit] [-- --only=pushup_side]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const browserName = args.browser ?? 'chromium';
const PORT = 5179;
const BASE = `http://127.0.0.1:${PORT}/`;

// expect: ожидаемое число повторений (диапазон), status: какой статус должен появиться
export const CASES = [
  { name: 'pushup_side', exercise: 'pushup', video: 'test-videos/pushup_side.mp4', expect: [5, 6], note: 'сбоку, 6 отжиманий, первое начинается почти сразу' },
  { name: 'pushup_diagonal', exercise: 'pushup', video: 'test-videos/pushup_diagonal.mp4', expect: [0, 8], note: 'ракурс три четверти — точность не гарантируется' },
  { name: 'squat_side_two_people', exercise: 'squat', video: 'test-videos/squat_side_two_people.mp4', expect: [2, 4], note: 'двое в кадре, модель берёт одного' },
  { name: 'squat_side_cuts', exercise: 'squat', video: 'test-videos/squat_side_cuts.mp4', expect: [0, 2], note: 'склейки и смена ракурса' },
  { name: 'squat_front', exercise: 'squat', video: 'test-videos/squat_front.mp4', expect: [0, 0], status: 'WRONG_POSITION', note: 'анфас — должен попросить встать боком' },
  { name: 'lunge_side', exercise: 'lunge', video: 'test-videos/lunge_side.mp4', expect: [1, 1], note: '1 полный выпад; первый начат до записи, последний оборван' },
  { name: 'lunge_side_far', exercise: 'lunge', video: 'test-videos/lunge_side_far.mp4', expect: [3, 3], note: '3 полных выпада с шагом, человек далеко' },
  { name: 'curl_diagonal', exercise: 'curl', video: 'test-videos/curl_diagonal.mp4', expect: [0, 0], note: 'ракурс три четверти — не считаем, просим встать боком' },
  { name: 'plank_side', exercise: 'plank', video: 'test-videos/plank_side.mp4', expect: [0, 0], hold: [10, 17], note: 'планка на локтях, в начале камера двигается' },
  { name: 'situp_side', exercise: 'crunch', video: 'test-videos/situp_side.mp4', expect: [2, 2], note: '2 полных подъёма, третий оборван наверху' },
  { name: 'crunch_side', exercise: 'crunch', video: 'test-videos/crunch_side.mp4', expect: [0, 0], note: 'V-образные скручивания сидя — другое упражнение, не считаем' },
];

function startServer() {
  const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('vite не запустился')), 30000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('Local')) {
        clearTimeout(t);
        resolve(proc);
      }
    });
    proc.stderr.on('data', (d) => process.stderr.write(d));
  });
}

async function main() {
  const server = await startServer();
  const bt = browserName === 'webkit' ? webkit : chromium;
  const browser = await bt.launch({ headless: true, args: browserName === 'chromium' ? ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] : [] });
  const results = [];
  const cases = CASES.filter((c) => !args.only || c.name === args.only);
  for (const c of cases) {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const logs = [];
    page.on('console', (m) => {
      const txt = m.text();
      if (/^(I|W)[0-9]{4} |INFO: |Created TensorFlow Lite|gl_context|Graph successfully|OpenGL error checking/.test(txt)) return; // служебные сообщения MediaPipe
      if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${txt}`);
    });
    page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
    const url = `${BASE}?dev&step=15&record&delegate=${args.delegate ?? "CPU"}${args.model ? '&model=' + args.model : ''}&video=${encodeURIComponent('/' + c.video)}#/session/${c.exercise}`;
    const t0 = Date.now();
    await page.goto(url);
    try {
      await page.waitForFunction(() => window.__povtor?.done === true || (window.__povtor?.error && window.__povtor.error !== 'NOT_STARTED' && window.__povtor.error !== null), null, { timeout: 240000, polling: 500 });
    } catch {
      logs.push('timeout');
    }
    const frames = await page.evaluate(() =>
      window.__povtor.frames.map((f) => ({ t: Math.round(f.tMs), w: f.width, h: f.height, l: f.landmarks.map((p) => [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4), +p.visibility.toFixed(3)]), g: f.world?.map((p) => [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)]) })),
    );
    mkdirSync(new URL('./out', import.meta.url), { recursive: true });
    writeFileSync(new URL(`./out/${c.name}.${browserName}${args.model ? '.' + args.model : ''}.frames.json`, import.meta.url), JSON.stringify(frames));
    const hook = await page.evaluate(() => {
      const h = window.__povtor;
      return {
        done: h.done,
        error: h.error,
        engine: h.engine,
        summary: h.summary,
        statuses: h.events.filter((e) => e.type === 'status').map((e) => e.status),
        reps: h.events.filter((e) => e.type === 'rep').map((e) => e.rep),
        frames: h.frames.length,
      };
    });
    const total = hook.summary?.totalReps ?? 0;
    const holdSec = Math.round((hook.summary?.holdMs ?? 0) / 1000);
    const okCount = total >= c.expect[0] && total <= c.expect[1] && (!c.hold || (holdSec >= c.hold[0] && holdSec <= c.hold[1]));
    const okStatus = !c.status || hook.statuses.includes(c.status);
    results.push({ name: c.name, total, holdSec, cleanHoldSec: Math.round((hook.summary?.cleanHoldMs ?? 0) / 1000), errorsCount: hook.summary?.errorsCount, clean: hook.summary?.cleanReps ?? 0, expect: c.expect.join('–'), pass: okCount && okStatus, error: hook.error, engine: hook.engine, frames: hook.frames, sec: ((Date.now() - t0) / 1000).toFixed(1), statuses: [...new Set(hook.statuses)].join(','), reps: hook.reps, logs: logs.slice(0, 5), note: c.note });
    await page.close();
  }
  await browser.close();
  server.kill();
  mkdirSync(new URL('./out', import.meta.url), { recursive: true });
  writeFileSync(new URL(`./out/results-${browserName}.json`, import.meta.url), JSON.stringify(results, null, 2));
  for (const r of results) {
    console.log(`${r.pass ? 'OK  ' : 'FAIL'} ${r.name.padEnd(24)} повторений ${String(r.total).padStart(2)} (чистых ${r.clean})${r.holdSec ? `, в позе ${r.holdSec} с (без ошибок ${r.cleanHoldSec} с) ${JSON.stringify(r.errorsCount)}` : ''}, ожидали ${r.expect}; статусы: ${r.statuses}; кадров ${r.frames}; ${r.sec} с; модель ${r.engine?.variant}/${r.engine?.delegate}${r.error ? '; ошибка ' + r.error : ''}`);
    for (const rep of r.reps) console.log(`       #${rep.index} ${rep.tStartMs}–${rep.tEndMs} мс, мин. угол ${rep.minAngle}, ошибки: ${rep.errors.join(',') || '—'}`);
    for (const l of r.logs) console.log('       ' + l);
  }
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
