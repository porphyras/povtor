import { createAnalyzer, type Analyzer } from '../analyzer/analyzer';
import type { App } from '../app';
import { attachStream, attachVideoFile, startCamera, stopStream } from '../camera';
import { errorType } from '../config';
import { appError, PovtorError } from '../errors';
import type { PoseEngine } from '../pose';
import { saveSet } from '../storage';
import type { AnalyzerEvent, AppError, ErrorCode, Exercise, FinishReason, RepRecord, SetRecord, Status } from '../types';
import { numberWord } from '../voice';
import { clear, h, svg } from './dom';
import { EXERCISE_NAME } from '../history';
import { drawSkeleton } from './skeleton';

type Phase = 'loading' | 'error' | 'prepare' | 'countdown' | 'counting' | 'saving';

const SILHOUETTE: Record<Exercise, string> = {
  squat: `<svg viewBox="0 0 100 200" class="silhouette" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="7 6" stroke-linecap="round"><circle cx="52" cy="22" r="12"/><path d="M52 34 L50 100 M50 52 L64 84 M50 100 L48 146 L50 190 M50 100 L54 146 L52 190"/></g></svg>`,
  pushup: `<svg viewBox="0 0 200 100" class="silhouette wide" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="7 6" stroke-linecap="round"><circle cx="30" cy="40" r="11"/><path d="M42 46 L178 70 M48 47 L46 82 M178 70 L184 82"/></g></svg>`,
};

const HINT: Record<Exercise, string> = {
  squat: 'Встань боком к камере, чтобы было видно с головы до ног',
  pushup: 'Встань боком к камере, чтобы было видно с головы до ног. После отсчёта прими упор лёжа',
};

