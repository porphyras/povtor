// Прогон корпуса роликов в настоящем браузере (режим проверки, покадрово, 15 кадров/с). Эталон — tests/corpus/manifest.json,
// сами ролики — в test-videos/corpus (в репозиторий не входят, источники и лицензии — tests/corpus/SOURCES.txt).
// Запуск: node e2e/corpus.mjs [--jobs=3] [--only=имя1,имя2] [--exercise=squat] [--kind=negative] [--browser=webkit]
// Итог: e2e/out/corpus/results.json, точки тела — e2e/out/corpus/frames/<имя>.frames.json.gz,
// события с метками времени — e2e/out/corpus/events/<имя>.json.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { chromium, webkit } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const browserName = args.browser ?? 'chromium';
const PORT = Number(args.port ?? 5185); // 5179–5182 заняты другими скриптами
const BASE = `http://127.0.0.1:${PORT}/`;
const JOBS = Math.max(1, Number(args.jobs ?? 3));
const ROOT = new URL('..', import.meta.url);
const OUT = new URL('./out/corpus/', import.meta.url);
const STEP = 15;

const manifest = JSON.parse(readFileSync(new URL('tests/corpus/manifest.json', ROOT), 'utf8'));
const only = args.only ? args.only.split(',') : null;
const cases = manifest.filter(
  (c) =>
    (!only || only.some((o) => c.file.includes(o))) &&
    (!args.exercise || c.exercise === args.exercise) &&
    (!args.kind || c.kind === args.kind),
);

const nameOf = (c) => c.file.replace(/\.mp4$/, '');

function startServer() {
  const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT.pathname, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('vite не запустился')), 30000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('Local')) {
        clearTimeout(t);
        resolve(proc);
      }
    });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    proc.on('exit', (code) => reject(new Error('vite завершился с кодом ' + code)));
  });
}

/**
 * Метки времени для событий: анализатор их не пишет, поэтому подменяем push у массива hook.events
 * и ставим каждому событию время текущего кадра видео (в покадровом режиме это ровно время кадра).
 */
const INIT = () => {
  let hook;
  const stamp = (arr) => {
    if (!Array.isArray(arr) || arr.__stamped) return arr;
    const orig = arr.push.bind(arr);
    Object.defineProperty(arr, '__stamped', { value: true });
    arr.push = (...xs) => {
      const v = document.querySelector('video.cam');
      const t = v ? Math.round(v.currentTime * 1000) : null;
      for (const x of xs) {
        try {
          x._t = t;
        } catch {
          /* событие только для чтения — без метки */
        }
      }
      return orig(...xs);
    };
    return arr;
  };
  Object.defineProperty(window, '__povtor', {
    configurable: true,
    get: () => hook,
    set(h) {
      hook = h;
      let ev = stamp(h.events);
      Object.defineProperty(h, 'events', { configurable: true, enumerable: true, get: () => ev, set: (v) => (ev = stamp(v)) });
    },
  });
};

function durationOf(file) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    let s = '';
    p.stdout.on('data', (d) => (s += d));
    p.on('close', () => resolve(Number(s) || 60));
  });
}

