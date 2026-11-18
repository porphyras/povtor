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
  torsoTilt: number; // NaN, если плечо не видно
}

export interface AnalyzerDebug {
  phase: 'prepare' | 'counting' | 'finished';
  state: MachineState;
  status: Status | null;
  side: Side | null;
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
  /** Закончить подготовку и начать счёт. Сторона фиксируется до конца подхода. */
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
  let side: Side | null = null;
  let lastT = -Infinity;

  // подготовка
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

  function bestSide(): Side {
    if (window.length === 0) return 'left';
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

  /**
   * strict=false (подготовка): достаточно стоять боком к камере; для приседаний ещё и корпус вертикально.
   * strict=true (перед повторением): для отжиманий тело должно быть почти горизонтально.
   */
  function positionOk(frame: PoseFrame, s: Side, strict: boolean): boolean {
    const ratio = shoulderRatio(frame);
    if (!Number.isNaN(ratio) && ratio > config.position.maxShoulderRatio) return false; // стоит лицом к камере
    if (exercise === 'pushup' && !strict) return true;
    const shoulder = px(frame, jointIndex(s, 'shoulder'));
    const hip = px(frame, jointIndex(s, 'hip'));
    if (exercise === 'squat') return !(tiltFromVertical(shoulder, hip) > config.position.squatMaxTorsoTilt);
    const kneeI = jointIndex(s, 'knee');
    const far = visibilityOf(frame, kneeI) >= visMin ? px(frame, kneeI) : hip;
    return !(tiltFromHorizontal(shoulder, far) > config.position.pushupMaxBodyTilt);
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

  /** Экспоненциальное сглаживание с учётом реального интервала между кадрами. */
  function smooth(v: number, tMs: number): number {
    if (ema === null || tMs - emaT > gapResetMs) {
      ema = v;
      rawBuf.length = 0;
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
  }

  // ---------- подготовка ----------
  function pushPrepare(frame: PoseFrame | null, tMs: number, out: AnalyzerEvent[]) {
    if (frame) {
      window.push({ t: tMs, l: meanOf(frame, 'left', 'visibility'), r: meanOf(frame, 'right', 'visibility'), lz: meanOf(frame, 'left', 'z'), rz: meanOf(frame, 'right', 'z') });
    }
    while (window.length && tMs - window[0].t > 1000) window.shift();
    const s = bestSide();
    const visible = !!frame && allVisible(frame, countJoints(exercise, s), visMin);
    const gate = visibilityGate(visible, tMs);
    if (gate === 'lost' || (gate === 'grace' && status === null)) setStatus('NOT_VISIBLE', out);
    else if (gate === 'visible' && frame) setStatus(positionOk(frame, s, false) ? 'OK' : 'WRONG_POSITION', out);
    if (status === 'OK' && gate === 'visible') {
      if (okSince === null) okSince = tMs;
    } else if (gate !== 'grace') {
      okSince = null;
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

  /** Стойка найдена, если за topHoldMs угол почти не менялся и человек достаточно выпрямлен. */
  function standReached(v: number, tMs: number): boolean {
    stand.push({ t: tMs, v });
    while (stand.length && tMs - stand[0].t > ex.topHoldMs) stand.shift();
    if (stand.length < 2 || tMs - stand[0].t < ex.topHoldMs * 0.9) return false;
    let lo = Infinity, hi = -Infinity;
    for (const p of stand) {
      lo = Math.min(lo, p.v);
      hi = Math.max(hi, p.v);
    }
    if (hi - lo > 8) return false;
    const r = stand.map((p) => p.v).sort((a, b) => a - b)[Math.floor(stand.length / 2)];
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
      if (exercise === 'squat') {
        const sh = jointIndex(s, 'shoulder');
        const hipI = jointIndex(s, 'hip');
        bottom = {
          thigh: thighAngle(px(frame, hipI), px(frame, jointIndex(s, 'knee'))),
          torsoTilt: visibilityOf(frame, sh) >= visMin ? tiltFromVertical(px(frame, sh), px(frame, hipI)) : NaN,
        };
      }
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
    let reason: FinishReason | null = null;
    if (reps.length >= config.set.maxReps) reason = 'maxReps';
    else if (tMs - countStart >= config.set.maxDurationMs) reason = 'maxDuration';
    else if (tMs - lastRepAt >= config.set.idleStopMs) reason = 'idle';
    if (reason) {
      phase = 'finished';
      finishedReason = reason;
      out.push({ type: 'finish', reason });
    }
  }

  function pushCounting(frame: PoseFrame | null, tMs: number, out: AnalyzerEvent[]) {
    const s = side as Side;
    const visible = !!frame && allVisible(frame, countJoints(exercise, s), visMin);
    const gate = visibilityGate(visible, tMs);
    if (gate !== 'visible' || !frame) {
      if (gate === 'lost' && state !== 'PAUSED') {
        state = 'PAUSED';
        resetSignal();
        resetRep();
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
      if (!positionOk(frame, s, true)) {
        setStatus('WRONG_POSITION', out);
        stand = [];
        return;
      }
      setStatus('OK', out);
      if (standReached(v, tMs)) state = 'TOP';
      return;
    }
    setStatus('OK', out);
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
    const softTop = riseMax - minEma >= 0.75 * (topThr - minEma) && v <= riseMax - 10;
    if (v >= topThr || softTop) {
      const endT = softTop ? riseMaxT : tMs;
      closeRep(endT, out);
      if (softTop) beginRep(frame, s, v, tMs);
      else state = 'TOP';
    }
  }

  function beginRep(frame: PoseFrame, s: Side, v: number, tMs: number) {
    state = 'IN_REP';
    repStart = tMs;
    resetRep();
    minEma = v;
    trackInRep(frame, s, tMs);
  }

  function closeRep(tMs: number, out: AnalyzerEvent[]) {
    {
      const duration = tMs - repStart;
      if (minAngle <= ex.attempt && duration >= ex.minRepMs) {
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
      side = bestSide();
      phase = 'counting';
      state = 'WAITING';
      countStart = tMs;
      lastRepAt = tMs;
      invisibleSince = null;
      resetSignal();
      resetRep();
    },
    finish(tMs, reason = 'user') {
      if (phase !== 'finished') {
        phase = 'finished';
        finishedReason = reason;
      }
      const errorsCount: Partial<Record<ErrorCode, number>> = {};
      for (const r of reps) for (const e of r.errors) errorsCount[e] = (errorsCount[e] ?? 0) + 1;
      return {
        exercise,
        side: side ?? bestSide(),
        totalReps: reps.length,
        cleanReps: reps.filter((r) => r.errors.length === 0).length,
        errorsCount,
        reps: reps.slice(),
        durationMs: Math.max(0, Math.round(tMs - countStart)),
        finishReason: finishedReason ?? reason,
      };
    },
    debug() {
      return { phase, state, status, side, angle: ema, rawAngle: raw, reps: reps.length, top: topThr, start: startThr, ref };
    },
  };
}