function statusText(ex: Exercise, s: Status | null, phase: Phase): string {
  if (s === 'NOT_VISIBLE' || s === null) return 'Не вижу тебя целиком. Отойди дальше от камеры';
  if (s === 'WRONG_POSITION') return ex === 'pushup' && phase === 'counting' ? 'Прими упор лёжа боком к камере' : 'Встань боком к камере';
  return 'Вижу целиком';
}

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
  const prepare = h('div', { class: 'prepare hidden' }, svg(SILHOUETTE[exercise]), h('p', { class: 'hint' }, HINT[exercise]), statusPill);
  const countdownEl = h('div', { class: 'countdown hidden', id: 'countdown' });
  const loadingText = h('p', null, 'Загружаем модель…');
  const bar = h('div', { class: 'bar-fill' });
  const loading = h('div', { class: 'overlay loading' }, h('div', { class: 'spinner' }), loadingText, h('div', { class: 'bar' }, bar));
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
    h('button', { class: 'icon-btn', 'aria-label': 'Назад', onclick: () => leave() }, '✕'),
    h('span', { class: 'title' }, EXERCISE_NAME[exercise]),
    fileMode ? (dev.dev ? h('span', { class: 'badge' }, 'видеофайл') : null) : switchBtn,
  );
  const view = h('main', { class: 'screen session' }, stage, prepare, countdownEl, counter, paused, tip, top, h('div', { class: 'bottombar' }, finishBtn), loading, errorBox, devPanel);
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
  let wakeLock: { release(): Promise<void> } | null = null;
  let gen = 0; // поколение запуска: после перезапуска старые циклы кадров останавливаются
  const fpsTimes: number[] = [];
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
    show(countdownEl, p === 'countdown');
    show(counter, p === 'counting');
    show(finishBtn, p === 'counting');
    if (p !== 'counting') show(paused, false);
  }

  function showError(err: AppError) {
    hook.error = err.code;
    clear(errorBox);
    errorBox.append(h('h2', null, 'Что-то пошло не так'), h('p', null, err.message));
    if (err.code === 'CAMERA_DENIED') {
      errorBox.append(
        h('p', { class: 'small' }, 'Chrome и Яндекс Браузер: значок камеры или замка в адресной строке → «Разрешить». Safari на iPhone: «аА» в адресной строке → «Настройки веб-сайта» → «Камера» → «Разрешить».'),
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
    try {
      engine = await app.getEngine((stage, share) => {
        if (stage === 'wasm') loadingText.textContent = 'Загружаем библиотеку…';
        if (stage === 'model') {
          loadingText.textContent = `Загружаем модель… ${Math.round((share ?? 0) * 100)}%`;
          bar.style.width = `${Math.round((share ?? 0) * 100)}%`;
        }
        if (stage === 'init' || stage === 'warmup') loadingText.textContent = 'Запускаем распознавание…';
      });
      if (stopped) return;
      loadingText.textContent = fileMode ? 'Открываем видео…' : 'Включаем камеру…';
      if (fileMode) {
        const src = new URL(dev.video as string, location.href);
        if (src.origin !== location.origin) throw new PovtorError('FILE_FORMAT', 'видео только с этого же сайта');
        await attachVideoFile(video, src.href);
      } else {
        stream = await startCamera({ facingMode: facing, ...config.camera });
        if (stopped) return stopStream(stream);
        await attachStream(video, stream);
      }
      if (stopped) return;
      view.classList.toggle('mirror', !fileMode && facing === 'user');
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
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
      if (stopped) return;
      console.error(e);
      showError(appError(e, 'MODEL_LOAD'));
    }
  }

  function restart() {
    gen++;
    stopStream(stream);
    stream = null;
    void boot();
  }

  async function switchCamera() {
    if (fileMode || phase === 'loading') return;
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
        tick(fileMode ? meta.mediaTime * 1000 : performance.now());
        schedule(my);
      });
    } else {
      requestAnimationFrame(() => {
        if (my !== gen) return;
        tick(fileMode ? video.currentTime * 1000 : performance.now());
        schedule(my);
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
      tick(t * 1000);
      await new Promise((r) => setTimeout(r, 0));
    }
    if (!stopped && !finalized && my === gen) void finalize('user');
  }

  function tick(tA: number) {
    if (stopped || finalized || !engine || video.readyState < 2) return;
    if (!(tA > lastT)) return;
    lastT = tA;
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
    drawSkeleton(ctx, frame, dbg.side, config.visibility.min, !tip.classList.contains('hidden'));

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
        `повторений ${dbg.reps}  кадров/с ${hook.fps}`,
        `модель ${engine.variant}, ${engine.delegate}  видео ${video.videoWidth}×${video.videoHeight}`,
      ].join('\n');
    }
  }

  function beginCounting(tA: number) {
    analyzer.startCounting(tA);
    countStartWall = Date.now() - (fileMode ? tA : 0);
    setPhase('counting');
    counter.textContent = '0';
    app.voice.say('Начали');
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
    nav.wakeLock?.request('screen').then((l) => (wakeLock = l)).catch(() => undefined);
  }

  function handle(events: AnalyzerEvent[], tA: number) {
    let repIndex = 0;
    let tipCode: ErrorCode | null = null;
    for (const e of events) {
      if (e.type === 'status') {
        status = e.status;
        statusPill.textContent = statusText(exercise, status, phase);
        statusPill.classList.toggle('ok', status === 'OK');
        if (phase === 'counting') {
          show(paused, status === 'NOT_VISIBLE');
          if (status === 'WRONG_POSITION') showTip(statusText(exercise, status, phase), false);
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
        counter.textContent = String(e.rep.index);
        counter.classList.remove('pulse');
        void counter.offsetWidth;
        counter.classList.add('pulse');
      } else if (e.type === 'tip') {
        tipCode = e.code;
      } else if (e.type === 'finish') {
        void finalize(e.reason);
      }
    }
    if (repIndex) {
      const t = tipCode ? errorType(config, tipCode) : null;
      app.voice.say(numberWord(repIndex) + (t ? '. ' + t.voice : ''));
      if (t) showTip(t.screen, true);
    }
  }

  function showTip(text: string, warn: boolean) {
    tip.textContent = text;
    tip.classList.toggle('warn', warn);
    show(tip, true);
    clearTimeout(tipTimer);
    tipTimer = window.setTimeout(() => show(tip, false), config.feedback.tipVisibleMs);
  }

  // ---------- завершение ----------
  async function finalize(reason: FinishReason) {
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
    const endWall = fileMode ? countStartWall + summary.durationMs : Date.now();
    const record: SetRecord = {
      id: uuid(),
      exercise,
      startedAt: new Date(countStartWall).toISOString(),
      endedAt: new Date(Math.max(endWall, countStartWall)).toISOString(),
      totalReps: summary.totalReps,
      cleanReps: summary.cleanReps,
      side: summary.side,
      source: fileMode ? 'file' : 'camera',
      configVersion: config.version,
    };
    let saveError: string | null = null;
    if (summary.totalReps > 0) {
      const reps: RepRecord[] = summary.reps.map((r) => ({ ...r, setId: record.id }));
      try {
        await saveSet(record, reps, config);
      } catch (e) {
        saveError = appError(e, 'STORAGE_UNAVAILABLE').message;
      }
    }
    app.last = { summary, record, saveError };
    hook.done = true;
    app.navigate('/summary');
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

  const onHidden = () => {
    if (document.hidden) app.voice.cancel();
  };
  document.addEventListener('visibilitychange', onHidden);

  void boot();
  return () => {
    document.removeEventListener('visibilitychange', onHidden);
    stopEverything();
    view.remove();
  };
}