async function runCase(browser, c) {
  const name = nameOf(c);
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.addInitScript(INIT);
  const logs = [];
  page.on('console', (m) => {
    const txt = m.text();
    if (/^(I|W)[0-9]{4} |INFO: |Created TensorFlow Lite|gl_context|Graph successfully|OpenGL error checking|GL Driver Message/.test(txt)) return; // служебные сообщения MediaPipe и WebGL
    if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${txt}`);
  });
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  page.on('crash', () => logs.push('crash'));
  const videoPath = `/test-videos/corpus/${c.file}`;
  const url = `${BASE}?dev&step=${STEP}&record&delegate=${args.delegate ?? 'CPU'}&video=${encodeURIComponent(videoPath)}#/session/${c.exercise}`;
  const dur = await durationOf(new URL('test-videos/corpus/' + c.file, ROOT).pathname);
  const timeout = Math.round((90 + dur * 8) * 1000); // ~0,6 с на секунду ролика на CPU; запас на параллельные прогоны
  const t0 = Date.now();
  let timedOut = false;
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.__povtor?.done === true || (window.__povtor?.error && window.__povtor.error !== 'NOT_STARTED' && window.__povtor.error !== null), null, {
      timeout,
      polling: 500,
    });
  } catch (e) {
    timedOut = true;
    logs.push('timeout/' + String(e.message).split('\n')[0]);
  }
  let hook = null;
  let frames = [];
  try {
    frames = await page.evaluate(() =>
      (window.__povtor?.frames ?? []).map((f) => ({
        t: Math.round(f.tMs),
        w: f.width,
        h: f.height,
        l: f.landmarks.map((p) => [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4), +p.visibility.toFixed(3)]),
        g: f.world?.map((p) => [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)]),
      })),
    );
    hook = await page.evaluate(() => {
      const h = window.__povtor;
      return {
        done: h.done,
        error: h.error,
        engine: h.engine,
        summary: h.summary,
        events: h.events.map((e) => ({ ...e })),
        lastVideoMs: Math.round((document.querySelector('video.cam')?.currentTime ?? 0) * 1000),
      };
    });
  } catch (e) {
    logs.push('evaluate: ' + e.message);
  }
  await page.close();
  writeFileSync(new URL(`frames/${name}.frames.json.gz`, OUT), gzipSync(JSON.stringify(frames)));
  writeFileSync(new URL(`events/${name}.json`, OUT), JSON.stringify({ file: c.file, exercise: c.exercise, hook, logs }, null, 1));

  const ev = hook?.events ?? [];
  const sum = hook?.summary ?? null;
  const total = sum?.totalReps ?? 0;
  const holdSec = +((sum?.holdMs ?? 0) / 1000).toFixed(1);
  const statuses = [];
  for (const e of ev) if (e.type === 'status' && statuses.at(-1) !== e.status) statuses.push(e.status);
  const tips = ev.filter((e) => e.type === 'tip').map((e) => `${e.code}@${((e._t ?? 0) / 1000).toFixed(1)}`);
  const hints = ev.filter((e) => e.type === 'hint').length;
  const finish = ev.find((e) => e.type === 'finish');
  const ready = ev.find((e) => e.type === 'ready' && e.ready);
  const okReps = total >= c.expect[0] && total <= c.expect[1];
  const holdRange = c.hold ?? (CATALOG_HOLD.has(c.exercise) ? [0, 0] : null);
  const okHold = !holdRange || (holdSec >= holdRange[0] - 0.5 && holdSec <= holdRange[1] + 0.5);
  const okStatus = !c.status || statuses.includes(c.status);
  const crashed = timedOut || logs.some((l) => l.startsWith('pageerror') || l === 'crash');
  return {
    name,
    file: c.file,
    exercise: c.exercise,
    view: c.view,
    kind: c.kind,
    expect: c.expect,
    hold: holdRange,
    total,
    clean: sum?.cleanReps ?? 0,
    holdSec,
    cleanHoldSec: +((sum?.cleanHoldMs ?? 0) / 1000).toFixed(1),
    errorsCount: sum?.errorsCount ?? {},
    side: sum?.side ?? null,
    pass: okReps && okHold && okStatus && !crashed,
    okReps,
    okHold,
    okStatus,
    error: hook?.error ?? null,
    done: hook?.done ?? false,
    readyAt: ready?._t ?? null,
    finishReason: finish?.reason ?? sum?.finishReason ?? null,
    finishAt: finish?._t ?? null,
    statuses,
    tips,
    hints,
    reps: (sum?.reps ?? []).map((r) => ({ i: r.index, t0: r.tStartMs, t1: r.tEndMs, angle: r.minAngle, errors: r.errors })),
    frames: frames.length,
    durationSec: +dur.toFixed(1),
    lastVideoMs: hook?.lastVideoMs ?? null,
    sec: +((Date.now() - t0) / 1000).toFixed(1),
    engine: hook?.engine ?? null,
    logs: logs.slice(0, 8),
    note: c.note,
  };
}

const CATALOG_HOLD = new Set(['plank', 'wallsit']);

async function main() {
  mkdirSync(new URL('frames/', OUT), { recursive: true });
  mkdirSync(new URL('events/', OUT), { recursive: true });
  const server = await startServer();
  const bt = browserName === 'webkit' ? webkit : chromium;
  const browser = await bt.launch({ headless: true, args: browserName === 'chromium' ? ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] : [] });
  const results = [];
  const queue = cases.slice();
  const t0 = Date.now();
  async function worker() {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      let r;
      try {
        r = await runCase(browser, c);
      } catch (e) {
        r = { name: nameOf(c), file: c.file, exercise: c.exercise, kind: c.kind, expect: c.expect, pass: false, error: 'runner: ' + e.message, logs: [] };
      }
      results.push(r);
      const hold = r.holdSec ? `, в позе ${r.holdSec} с (без ошибок ${r.cleanHoldSec} с)` : '';
      console.log(
        `${r.pass ? 'OK  ' : 'FAIL'} ${r.name.padEnd(34)} ${r.exercise?.padEnd(7)} ${String(r.total).padStart(2)} (чистых ${r.clean})${hold}; ждали ${r.expect?.join('–')}${r.hold ? ` / ${r.hold.join('–')} с` : ''}; ${r.statuses?.join('>') ?? ''}${r.error ? '; ' + r.error : ''}; ${r.sec} с`,
      );
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(JOBS, cases.length) }, worker));
  } finally {
    await browser.close();
    server.kill();
  }
  results.sort((a, b) => cases.findIndex((c) => nameOf(c) === a.name) - cases.findIndex((c) => nameOf(c) === b.name));
  const file = args.only || args.exercise || args.kind ? `results-partial-${Date.now()}.json` : 'results.json';
  writeFileSync(new URL(file, OUT), JSON.stringify(results, null, 1));
  const passed = results.filter((r) => r.pass).length;
  console.log(`\nпрошло ${passed} из ${results.length}; ${((Date.now() - t0) / 1000).toFixed(0)} с; итог в e2e/out/corpus/${file}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
