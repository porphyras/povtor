import { createAnalyzer, type Analyzer } from '../analyzer/analyzer';
import type { App } from '../app';
import { attachStream, attachVideoFile, startCamera, stopStream } from '../camera';
import { errorType } from '../config';
import { appError, PovtorError } from '../errors';
import type { PoseEngine } from '../pose';
import { saveSet } from '../storage';
import type { AnalyzerEvent, AppError, AppErrorCode, ErrorCode, Exercise, FinishReason, PoseFrame, Rep, RepRecord, SetRecord, Side, Status } from '../types';
import { numberWord } from '../voice';
import { clear, h, svg } from './dom';
import { CATALOG, formatDuration, SILHOUETTES } from '../catalog';
import { OneEuro } from '../analyzer/geometry';
import { drawSkeleton } from './skeleton';
import { plural } from './summary';

type Phase = 'loading' | 'error' | 'prepare' | 'countdown' | 'counting' | 'saving';

function statusText(ex: Exercise, s: Status | null, phase: Phase): string {
  if (s === 'NOT_VISIBLE' || s === null) return 'Не вижу тебя целиком. Отойди дальше от камеры';
  if (s === 'NO_ROOM') return 'Руки над головой не помещаются в кадр. Отойди дальше';
  if (s === 'WRONG_POSITION') return phase === 'counting' ? CATALOG[ex].wrongCounting : CATALOG[ex].wrongPrepare;
  return 'Вижу целиком';
}

/** Что сказать голосом при смене статуса: с 2–3 метров текст не прочесть. */
function statusVoice(ex: Exercise, s: Status | null, phase: Phase): string | null {
  if (s === 'NOT_VISIBLE') return 'Отойди дальше, не вижу тебя целиком';
  if (s === 'NO_ROOM') return 'Отойди дальше, руки над головой не помещаются';
  if (s === 'WRONG_POSITION') return phase === 'counting' ? CATALOG[ex].wrongCounting : CATALOG[ex].wrongPrepare;
  return null;
}

/** Что сказать, если во время счёта долго не удаётся посчитать угол упражнения (по умолчанию — подсказка «как встать»). */
const NO_VALUE: Partial<Record<Exercise, string>> = {
  lunge: 'Встань строго боком, чтобы были видны обе ноги',
};

const MINUTES = ['', 'одна минута', 'две минуты', 'три минуты', 'четыре минуты', 'пять минут'];
/** Время удержания голосом: «30 секунд», «одна минута», «одна минута 20 секунд». */
export function holdPhrase(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const min = m === 0 ? '' : m < MINUTES.length ? MINUTES[m] : `${m} минут`;
  if (!s) return min;
  return (min ? min + ' ' : '') + `${s} ${plural(s, 'секунда', 'секунды', 'секунд')}`;
}

type WakeLockSentinelLike = { release(): Promise<void> };
type NavigatorWithWakeLock = Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } };

