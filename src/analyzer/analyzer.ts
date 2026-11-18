// Анализатор подхода: чистые функции, без DOM. Слои:
// 1) сигнал (угол в колене или локте), 2) сглаживание, 3) автомат с подстройкой под стойку, 4) правила техники.
import type { AppConfig, ExerciseConfig } from '../config';
import { errorType } from '../config';
import type {
  AnalyzerEvent,
  ErrorCode,
  Exercise,
  FinishReason,
  MachineState,
  PoseFrame,
  Rep,
  SetSummary,
  Side,
  Status,
} from '../types';
import {
  allVisible,
  angleAt,
  angleAt3,
  hipOffsetFromLine,
  jointIndex,
  median3,
  px,
  shoulderRatio,
  thighAngle,
  tiltFromHorizontal,
  tiltFromVertical,
  visibilityOf,
} from './geometry';

/** Суставы, по которым считаем повторение: угол берётся в средней точке. */
function countJoints(exercise: Exercise, side: Side): [number, number, number] {
  return exercise === 'squat'
    ? [jointIndex(side, 'hip'), jointIndex(side, 'knee'), jointIndex(side, 'ankle')]
    : [jointIndex(side, 'shoulder'), jointIndex(side, 'elbow'), jointIndex(side, 'wrist')];
}

/** Точки, по видимости которых выбираем сторону (сбоку дальняя сторона закрыта телом). */
function sideJoints(exercise: Exercise, side: Side): number[] {
  return exercise === 'squat'
    ? (['shoulder', 'hip', 'knee', 'ankle'] as const).map((j) => jointIndex(side, j))
    : (['shoulder', 'elbow', 'wrist', 'hip', 'knee'] as const).map((j) => jointIndex(side, j));
}

interface Bottom {
  thigh: number; // угол бедра к горизонтали, > 0 — таз выше колена
  torsoTilt: number; // наклон корпуса от вертикали; NaN, если плечо не видно
  bodyTilt: number; // для отжиманий: наклон тела от горизонтали; NaN, если не посчитать
}

export interface AnalyzerDebug {
  phase: 'prepare' | 'counting' | 'finished';
  state: MachineState;
  status: Status | null;
  side: Side;
  sideLocked: boolean;
  angle: number | null;
  rawAngle: number | null;
  reps: number;
  top: number;
  start: number;
  ref: number | null;
}

export interface Analyzer {
  /** Передать очередной кадр (или null, если человека в кадре нет). tMs должны расти. */
  push(frame: PoseFrame | null, tMs: number): AnalyzerEvent[];
  /** Закончить подготовку и начать счёт. */
  startCounting(tMs: number): void;
  /** Итог подхода. */
  finish(tMs: number, reason?: FinishReason): SetSummary;
  debug(): AnalyzerDebug;
}