function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export function renderSession(root: HTMLElement, app: App, exercise: Exercise): () => void {
  const { dev, hook } = app;
  const info = CATALOG[exercise];
  const isHold = info.kind === 'hold';
  const fileMode = !!dev.video;
  // В режиме видеофайла подготовка короче: в роликах человек часто начинает сразу.
  const readyMs = dev.readyMs ?? (fileMode ? 200 : app.config.prepare.readyHoldMs);
  const config = { ...app.config, prepare: { ...app.config.prepare, readyHoldMs: readyMs } };
  const countdownSec = dev.countdown ?? (fileMode ? 0 : config.prepare.countdownSec);
  let facing: 'user' | 'environment' = 'user';

  // ---------- разметка ----------
  const video = h('video', { class: 'cam', muted: true, playsInline: true, autoplay: true, 'aria-hidden': 'true' });
  const canvas = h('canvas', { class: 'cam' });
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const stage = h('div', { class: 'stage' }, video, canvas);
  const counter = h('div', { class: 'counter hidden', id: 'counter', 'aria-live': 'polite' }, '0');
  const tip = h('div', { class: 'tip hidden', id: 'tip', role: 'status' });
  const paused = h('div', { class: 'paused hidden' }, h('p', null, 'Не вижу тебя целиком'));
  const statusPill = h('div', { class: 'pill', id: 'status' }, '…');
  const silhouette = svg(SILHOUETTES[info.silhouette].svg);
  const hintEl = h('p', { class: 'hint' }, info.setup);
  // на широком экране подсказка «как встать» живёт в боковой панели, а не поверх видео
  const panelHint = h('p', { class: 'panel-hint hidden' }, info.setup);
  const prepare = h('div', { class: 'prepare hidden' }, silhouette, hintEl);
  const countdownEl = h('div', { class: 'countdown hidden', id: 'countdown' });
  const loadingText = h('p', null, 'Загружаем модель…');
  const bar = h('div', { class: 'bar-fill' });
  const loading = h(
    'div',
    { class: 'overlay loading', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'spinner' }),
    loadingText,
    h('div', { class: 'bar' }, bar),
    // загрузка может зависнуть на плохой сети — уйти можно всегда
    h('div', { class: 'btns' }, h('button', { class: 'btn', id: 'loading-home', onclick: () => leave() }, 'На главную')),
  );
  const errorBox = h('div', { class: 'overlay error hidden', role: 'alert' });
  const finishBtn = h('button', { class: 'btn primary finish hidden', id: 'finish', onclick: () => finalize('user') }, 'Закончить');
  const switchBtn = h(
    'button',
    { class: 'icon-btn', title: 'Сменить камеру', 'aria-label': 'Сменить камеру', onclick: () => switchCamera() },
    svg(`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><path d="M9.5 13.5a2.8 2.8 0 0 1 5-1.7M14.5 13.5a2.8 2.8 0 0 1-5 1.7"/><path d="M14.6 10.3v1.6h-1.6M9.4 16.7v-1.6h1.6"/></svg>`),
  );
  const devPanel = h('pre', { class: 'devpanel' + (dev.dev ? '' : ' hidden'), id: 'devpanel' });
  const top = h(
    'div',
    { class: 'topbar' },
    h('button', { class: 'icon-btn', 'aria-label': 'Назад', onclick: () => back() }, '✕'),
    h('span', { class: 'title' }, info.name),
    fileMode ? (dev.dev ? h('span', { class: 'badge' }, 'видеофайл') : null) : switchBtn,
  );
  // Две части: видео и панель. На телефоне панель «растворяется» (display: contents) и её элементы лежат поверх видео,
  // на широком экране она становится колонкой справа, чтобы счёт и подсказки не закрывали человека.
  const stageWrap = h('div', { class: 'stage-wrap' }, stage, prepare, countdownEl, paused);
  const panel = h('div', { class: 'panel' }, top, panelHint, statusPill, counter, tip, h('div', { class: 'bottombar' }, finishBtn));
  const view = h('main', { class: 'screen session' }, stageWrap, panel, loading, errorBox, devPanel);
  root.append(view);

  // ---------- состояние ----------
  let phase: Phase = 'loading';
  let engine: PoseEngine | null = null;
  let analyzer: Analyzer = createAnalyzer(exercise, config);
  let stream: MediaStream | null = null;
  let stopped = false;
  let finalized = false;
  let status: Status | null = null;
  let countdownStart = 0;
  let lastCountdownShown = -1;
  let countStartWall = 0;
  let lastT = 0;
  let tipTimer = 0;
  let wakeLock: WakeLockSentinelLike | null = null;
  let lastStatusVoiceAt = -Infinity;
  let lastHoldVoiceSec = 0;
  let gen = 0; // поколение запуска: после перезапуска старые циклы кадров останавливаются
  const fpsTimes: number[] = [];
  // подход сохраняется черновиком после каждого повторения: перезагрузка или закрытие вкладки его не теряют
  let setId = '';
  let reps: Rep[] = [];
  let lastDraftAt = 0;
  // постоянная строка внизу во время счёта: почему не считается (неверное положение, нет позы в удержании)
  let statusNote: string | null = null;
  // строку о неверном положении показываем и убираем с задержкой: у порога ракурса статус может мигать
  let pendingStatusNote: string | null = null;
  let pendingSince = 0;
  let holdNote: string | null = null;
  let valueNote: string | null = null;
  let countStartTA = 0;
  let notHoldingSince = -1;
  let tipTransient = false;
  hook.events = [];
  hook.frames = [];
  hook.summary = null;
  hook.done = false;
  hook.error = null;

  const show = (el: HTMLElement, on: boolean) => el.classList.toggle('hidden', !on);

  function setPhase(p: Phase) {
    phase = p;
    view.dataset.phase = p;
    show(loading, p === 'loading');
    show(errorBox, p === 'error');
    show(prepare, p === 'prepare');
    show(statusPill, p === 'prepare');
    show(panelHint, p === 'prepare' || p === 'countdown');
    show(countdownEl, p === 'countdown');
    show(counter, p === 'counting');
    show(finishBtn, p === 'counting');
    show(switchBtn, p === 'prepare' || p === 'countdown');
    if (p !== 'counting') show(paused, false);
  }

  function showError(err: AppError) {
    hook.error = err.code;
    // камера и блокировка экрана не должны оставаться включёнными под сообщением об ошибке
    stopStream(stream);
    stream = null;
    wakeLock?.release().catch(() => undefined);
    wakeLock = null;
    clear(errorBox);
    errorBox.append(h('h2', null, 'Что-то пошло не так'), h('p', null, err.message));
    if (err.code === 'CAMERA_DENIED') {
      errorBox.append(
        h('p', { class: 'small' }, 'Chrome и Яндекс Браузер: нажми значок камеры или замка в адресной строке → «Разрешить». Safari на iPhone: «аА» в адресной строке → «Настройки веб-сайта» → «Камера» → «Разрешить».'),
      );
    }
    const btns = h('div', { class: 'btns' });
    if (err.recoverable) btns.append(h('button', { class: 'btn primary', onclick: () => restart() }, err.action === 'reload' ? 'Перезагрузить' : 'Повторить'));
    btns.append(h('button', { class: 'btn', onclick: () => leave() }, 'На главную'));
    errorBox.append(btns);
    setPhase('error');
  }

  // ---------- запуск ----------
  async function boot() {
    const my = ++gen;
    stopped = false;
    finalized = false;
    lastT = 0;
    setPhase('loading');
    // какой код ошибки показать, если что-то упадёт без своего кода: зависит от того, что делали
    let stage: AppErrorCode = 'MODEL_LOAD';
    try {
      engine = await app.getEngine((stage, share) => {
        if (stage === 'wasm') {
          loadingText.textContent = `Загружаем библиотеку… ${Math.round((share ?? 0) * 100)}%`;
          bar.style.width = `${Math.round((share ?? 0) * 100)}%`;
        }
        if (stage === 'model') {
          loadingText.textContent = `Загружаем модель… ${Math.round((share ?? 0) * 100)}%`;
          bar.style.width = `${Math.round((share ?? 0) * 100)}%`;
        }
        if (stage === 'retry') loadingText.textContent = `Связь прервалась, загружаем заново (попытка ${share})…`;
        if (stage === 'init' || stage === 'warmup') loadingText.textContent = 'Запускаем распознавание…';
      });
      if (stopped) return;
      loadingText.textContent = fileMode ? 'Открываем видео…' : 'Включаем камеру…';
      stage = fileMode ? 'FILE_FORMAT' : 'CAMERA_BUSY';
      if (fileMode) {
        const src = new URL(dev.video as string, location.href);
        if (src.origin !== location.origin) throw new PovtorError('FILE_FORMAT', 'видео только с этого же сайта');
        await attachVideoFile(video, src.href);
      } else {
        stream = await startCamera({ facingMode: facing, ...config.camera });
        if (stopped) return stopStream(stream);
        await attachStream(video, stream);
        const track = stream.getVideoTracks()[0];
        track?.addEventListener('ended', () => {
          if (my !== gen || stopped || finalized) return;
          // камера отключилась посреди подхода — сделанное не теряем
          if (phase === 'counting' && didSomething()) void finalize('user');
          else showError(appError(new PovtorError('CAMERA_BUSY', 'track ended'), 'CAMERA_BUSY'));
        });
        // зеркалим всё, кроме основной камеры телефона (у веб-камер ноутбуков facingMode обычно не указан)
        view.classList.toggle('mirror', track?.getSettings().facingMode !== 'environment');
        void requestWakeLock();
      }
      if (stopped) return;
      fitCanvas();
      analyzer = createAnalyzer(exercise, config);
      status = null;
      setPhase('prepare');
      statusPill.textContent = statusText(exercise, null, phase);
      if (fileMode && dev.step > 0) void stepThroughFile(my);
      else {
        if (fileMode) {
          video.addEventListener('ended', () => my === gen && void finalize('user'), { once: true });
          await video.play();
        }
        schedule(my);
      }
    } catch (e) {
      if (stopped || my !== gen) return;
      console.error(e);
      showError(appError(e, stage));
    }
  }

  function restart() {
    gen++;
    stopStream(stream);
    stream = null;
    void boot();
  }

  async function switchCamera() {
    if (fileMode || (phase !== 'prepare' && phase !== 'countdown')) return;
    facing = facing === 'user' ? 'environment' : 'user';
    restart();
  }

  // ---------- цикл кадров ----------
  function schedule(my: number) {
    if (stopped || finalized || my !== gen) return;
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number };
    if (typeof v.requestVideoFrameCallback === 'function') {
      v.requestVideoFrameCallback((_now, meta) => {
        if (my !== gen) return;
        try {
          tick(fileMode ? meta.mediaTime * 1000 : performance.now());
        } finally {
          schedule(my);
        }
      });
    } else {
      requestAnimationFrame(() => {
        if (my !== gen) return;
        try {
          tick(fileMode ? video.currentTime * 1000 : performance.now());
        } finally {
          schedule(my);
        }
      });
    }
  }

  /** Покадровый проход файла: детерминированно, не зависит от скорости устройства. */
  async function stepThroughFile(my: number) {
    video.pause();
    const dt = 1 / dev.step;
    for (let t = 0; t <= video.duration && !stopped && !finalized && my === gen; t += dt) {
      video.currentTime = t;
      await new Promise<void>((r) => video.addEventListener('seeked', () => r(), { once: true }));
      try {
        tick(t * 1000);
      } catch (e) {
        console.error('tick', e);
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    if (!stopped && !finalized && my === gen) void finalize('user');
  }

  // Скелет на экране рисуем по сглаженным точкам (фильтр One Euro): в покое не дрожит, при быстром движении почти без задержки.
  // На счёт это не влияет — анализатор получает исходные точки.
  let drawFilters: OneEuro[] = [];
  let drawT = -Infinity;
  function smoothForDraw(f: PoseFrame | null, t: number): PoseFrame | null {
    if (!f) return f;
    if (t - drawT > 500) drawFilters = [];
    drawT = t;
    const g = (k: number) => (drawFilters[k] ??= new OneEuro(1.5, 5, 1));
    return { ...f, landmarks: f.landmarks.map((p, i) => ({ ...p, x: g(2 * i).filter(p.x, t), y: g(2 * i + 1).filter(p.y, t) })) };
  }

  /** Холст скелета повторяет размер кадра: телефон для отжиманий поворачивают уже после старта. */
  function fitCanvas() {
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function tick(tA: number) {
    if (stopped || finalized || !engine || video.readyState < 2) return;
    if (engine.failed) {
      // модель сломалась и не пересоздалась: сохраняем сделанное или говорим об ошибке, а не висим на «Не вижу тебя»
      if (phase === 'counting' && didSomething()) void finalize('user');
      else showError(appError(new PovtorError('MODEL_LOAD', 'модель не пересоздалась'), 'MODEL_LOAD'));
      return;
    }
    if (!(tA > lastT)) return;
    lastT = tA;
    fitCanvas();
    const frame = engine.detect(video);
    if (frame) frame.tMs = tA;
    // частота обработки за последнюю секунду
    const now = performance.now();
    fpsTimes.push(now);
    while (fpsTimes.length && now - fpsTimes[0] > 1000) fpsTimes.shift();
    hook.fps = fpsTimes.length;
    if (dev.record && frame) hook.frames.push(frame);

    const events = analyzer.push(frame, tA);
    if (events.length) hook.events.push(...events);
    handle(events, tA);
    const dbg = analyzer.debug();
    drawSkeleton(ctx, smoothForDraw(frame, tA), info.view === 'front' ? null : dbg.side, config.visibility.min, !tip.classList.contains('hidden') && tip.classList.contains('warn'));
    if (phase === 'counting') {
      if (pendingStatusNote !== statusNote && tA - pendingSince >= 600) {
        statusNote = pendingStatusNote;
        refreshTip();
      }
      // человек в кадре, но угол упражнения не считается уже 3 секунды (в выпадах не видно дальнюю ногу)
      const stale = !isHold && status === 'OK' && tA - (dbg.lastValueT ?? countStartTA) > 3000;
      const vn = stale ? NO_VALUE[exercise] ?? info.setup : null;
      if (vn !== valueNote) {
        valueNote = vn;
        refreshTip();
        if (vn) app.voice.say(vn);
      }
    }
    if (isHold && phase === 'counting') {
      setCounter(formatDuration(dbg.holdMs));
      // позы нет дольше 3 секунд (например, в «стульчике» сел слишком высоко) — подсказываем постоянно, пока не примет позу
      if (dbg.holding) {
        notHoldingSince = -1;
        if (holdNote) {
          holdNote = null;
          refreshTip();
        }
      } else {
        if (notHoldingSince < 0) notHoldingSince = tA;
        if (!holdNote && tA - notHoldingSince > 3000) {
          holdNote = info.still;
          refreshTip();
          app.voice.say(info.still);
        }
      }
      if (performance.now() - lastDraftAt > 5000) void persistDraft();
      const sec = Math.floor(dbg.holdMs / 1000);
      const every = config.feedback.holdVoiceEverySec;
      if (dbg.holding && sec > 0 && sec % every === 0 && sec !== lastHoldVoiceSec) {
        lastHoldVoiceSec = sec;
        app.voice.say(holdPhrase(sec));
      }
    }

    if (phase === 'countdown') {
      const left = Math.ceil(countdownSec - (tA - countdownStart) / 1000);
      if (left <= 0) beginCounting(tA);
      else if (left !== lastCountdownShown) {
        lastCountdownShown = left;
        countdownEl.textContent = String(left);
        app.voice.say(numberWord(left));
      }
    }
    if (dev.dev) {
      devPanel.textContent = [
        `фаза ${phase} / ${dbg.phase}`,
        `автомат ${dbg.state}  статус ${dbg.status ?? '—'}`,
        `сторона ${dbg.side ?? '—'}  угол ${dbg.angle?.toFixed(0) ?? '—'} (сырой ${dbg.rawAngle?.toFixed(0) ?? '—'})`,
        isHold ? `в позе ${formatDuration(dbg.holdMs)}  без ошибок ${formatDuration(dbg.cleanHoldMs)}  кадров/с ${hook.fps}` : `повторений ${dbg.reps}  пороги ${dbg.top.toFixed(0)}/${dbg.start.toFixed(0)}  кадров/с ${hook.fps}`,
        `модель ${engine.variant}, ${engine.delegate}  видео ${video.videoWidth}×${video.videoHeight}`,
      ].join('\n');
    }
  }

  /** Число или время на счётчике. --chars нужен широкой раскладке, чтобы «128» или «10:00» помещались в плашку. */
  function setCounter(text: string) {
    if (counter.textContent !== text) counter.textContent = text;
    const n = String(Math.max(text.length, isHold ? 4 : 2));
    if (counter.style.getPropertyValue('--chars') !== n) counter.style.setProperty('--chars', n);
  }

  function beginCounting(tA: number) {
    analyzer.startCounting(tA);
    countStartWall = Date.now() - (fileMode ? tA : 0);
    setId = uuid();
    reps = [];
    lastDraftAt = performance.now();
    statusNote = null;
    pendingStatusNote = null;
    holdNote = null;
    valueNote = null;
    countStartTA = tA;
    notHoldingSince = -1;
    setPhase('counting');
    setCounter(isHold ? '0:00' : '0');
    counter.classList.toggle('time', isHold);
    app.voice.say('Начали');
  }

  /** Экран не должен гаснуть с подготовки и до конца подхода. */
  async function requestWakeLock() {
    const nav = navigator as NavigatorWithWakeLock;
    if (!nav.wakeLock || wakeLock || document.hidden) return;
    try {
      const lock = await nav.wakeLock.request('screen');
      if (stopped) await lock.release().catch(() => undefined);
      else wakeLock = lock;
    } catch {
      /* не поддерживается или запрещено */
    }
  }

  function handle(events: AnalyzerEvent[], tA: number) {
    let repIndex = 0;
    let tipCode: ErrorCode | null = null;
    for (const e of events) {
      if (e.type === 'status') {
        status = e.status;
        statusPill.textContent = statusText(exercise, status, phase);
        statusPill.classList.toggle('ok', status === 'OK');
        // человек найден — контур больше не нужен; подсказку оставляем, пока положение неверное
        show(silhouette as unknown as HTMLElement, status === 'NOT_VISIBLE');
        show(hintEl, status !== 'OK');
        const say = statusVoice(exercise, status, phase);
        if (say && (phase === 'prepare' || phase === 'countdown' || phase === 'counting') && tA - lastStatusVoiceAt >= 4000) {
          lastStatusVoiceAt = tA;
          app.voice.say(say);
        }
        if (phase === 'counting') {
          show(paused, status === 'NOT_VISIBLE');
          pendingStatusNote = status === 'WRONG_POSITION' || status === 'NO_ROOM' ? statusText(exercise, status, phase) : null;
          pendingSince = tA;
        }
        if (phase === 'countdown' && status !== 'OK') {
          setPhase('prepare');
          lastCountdownShown = -1;
        }
      } else if (e.type === 'ready') {
        if (e.ready && phase === 'prepare') {
          if (countdownSec <= 0) beginCounting(tA);
          else {
            countdownStart = tA;
            lastCountdownShown = -1;
            setPhase('countdown');
          }
        } else if (!e.ready && phase === 'countdown') {
          setPhase('prepare');
        }
      } else if (e.type === 'rep') {
        repIndex = e.rep.index;
        reps.push(e.rep);
        setCounter(String(e.rep.index));
        counter.classList.remove('pulse');
        void counter.offsetWidth;
        counter.classList.add('pulse');
      } else if (e.type === 'tip') {
        tipCode = e.code;
      } else if (e.type === 'hint') {
        showTip(info.still, false);
        app.voice.say(info.still);
      } else if (e.type === 'hold') {
        counter.classList.toggle('dim', !e.holding);
        if (!e.holding && phase === 'counting') showTip(info.still, false);
      } else if (e.type === 'finish') {
        // подход закончился сам — говорим об этом, иначе человек продолжит упражнение перед экраном итога
        const d = analyzer.debug();
        const result = isHold ? `${holdPhrase(Math.round(d.holdMs / 1000)) || 'меньше секунды'}` : `${d.reps}`;
        app.voice.say(`Подход окончен. ${isHold ? 'В позе ' + result : 'Повторений: ' + result}`);
        void finalize(e.reason);
      }
    }
    if (repIndex) {
      void persistDraft();
      const t = tipCode ? errorType(config, tipCode) : null;
      app.voice.say(numberWord(repIndex) + (t ? '. ' + t.voice : ''));
      if (t) showTip(t.screen, true);
    } else if (tipCode) {
      // удержание: подсказка без номера повторения
      const t = errorType(config, tipCode);
      app.voice.say(t.voice);
      showTip(t.screen, true);
    }
  }

  /** Короткая подсказка на 2 секунды; после неё возвращается постоянная строка, если она есть. */
  function showTip(text: string, warn: boolean) {
    tip.textContent = text;
    tip.classList.toggle('warn', warn);
    show(tip, true);
    tipTransient = true;
    clearTimeout(tipTimer);
    tipTimer = window.setTimeout(() => {
      tipTransient = false;
      refreshTip();
    }, config.feedback.tipVisibleMs);
  }

  /** Постоянная строка: пока положение неверное или нет позы, она видна, чтобы было понятно, почему счёт стоит. */
  function refreshTip() {
    if (tipTransient) return;
    const note = phase === 'counting' ? statusNote ?? holdNote ?? valueNote : null;
    if (note) {
      tip.textContent = note;
      tip.classList.remove('warn');
      show(tip, true);
    } else show(tip, false);
  }

  // ---------- сохранение ----------
  function makeRecord(p: { totalReps: number; cleanReps: number; holdMs: number; cleanHoldMs: number; side: Side; endWall: number }): SetRecord {
    const holdMs = Math.min(p.holdMs, config.set.maxDurationMs); // ровно 10 минут удержания тоже сохраняются
    return {
      id: setId,
      exercise,
      startedAt: new Date(countStartWall).toISOString(),
      endedAt: new Date(Math.max(p.endWall, countStartWall)).toISOString(),
      totalReps: p.totalReps,
      cleanReps: p.cleanReps,
      ...(isHold ? { holdMs, cleanHoldMs: Math.min(p.cleanHoldMs, holdMs) } : {}),
      side: p.side,
      source: fileMode ? 'file' : 'camera',
      configVersion: config.version,
    };
  }

  /** Черновик подхода в истории. Итог при завершении перезапишет его под тем же id. */
  async function persistDraft() {
    if (phase !== 'counting' || finalized || !setId) return;
    lastDraftAt = performance.now();
    const d = analyzer.debug();
    if (!d.side || !(isHold ? d.holdMs >= 1000 : reps.length > 0)) return;
    const record = makeRecord({
      totalReps: isHold ? 0 : reps.length,
      cleanReps: isHold ? 0 : reps.filter((r) => r.errors.length === 0).length,
      holdMs: d.holdMs,
      cleanHoldMs: d.cleanHoldMs,
      side: d.side,
      endWall: fileMode ? countStartWall + lastT : Date.now(),
    });
    try {
      await saveSet(record, isHold ? [] : reps.map((r) => ({ ...r, setId })), config);
    } catch {
      /* черновик не критичен: итог сохранится при завершении */
    }
  }

  // ---------- завершение ----------
  /** Есть что сохранять: повторения или хотя бы секунда удержания. */
  const didSomething = () => {
    const d = analyzer.debug();
    return isHold ? d.holdMs >= 1000 : d.reps > 0;
  };

  async function finalize(reason: FinishReason, navigate = true) {
    if (finalized) return;
    if (phase !== 'counting') {
      if (fileMode) {
        hook.error = hook.error ?? 'NOT_STARTED';
        hook.done = true;
      }
      leave();
      return;
    }
    finalized = true;
    setPhase('saving');
    const summary = analyzer.finish(lastT, reason);
    hook.summary = summary;
    stopEverything();
    const record = makeRecord({
      totalReps: summary.totalReps,
      cleanReps: summary.cleanReps,
      holdMs: summary.holdMs,
      cleanHoldMs: summary.cleanHoldMs,
      side: summary.side,
      endWall: fileMode ? countStartWall + summary.durationMs : Date.now(),
    });
    let saveError: string | null = null;
    if (isHold ? summary.holdMs >= 1000 : summary.totalReps > 0) {
      const reps: RepRecord[] = summary.reps.map((r) => ({ ...r, setId: record.id }));
      try {
        await saveSet(record, reps, config);
      } catch (e) {
        saveError = appError(e, 'STORAGE_UNAVAILABLE').message;
      }
    }
    app.last = { summary, record, saveError };
    hook.done = true;
    // заменяем запись истории: системная «назад» с итога ведёт на главную, а не снова включает камеру
    if (navigate) app.navigate('/summary', true);
  }

  function stopEverything() {
    stopped = true;
    clearTimeout(tipTimer);
    stopStream(stream);
    stream = null;
    video.pause();
    wakeLock?.release().catch(() => undefined);
    wakeLock = null;
  }

  function leave() {
    stopEverything();
    app.voice.cancel();
    app.navigate('/');
  }

  /** «Назад»: если повторения уже есть, подход сохраняется, как по кнопке «Закончить». */
  function back() {
    if (phase === 'counting' && didSomething()) void finalize('user');
    else leave();
  }

  const onHidden = () => {
    if (document.hidden) {
      app.voice.cancel();
      // вкладку могут выгрузить в фоне — сохраняем сделанное прямо сейчас
      void persistDraft();
    } else if (!stopped) {
      wakeLock = null; // браузер снимает блокировку, когда вкладка скрыта
      void requestWakeLock();
    }
  };
  document.addEventListener('visibilitychange', onHidden);
  const onPageHide = () => void persistDraft();
  window.addEventListener('pagehide', onPageHide);

  void boot();
  return () => {
    document.removeEventListener('visibilitychange', onHidden);
    window.removeEventListener('pagehide', onPageHide);
    // системная «назад» на телефоне уводит со страницы минуя кнопки — сохраняем начатый подход
    if (!finalized && phase === 'counting' && didSomething()) void finalize('user', false);
    stopEverything();
    view.remove();
  };
}