export function createAnalyzer(exercise: Exercise, config: AppConfig): Analyzer {
  const ex: ExerciseConfig = exercise === 'squat' ? config.squat : config.pushup;
  const visMin = config.visibility.min;
  const { tauMs, gapResetMs } = config.smoothing;
  const { topMargin, startMargin } = config.calibration;

  let phase: 'prepare' | 'counting' | 'finished' = 'prepare';
  let state: MachineState = 'WAITING';
  let status: Status | null = null;
  let side: Side = 'left';
  let sideLocked = false; // сторону фиксируем только при входе в «вверху»
  let lastT = -Infinity;

  // видимость сторон за последнюю секунду
  const window: { t: number; l: number; r: number; lz: number; rz: number }[] = [];
  let okSince: number | null = null;
  let ready = false;
  let invisibleSince: number | null = null;

  // сигнал и сглаживание
  let ema: number | null = null;
  let emaT = 0;
  let raw: number | null = null;
  const rawBuf: number[] = [];

  // автомат
  let countStart = 0;
  let lastRepAt = 0;
  let stand: { t: number; v: number }[] = []; // окно стойки для калибровки
  let topRun = 0; // кадров подряд выше порога «верх» (вход без замирания)
  let waitingOkSince: number | null = null;
  let lastHintAt = -Infinity;
  let wrongSince: number | null = null; // неверное положение во время подхода
  let awaySince: number | null = null; // человек ушёл или встал из упора после повторений
  let ref: number | null = null; // угол в стойке
  let topThr = ex.top;
  let startThr = ex.start;
  let repStart = 0;
  let minAngle = Infinity; // по медиане трёх сырых значений
  let minEma = Infinity; // по сглаженному сигналу
  let riseMax = -Infinity; // максимум после нижней точки (для «мягкого верха»)
  let riseMaxT = 0;
  let bottom: Bottom | null = null;
  let lineBadSince: number | null = null;
  let lineBadMax = 0;
  let lineOffset = NaN;
  let lineWorst = Infinity;
  let lastTipAt = -Infinity;
  let finishedReason: FinishReason | null = null;
  const reps: Rep[] = [];

  const priority = (code: ErrorCode) => errorType(config, code).priority;

  // ---------- сторона и положение ----------
  function meanOf(frame: PoseFrame, s: Side, key: 'visibility' | 'z'): number {
    const idx = sideJoints(exercise, s);
    return idx.reduce((acc, i) => acc + (frame.landmarks[i]?.[key] ?? 0), 0) / idx.length;
  }

  function updateWindow(frame: PoseFrame | null, tMs: number) {
    if (frame) {
      window.push({ t: tMs, l: meanOf(frame, 'left', 'visibility'), r: meanOf(frame, 'right', 'visibility'), lz: meanOf(frame, 'left', 'z'), rz: meanOf(frame, 'right', 'z') });
    }
    while (window.length && tMs - window[0].t > 1000) window.shift();
  }

  function bestSide(): Side {
    if (window.length === 0) return side;
    let l = 0, r = 0, lz = 0, rz = 0;
    for (const w of window) {
      l += w.l;
      r += w.r;
      lz += w.lz;
      rz += w.rz;
    }
    const n = window.length;
    if (Math.abs(l - r) / n < 0.1) return lz <= rz ? 'left' : 'right'; // видимость почти равна — берём ближнюю к камере
    return l >= r ? 'left' : 'right';
  }

  /** Наклон тела от горизонтали для отжиманий: по плечу и колену (или тазу, если колено не видно). */
  function bodyTilt(frame: PoseFrame, s: Side): number {
    const shoulder = px(frame, jointIndex(s, 'shoulder'));
    const kneeI = jointIndex(s, 'knee');
    const far = visibilityOf(frame, kneeI) >= visMin ? px(frame, kneeI) : px(frame, jointIndex(s, 'hip'));
    return tiltFromHorizontal(shoulder, far);
  }

  /**
   * Во всех режимах человек должен стоять боком к камере.
   * prepare — подготовка: для приседаний корпус вертикально, для отжиманий можно стоять.
   * stance — исходное положение: приседания — корпус вертикально, отжимания — тело почти горизонтально.
   * motion — во время повторения: для приседаний корпус может наклоняться, для отжиманий тело горизонтально.
   */
  function positionOk(frame: PoseFrame, s: Side, mode: 'prepare' | 'stance' | 'motion'): boolean {
    const ratio = shoulderRatio(frame);
    if (!Number.isNaN(ratio) && ratio > config.position.maxShoulderRatio) return false; // стоит лицом к камере
    if (exercise === 'squat') {
      if (mode === 'motion') return true;
      return !(tiltFromVertical(px(frame, jointIndex(s, 'shoulder')), px(frame, jointIndex(s, 'hip'))) > config.position.squatMaxTorsoTilt);
    }
    if (mode === 'prepare') return true;
    return !(bodyTilt(frame, s) > config.position.pushupMaxBodyTilt);
  }

  function setStatus(next: Status, out: AnalyzerEvent[]) {
    if (status !== next) {
      status = next;
      out.push({ type: 'status', status: next });
    }
  }

  /** Видимость с задержкой: «не видно» объявляем, только если пропало дольше lostAfterMs. */
  function visibilityGate(visible: boolean, tMs: number): 'visible' | 'grace' | 'lost' {
    if (visible) {
      invisibleSince = null;
      return 'visible';
    }
    if (invisibleSince === null) invisibleSince = tMs;
    return tMs - invisibleSince >= config.visibility.lostAfterMs ? 'lost' : 'grace';
  }

  // ---------- сигнал ----------
  function signal(frame: PoseFrame, s: Side): number {
    const [a, b, c] = countJoints(exercise, s);
    if (ex.signal === 'angle3d' && frame.world && frame.world.length >= 33) {
      const v = angleAt3(frame.world[a], frame.world[b], frame.world[c]);
      if (!Number.isNaN(v)) return v;
    }
    return angleAt(px(frame, a), px(frame, b), px(frame, c));
  }

  let lastDt = 0; // интервал до предыдущего кадра

  /** Экспоненциальное сглаживание с учётом реального интервала между кадрами. */
  function smooth(v: number, tMs: number): number {
    lastDt = ema === null ? 0 : tMs - emaT;
    if (ema === null || tMs - emaT > gapResetMs) {
      ema = v;
      rawBuf.length = 0;
      stand = [];
    } else {
      const a = tauMs <= 0 ? 1 : 1 - Math.exp(-(tMs - emaT) / tauMs);
      ema = a * v + (1 - a) * ema;
    }
    emaT = tMs;
    rawBuf.push(v);
    if (rawBuf.length > 3) rawBuf.shift();
    return ema;
  }

  function resetSignal() {
    ema = null;
    rawBuf.length = 0;
    stand = [];
    topRun = 0;
  }

  // ---------- подготовка ----------
  function pushPrepare(frame: PoseFrame | null, tMs: number, out: AnalyzerEvent[]) {
    updateWindow(frame, tMs);
    side = bestSide();
    const visible = !!frame && allVisible(frame, countJoints(exercise, side), visMin);
    const gate = visibilityGate(visible, tMs);
    if (gate === 'lost' || (gate === 'grace' && status === null)) setStatus('NOT_VISIBLE', out);
    else if (gate === 'visible' && frame) setStatus(positionOk(frame, side, 'prepare') ? 'OK' : 'WRONG_POSITION', out);
    if (status === 'OK' && gate === 'visible') {
      if (okSince === null) okSince = tMs;
    } else if (gate !== 'grace') {
      okSince = null;
    }
    // Сигнал считаем уже на подготовке: стойку во время отсчёта запоминаем, и первое повторение после «Начали» не теряется.
    if (gate === 'visible' && frame && status === 'OK') {
      const v = signal(frame, side);
      if (!Number.isNaN(v)) {
        raw = v;
        const s = smooth(v, tMs);
        if (positionOk(frame, side, 'stance')) feedStand(s, tMs);
        else stand = [];
      }
    } else if (gate === 'lost') {
      resetSignal();
    }
    const nowReady = okSince !== null && tMs - okSince >= config.prepare.readyHoldMs;
    if (nowReady !== ready) {
      ready = nowReady;
      out.push({ type: 'ready', ready });
    }
  }

  // ---------- автомат и правила ----------
  function calibrate(r: number) {
    ref = r;
    topThr = Math.min(ex.top, r - topMargin);
    startThr = Math.min(ex.start, r - startMargin);
  }

  function feedStand(v: number, tMs: number) {
    stand.push({ t: tMs, v });
    // держим самое короткое окно, которое ещё покрывает topHoldMs (работает и при 5 кадрах/с)
    while (stand.length > 2 && tMs - stand[1].t >= ex.topHoldMs) stand.shift();
  }

  /** Стойка: за topHoldMs угол почти не менялся и человек достаточно выпрямлен. */
  function standReached(tMs: number): boolean {
    if (stand.length < 2 || tMs - stand[0].t < ex.topHoldMs) return false;
    let lo = Infinity, hi = -Infinity;
    for (const p of stand) {
      lo = Math.min(lo, p.v);
      hi = Math.max(hi, p.v);
    }
    if (hi - lo > 8) return false;
    const sorted = stand.map((p) => p.v).sort((a, b) => a - b);
    const r = sorted[Math.floor(sorted.length / 2)];
    // выпрямлен: от стойки до порога «засчитано» есть запас для начала и конца повторения
    if (Math.min(ex.start, r - startMargin) <= ex.attempt + 5) return false;
    calibrate(r);
    return true;
  }

  function resetRep() {
    minAngle = Infinity;
    minEma = Infinity;
    riseMax = -Infinity;
    bottom = null;
    lineBadSince = null;
    lineBadMax = 0;
    lineOffset = NaN;
    lineWorst = Infinity;
  }

  function trackInRep(frame: PoseFrame, s: Side, tMs: number) {
    const m = median3(rawBuf); // медиана сырых значений: EMA завышает минимум
    if (m < minAngle) {
      minAngle = m;
      const sh = jointIndex(s, 'shoulder');
      const hipI = jointIndex(s, 'hip');
      bottom = {
        thigh: exercise === 'squat' ? thighAngle(px(frame, hipI), px(frame, jointIndex(s, 'knee'))) : NaN,
        torsoTilt: visibilityOf(frame, sh) >= visMin ? tiltFromVertical(px(frame, sh), px(frame, hipI)) : NaN,
        bodyTilt: exercise === 'pushup' && visibilityOf(frame, hipI) >= visMin * 0.5 ? bodyTilt(frame, s) : NaN,
      };
    }
    if (exercise === 'pushup') {
      const idx = [jointIndex(s, 'shoulder'), jointIndex(s, 'hip'), jointIndex(s, 'knee')];
      if (!allVisible(frame, idx, visMin)) {
        lineBadSince = null;
        return;
      }
      const [sh, hp, kn] = idx.map((i) => px(frame, i));
      const line = angleAt(sh, hp, kn);
      if (line < config.pushup.minBodyLine) {
        if (lineBadSince === null) lineBadSince = tMs;
        lineBadMax = Math.max(lineBadMax, tMs - lineBadSince);
        if (line < lineWorst) {
          lineWorst = line;
          lineOffset = hipOffsetFromLine(sh, hp, kn, 0.05 * frame.width);
        }
      } else {
        lineBadSince = null;
      }
    }
  }

  function evaluate(): ErrorCode[] {
    const errs: ErrorCode[] = [];
    if (exercise === 'squat') {
      const c = config.squat;
      if (bottom && bottom.thigh > c.maxThighAngle) errs.push('SQUAT_DEPTH');
      if (bottom && bottom.torsoTilt > c.maxLean) errs.push('SQUAT_LEAN');
    } else {
      const c = config.pushup;
      if (lineBadMax >= c.bodyLineHoldMs && !Number.isNaN(lineOffset)) errs.push(lineOffset > 0 ? 'PUSHUP_HIP_SAG' : 'PUSHUP_HIP_PIKE');
      if (minAngle > c.clean) errs.push('PUSHUP_DEPTH');
    }
    return errs.sort((a, b) => priority(a) - priority(b));
  }

  function checkFinish(tMs: number, out: AnalyzerEvent[]) {
    if (phase !== 'counting') return;
    // человек ушёл или встал из упора после повторений — подход окончен
    if (reps.length > 0 && (status === 'NOT_VISIBLE' || status === 'WRONG_POSITION')) {
      if (awaySince === null) awaySince = tMs;
    } else {
      awaySince = null;
    }
    let reason: FinishReason | null = null;
    if (reps.length >= config.set.maxReps) reason = 'maxReps';
    else if (tMs - countStart >= config.set.maxDurationMs) reason = 'maxDuration';
    else if (awaySince !== null && tMs - awaySince >= config.set.awayStopMs) reason = 'away';
    else if (tMs - lastRepAt >= config.set.idleStopMs) reason = 'idle';
    if (reason) {
      phase = 'finished';
      finishedReason = reason;
      out.push({ type: 'finish', reason });
    }
  }

  function enterTop() {
    state = 'TOP';
    sideLocked = true;
    topRun = 0;
    waitingOkSince = null;
  }

  function toWaiting() {
    state = 'WAITING';
    sideLocked = false;
    stand = [];
    topRun = 0;
    resetRep();
  }

  function pushCounting(frame: PoseFrame | null, tMs: number, out: AnalyzerEvent[]) {
    if (!sideLocked) {
      updateWindow(frame, tMs);
      side = bestSide(); // пока не встал в исходное положение, сторону можно сменить (лёг в упор другим боком)
    }
    const s = side;
    const visible = !!frame && allVisible(frame, countJoints(exercise, s), visMin);
    const gate = visibilityGate(visible, tMs);
    if (gate !== 'visible' || !frame) {
      if (gate === 'lost' && state !== 'PAUSED') {
        toWaiting();
        state = 'PAUSED';
        resetSignal();
        setStatus('NOT_VISIBLE', out);
      }
      return;
    }
    if (state === 'PAUSED') state = 'WAITING';
    const value = signal(frame, s);
    if (Number.isNaN(value)) return;
    raw = value;
    const v = smooth(value, tMs);
    if (state === 'WAITING') {
      if (!positionOk(frame, s, 'stance')) {
        setStatus('WRONG_POSITION', out);
        stand = [];
        topRun = 0;
        waitingOkSince = null;
        return;
      }
      setStatus('OK', out);
      feedStand(v, tMs);
      topRun = v >= ex.top ? topRun + 1 : 0;
      // выше порога «верх» два кадра подряд, а при редких кадрах (5–6 в секунду) хватит одного
      const needRun = lastDt >= 150 ? 1 : 2;
      if (standReached(tMs)) enterTop();
      else if (topRun >= needRun) {
        // выпрямился без паузы — пороги по умолчанию
        ref = null;
        topThr = ex.top;
        startThr = ex.start;
        enterTop();
      } else {
        waitingOkSince ??= tMs;
        if (tMs - waitingOkSince >= config.set.waitHintMs && tMs - lastHintAt >= config.set.waitHintMs) {
          lastHintAt = tMs;
          out.push({ type: 'hint', code: 'STAND_STILL' });
        }
      }
      return;
    }

    // Во время подхода тоже следим за положением: встал из упора или развернулся — это не повторение.
    if (!positionOk(frame, s, 'motion')) {
      wrongSince ??= tMs;
      if (tMs - wrongSince >= 500) {
        wrongSince = null;
        toWaiting();
        setStatus('WRONG_POSITION', out);
        return;
      }
    } else {
      wrongSince = null;
      setStatus('OK', out);
    }

    if (state === 'TOP') {
      if (v < startThr) beginRep(frame, s, v, tMs);
      return;
    }
    // IN_REP
    trackInRep(frame, s, tMs);
    if (v < minEma) {
      minEma = v;
      riseMax = -Infinity;
    } else if (v > riseMax) {
      riseMax = v;
      riseMaxT = tMs;
    }
    // «Мягкий верх»: человек не выпрямился до порога, но явно поднялся и снова пошёл вниз.
    const softTop = softRise() && v <= riseMax - 10;
    if (v >= topThr || softTop) {
      closeRep(softTop ? riseMaxT : tMs, out);
      if (softTop) beginRep(frame, s, v, tMs);
      else state = 'TOP';
    }
  }

  function softRise(): boolean {
    return Number.isFinite(riseMax) && riseMax - minEma >= 0.75 * (topThr - minEma);
  }

  function beginRep(frame: PoseFrame, s: Side, v: number, tMs: number) {
    state = 'IN_REP';
    repStart = tMs;
    resetRep();
    minEma = v;
    trackInRep(frame, s, tMs);
  }

  function closeRep(tMs: number, out: AnalyzerEvent[]) {
    const duration = tMs - repStart;
    // отжимание засчитываем, только если в нижней точке человек был в упоре, а не стоял
    const inPlank = exercise !== 'pushup' || !bottom || Number.isNaN(bottom.bodyTilt) || bottom.bodyTilt <= config.position.pushupMaxBodyTilt;
    if (minAngle <= ex.attempt && duration >= ex.minRepMs && inPlank) {
      const errors = evaluate();
      const rep: Rep = {
        index: reps.length + 1,
        tStartMs: Math.round(repStart - countStart),
        tEndMs: Math.round(tMs - countStart),
        minAngle: Math.round(minAngle),
        errors,
      };
      reps.push(rep);
      lastRepAt = tMs;
      out.push({ type: 'rep', rep });
      if (errors.length && tMs - lastTipAt >= config.feedback.minTipIntervalMs) {
        lastTipAt = tMs;
        out.push({ type: 'tip', code: errors[0] });
      }
    }
    resetRep();
  }

  return {
    push(frame, tMs) {
      const out: AnalyzerEvent[] = [];
      if (phase === 'finished' || !(tMs > lastT)) return out;
      lastT = tMs;
      if (phase === 'prepare') pushPrepare(frame, tMs, out);
      else {
        pushCounting(frame, tMs, out);
        checkFinish(tMs, out);
      }
      return out;
    },
    startCounting(tMs) {
      if (phase !== 'prepare') return;
      phase = 'counting';
      state = 'WAITING';
      countStart = tMs;
      lastRepAt = tMs;
      sideLocked = false;
      waitingOkSince = null;
      // сигнал и окно стойки с подготовки не сбрасываем
    },
    finish(tMs, reason = 'user') {
      // последнее повторение без полного выпрямления: подъём прошёл три четверти пути
      if (phase === 'counting' && state === 'IN_REP' && softRise()) {
        closeRep(riseMaxT, []);
        state = 'TOP';
      }
      if (phase !== 'finished') {
        phase = 'finished';
        finishedReason = reason;
      }
      const errorsCount: Partial<Record<ErrorCode, number>> = {};
      for (const r of reps) for (const e of r.errors) errorsCount[e] = (errorsCount[e] ?? 0) + 1;
      return {
        exercise,
        side,
        totalReps: reps.length,
        cleanReps: reps.filter((r) => r.errors.length === 0).length,
        errorsCount,
        reps: reps.slice(),
        durationMs: Math.max(0, Math.round(tMs - countStart)),
        finishReason: finishedReason ?? reason,
      };
    },
    debug() {
      return { phase, state, status, side, sideLocked, angle: ema, rawAngle: raw, reps: reps.length, top: topThr, start: startThr, ref };
    },
  };
}
