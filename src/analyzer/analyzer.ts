// Анализатор подхода: чистые функции, без DOM. Слои:
// 1) сигнал (угол из описания упражнения), 2) сглаживание, 3) автомат с подстройкой под стойку, 4) правила техники.
// Упражнения на удержание (планка, «стульчик») идут отдельной веткой: копится время в позе.
//
// Автомат работает в «пространстве сигнала» s: для упражнений «вниз» s = угол, для упражнений «вверх» s = 360 − угол.
// Тогда исходное положение — всегда большие s, а повторение — провал s и возврат.
import type { AppConfig, RepConfig } from '../config';
import { errorType } from '../config';
import type { AnalyzerEvent, ErrorCode, Exercise, FinishReason, MachineState, PoseFrame, Rep, SetSummary, Side, Status } from '../types';
import { allVisible, median3 } from './geometry';
import { newTrack, SPECS, type Ctx, type ExerciseSpec, type PosMode, type RepTrack } from './exercises';

export interface AnalyzerDebug {
  phase: 'prepare' | 'counting' | 'finished';
  state: MachineState;
  status: Status | null;
  side: Side;
  sideLocked: boolean;
  angle: number | null; // сглаженный сигнал, естественный угол
  rawAngle: number | null;
  reps: number;
  top: number; // текущие пороги, естественные углы
  start: number;
  ref: number | null;
  holdMs: number;
  cleanHoldMs: number;
  holding: boolean;
  /** Время последнего кадра, на котором удалось посчитать угол упражнения (например, в выпадах видна дальняя нога). */
  lastValueT: number | null;
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
  const spec: ExerciseSpec = SPECS[exercise];
  const isHold = spec.kind === 'hold';
  const rcfg = (isHold ? null : config.exercises[exercise]) as RepConfig | null;
  const up = rcfg?.direction === 'up';
  const S = (x: number) => (up ? 360 - x : x); // в пространство сигнала и обратно (инволюция)
  const sTop = rcfg ? S(rcfg.top) : 0;
  const sStart = rcfg ? S(rcfg.start) : 0;
  const sAttempt = rcfg ? S(rcfg.attempt) : 0;
  const topMargin = rcfg?.topMargin ?? config.calibration.topMargin;
  const startMargin = rcfg?.startMargin ?? config.calibration.startMargin;
  const topHoldMs = rcfg?.topHoldMs ?? 500;
  const minRepMs = rcfg?.minRepMs ?? 400;
  const visMin = config.visibility.min;
  const { tauMs, gapResetMs } = config.smoothing;

  let phase: 'prepare' | 'counting' | 'finished' = 'prepare';
  let state: MachineState = 'WAITING';
  let status: Status | null = null;
  let side: Side = 'left';
  let sideLocked = spec.view === 'front'; // спереди сторона не нужна
  let lastT = -Infinity;

  // видимость сторон за последнюю секунду
  const window: { t: number; l: number; r: number; lz: number; rz: number }[] = [];
  let okSince: number | null = null;
  let ready = false;
  let invisibleSince: number | null = null;

  // сигнал и сглаживание (в пространстве s)
  let ema: number | null = null;
  let emaT = 0;
  let lastDt = 0;
  let raw: number | null = null;
  let lastValueT: number | null = null;
  const rawBuf: number[] = [];

  // автомат повторений
  let countStart = 0;
  let lastRepAt = 0;
  let stand: { t: number; v: number }[] = [];
  let topRun = 0;
  let waitingOkSince: number | null = null;
  let lastHintAt = -Infinity;
  let hintCount = 0;
  let wrongSince: number | null = null;
  let awaySince: number | null = null;
  let ref: number | null = null; // опорный сигнал стойки (s)
  let topThr = sTop;
  let startThr = sStart;
  let repStart = 0;
  let minS = Infinity; // по медиане трёх сырых значений
  let minEma = Infinity;
  let riseMax = -Infinity;
  let riseMaxT = 0;
  let track: RepTrack = newTrack();
  let lastTipAt = -Infinity;
  let finishedReason: FinishReason | null = null;
  const reps: Rep[] = [];

  // удержание
  let holding = false;
  let holdMs = 0;
  let cleanHoldMs = 0;
  let outOfPoseSince: number | null = null;
  let badSince: number | null = null;
  let badCode: ErrorCode | null = null; // ошибка, которая держится сейчас
  const holdErrors: Partial<Record<ErrorCode, number>> = {};
  const holdBuf: { t: number; v: number }[] = [];
  let poseSince: number | null = null;

  const priority = (code: ErrorCode) => errorType(config, code).priority;
  const ctx = (frame: PoseFrame): Ctx => ({ f: frame, ex: exercise, viewOk: status === null ? undefined : status !== 'WRONG_POSITION', side, config, visMin });

  // ---------- сторона и положение ----------
  function meanOf(frame: PoseFrame, s: Side, key: 'visibility' | 'z'): number {
    const idx = spec.sidePoints(s);
    if (!idx.length) return 0;
    return idx.reduce((acc, i) => acc + (frame.landmarks[i]?.[key] ?? 0), 0) / idx.length;
  }

  function updateWindow(frame: PoseFrame | null, tMs: number) {
    if (spec.view === 'front') return;
    if (frame) window.push({ t: tMs, l: meanOf(frame, 'left', 'visibility'), r: meanOf(frame, 'right', 'visibility'), lz: meanOf(frame, 'left', 'z'), rz: meanOf(frame, 'right', 'z') });
    while (window.length && tMs - window[0].t > 1000) window.shift();
  }

  function bestSide(): Side {
    if (spec.view === 'front' || window.length === 0) return side;
    let l = 0, r = 0, lz = 0, rz = 0;
    for (const w of window) {
      l += w.l;
      r += w.r;
      lz += w.lz;
      rz += w.rz;
    }
    if (Math.abs(l - r) / window.length < 0.1) return lz <= rz ? 'left' : 'right'; // видимость почти равна — берём ближнюю к камере
    return l >= r ? 'left' : 'right';
  }

  const positionOk = (frame: PoseFrame, mode: PosMode) => spec.position(ctx(frame), mode);

  /**
   * Нужные точки видны. Для упражнений лицом к камере: если видна только одна сторона, человек стоит боком —
   * считаем его видимым, а проверка положения скажет «Встань лицом к камере» вместо «Отойди дальше».
   */
  function visibleFor(frame: PoseFrame | null): boolean {
    if (!frame) return false;
    const pts = spec.countPoints(side);
    if (allVisible(frame, pts, visMin)) return true;
    if (spec.view !== 'front') return false;
    const half = pts.length / 2;
    return allVisible(frame, pts.slice(0, half), visMin) || allVisible(frame, pts.slice(half), visMin);
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
    const gate = visibilityGate(visibleFor(frame), tMs);
    if (gate === 'lost' || (gate === 'grace' && status === null)) setStatus('NOT_VISIBLE', out);
    else if (gate === 'visible' && frame) setStatus(!positionOk(frame, 'prepare') ? 'WRONG_POSITION' : spec.room && !spec.room(ctx(frame)) ? 'NO_ROOM' : 'OK', out);
    if (status === 'OK' && gate === 'visible') {
      if (okSince === null) okSince = tMs;
    } else if (gate !== 'grace') {
      okSince = null;
    }
    // Сигнал считаем уже на подготовке: стойку во время отсчёта запоминаем, и первое повторение после «Начали» не теряется.
    if (!isHold && gate === 'visible' && frame && status === 'OK') {
      const nat = spec.value(ctx(frame));
      if (!Number.isNaN(nat)) {
        raw = nat;
        const s = smooth(S(nat), tMs);
        if (positionOk(frame, 'stance')) feedStand(s, tMs);
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

  // ---------- автомат повторений ----------
  function calibrate(r: number) {
    ref = r;
    topThr = Math.min(sTop, r - topMargin);
    startThr = Math.min(sStart, r - startMargin);
  }

  /** Порог «засчитано»: из конфигурации, но не ближе 5° к порогу начала (если исходное положение сдвинуло пороги). */
  const attemptThr = () => Math.min(sAttempt, startThr - 5);

  function feedStand(v: number, tMs: number) {
    stand.push({ t: tMs, v });
    // держим самое короткое окно, которое ещё покрывает topHoldMs (работает и при 5 кадрах/с)
    while (stand.length > 2 && tMs - stand[1].t >= topHoldMs) stand.shift();
  }

  /** Стойка: за topHoldMs сигнал почти не менялся и человек в исходном положении. */
  function standReached(tMs: number): boolean {
    if (stand.length < 2 || tMs - stand[0].t < topHoldMs) return false;
    let lo = Infinity, hi = -Infinity;
    for (const p of stand) {
      lo = Math.min(lo, p.v);
      hi = Math.max(hi, p.v);
    }
    if (hi - lo > 8) return false;
    const sorted = stand.map((p) => p.v).sort((a, b) => a - b);
    const r = sorted[Math.floor(sorted.length / 2)];
    // исходное положение — до порога начала повторения (иначе человек замер посреди движения)
    if (r < sStart) return false;
    calibrate(r);
    return true;
  }

  function resetRep() {
    minS = Infinity;
    minEma = Infinity;
    riseMax = -Infinity;
    track = newTrack();
  }

  function trackInRep(frame: PoseFrame, tMs: number) {
    // медиана сырых значений: сглаживание завышает крайнюю точку. Сразу после разрыва в буфере 1–2 значения,
    // и один ошибочный кадр стал бы «повторением»: из одного не берём ничего, из двух — менее крайнее.
    const m = rawBuf.length >= 3 ? median3(rawBuf) : rawBuf.length === 2 ? Math.max(rawBuf[0], rawBuf[1]) : NaN;
    const c = ctx(frame);
    if (m < minS) {
      minS = m;
      if (spec.snapshot) track.snap = spec.snapshot(c);
    }
    spec.track?.(c, track, tMs);
  }

  function softRise(): boolean {
    return Number.isFinite(riseMax) && riseMax - minEma >= 0.75 * (topThr - minEma);
  }

  function beginRep(frame: PoseFrame, v: number, tMs: number) {
    state = 'IN_REP';
    repStart = tMs;
    resetRep();
    minEma = v;
    trackInRep(frame, tMs);
  }

  function closeRep(tMs: number, out: AnalyzerEvent[]) {
    const duration = tMs - repStart;
    const accepted = spec.accept ? spec.accept(track, config) : true;
    if (minS <= attemptThr() && duration >= minRepMs && accepted) {
      const extreme = S(minS);
      const errors = (spec.evaluate?.(track, extreme, config, ref === null ? null : S(ref)) ?? []).sort((a, b) => priority(a) - priority(b));
      const rep: Rep = {
        index: reps.length + 1,
        tStartMs: Math.round(repStart - countStart),
        tEndMs: Math.round(tMs - countStart),
        minAngle: Math.round(extreme),
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

  function enterTop() {
    hintCount = 0;
    state = 'TOP';
    sideLocked = true;
    topRun = 0;
    waitingOkSince = null;
  }

  function toWaiting(out: AnalyzerEvent[]) {
    // незакрытое повторение, после которого человек ушёл из кадра или встал, засчитываем, если обратный путь пройден на 3/4
    if (state === 'IN_REP' && softRise()) closeRep(riseMaxT, out);
    state = 'WAITING';
    sideLocked = spec.view === 'front';
    stand = [];
    topRun = 0;
    resetRep();
  }

  function pushReps(frame: PoseFrame, tMs: number, out: AnalyzerEvent[]) {
    const nat = spec.value(ctx(frame));
    if (Number.isNaN(nat)) return;
    raw = nat;
    lastValueT = tMs;
    const v = smooth(S(nat), tMs);

    if (state === 'WAITING') {
      const noRoom = spec.room && !spec.room(ctx(frame));
      if (!positionOk(frame, 'stance') || noRoom) {
        setStatus(noRoom && positionOk(frame, 'stance') ? 'NO_ROOM' : 'WRONG_POSITION', out);
        stand = [];
        topRun = 0;
        waitingOkSince = null;
        return;
      }
      setStatus('OK', out);
      feedStand(v, tMs);
      topRun = v >= sTop ? topRun + 1 : 0;
      // выше порога «верх» два кадра подряд, а при редких кадрах (5–6 в секунду) хватит одного
      const needRun = lastDt >= 150 ? 1 : 2;
      if (standReached(tMs)) enterTop();
      else if (topRun >= needRun) {
        ref = null; // вошёл без замирания — пороги по умолчанию
        topThr = sTop;
        startThr = sStart;
        enterTop();
      } else {
        waitingOkSince ??= tMs;
        const gap = config.set.waitHintMs * 3 ** hintCount; // 3 с, потом 9, потом 27
        if (tMs - waitingOkSince >= config.set.waitHintMs && tMs - lastHintAt >= gap) {
          lastHintAt = tMs;
          hintCount += 1;
          out.push({ type: 'hint', code: 'STAND_STILL' });
        }
      }
      return;
    }

    // Во время подхода тоже следим за положением: встал из упора или развернулся — это не повторение.
    if (!positionOk(frame, 'motion')) {
      wrongSince ??= tMs;
      if (tMs - wrongSince >= 500) {
        wrongSince = null;
        toWaiting(out);
        setStatus('WRONG_POSITION', out);
        return;
      }
    } else {
      wrongSince = null;
      setStatus('OK', out);
    }

    if (state === 'TOP') {
      if (v < startThr) beginRep(frame, v, tMs);
      return;
    }
    // IN_REP
    trackInRep(frame, tMs);
    if (v < minEma) {
      minEma = v;
      riseMax = -Infinity;
    } else if (v > riseMax) {
      riseMax = v;
      riseMaxT = tMs;
    }
    // «Мягкий верх»: человек не вернулся до порога, но явно прошёл обратно и снова пошёл в повторение.
    const softTop = softRise() && v <= riseMax - 10;
    if (v >= topThr || softTop) {
      closeRep(softTop ? riseMaxT : tMs, out);
      if (softTop) beginRep(frame, v, tMs);
      else state = 'TOP';
    }
  }

  // ---------- удержание ----------
  function pushHold(frame: PoseFrame, tMs: number, dt: number, out: AnalyzerEvent[]) {
    const c = ctx(frame);
    const rawNat = spec.value(c);
    raw = Number.isNaN(rawNat) ? raw : rawNat;
    if (!Number.isNaN(rawNat)) lastValueT = tMs;
    // сглаживаем и здесь: у порога ошибки формы угол дрожит
    const nat = Number.isNaN(rawNat) ? rawNat : smooth(rawNat, tMs);
    const posOk = positionOk(frame, 'stance');
    setStatus(posOk ? 'OK' : 'WRONG_POSITION', out);
    // удержание — это неподвижность: если угол за последнюю секунду гуляет сильнее maxMotion, человек движется (приседает), а не держит позу
    const hcfg = config.exercises[exercise] as { maxMotion?: number; motionWindowMs?: number };
    if (!Number.isNaN(rawNat)) holdBuf.push({ t: tMs, v: rawNat });
    while (holdBuf.length && tMs - holdBuf[0].t > (hcfg.motionWindowMs ?? 1000)) holdBuf.shift();
    let still = true;
    if (hcfg.maxMotion !== undefined && holdBuf.length > 1) {
      let lo = Infinity, hi = -Infinity;
      for (const p of holdBuf) {
        lo = Math.min(lo, p.v);
        hi = Math.max(hi, p.v);
      }
      still = hi - lo <= hcfg.maxMotion;
    }
    const poseNow = posOk && !Number.isNaN(nat) && !!spec.hold?.inPose(c, nat);
    if (poseNow) poseSince ??= tMs;
    else poseSince = null;
    // неподвижность нужна только чтобы НАЧАТЬ удержание: присед проходит через нужный угол, но не замирает в нём
    const inPose = poseNow && (holding || still);
    if (inPose) {
      outOfPoseSince = null;
      let credit = 0;
      if (!holding) {
        holding = true;
        state = 'TOP';
        sideLocked = true;
        out.push({ type: 'hold', holding: true });
        // время, пока человек уже был в позе и успокаивался, возвращаем (не больше окна проверки)
        if (hcfg.maxMotion !== undefined && poseSince !== null) credit = Math.min(tMs - poseSince, hcfg.motionWindowMs ?? 1000);
      }
      const step = Math.min(dt, config.visibility.lostAfterMs); // после разрыва не добавляем лишнего, но и редкие кадры не теряем
      holdMs += step + credit;
      const err = spec.hold?.formError(c, nat, badCode) ?? null;
      if (credit && !err) cleanHoldMs += credit;
      if (err) {
        badSince ??= tMs;
        if (tMs - badSince >= (config.exercises[exercise] as { badHoldMs: number }).badHoldMs) {
          if (badCode !== err) {
            badCode = err;
            holdErrors[err] = (holdErrors[err] ?? 0) + 1;
            if (tMs - lastTipAt >= config.feedback.minTipIntervalMs) {
              lastTipAt = tMs;
              out.push({ type: 'tip', code: err });
            }
          }
        } else {
          cleanHoldMs += step;
        }
      } else {
        badSince = null;
        badCode = null;
        cleanHoldMs += step;
      }
      lastRepAt = tMs; // для таймера простоя: удержание — это активность
    } else if (holding) {
      outOfPoseSince ??= tMs;
      if (tMs - outOfPoseSince >= 500) {
        holding = false;
        state = 'WAITING';
        badSince = null;
        badCode = null;
        out.push({ type: 'hold', holding: false });
      }
    }
  }

  // ---------- подход ----------
  function checkFinish(tMs: number, out: AnalyzerEvent[]) {
    if (phase !== 'counting') return;
    const did = isHold ? holdMs > 0 : reps.length > 0;
    // человек ушёл, встал или вышел из позы после того, как что-то сделал — подход окончен
    const away = isHold ? did && !holding : did && (status === 'NOT_VISIBLE' || status === 'WRONG_POSITION');
    if (away) awaySince ??= tMs;
    else awaySince = null;
    let reason: FinishReason | null = null;
    if (reps.length >= config.set.maxReps) reason = 'maxReps';
    else if (tMs - countStart >= config.set.maxDurationMs) reason = 'maxDuration';
    else if (awaySince !== null && tMs - awaySince >= config.set.awayStopMs) reason = 'away';
    else if (tMs - lastRepAt >= config.set.idleStopMs) reason = 'idle';
    if (reason) {
      if (!isHold && state === 'IN_REP' && softRise()) closeRep(riseMaxT, out);
      phase = 'finished';
      finishedReason = reason;
      out.push({ type: 'finish', reason });
    }
  }

  function pushCounting(frame: PoseFrame | null, tMs: number, out: AnalyzerEvent[]) {
    const dt = Number.isFinite(lastT) ? tMs - lastT : 0;
    if (!sideLocked) {
      updateWindow(frame, tMs);
      side = bestSide(); // пока не в исходном положении, сторону можно сменить (лёг в упор другим боком)
    }
    const gate = visibilityGate(visibleFor(frame), tMs);
    if (gate !== 'visible' || !frame) {
      if (gate === 'lost' && state !== 'PAUSED') {
        if (isHold) {
          if (holding) out.push({ type: 'hold', holding: false });
          holding = false;
          badSince = null;
          badCode = null;
        } else toWaiting(out);
        state = 'PAUSED';
        sideLocked = spec.view === 'front';
        resetSignal();
        setStatus('NOT_VISIBLE', out);
      }
      return;
    }
    if (state === 'PAUSED') state = 'WAITING';
    if (isHold) pushHold(frame, tMs, dt, out);
    else pushReps(frame, tMs, out);
  }

  return {
    push(frame, tMs) {
      const out: AnalyzerEvent[] = [];
      if (phase === 'finished' || !(tMs > lastT)) return out;
      if (phase === 'prepare') {
        pushPrepare(frame, tMs, out);
        lastT = tMs;
      } else {
        pushCounting(frame, tMs, out);
        lastT = tMs;
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
      sideLocked = spec.view === 'front';
      waitingOkSince = null;
      // сигнал и окно стойки с подготовки не сбрасываем
    },
    finish(tMs, reason = 'user') {
      // последнее повторение без полного возврата: обратный путь пройден на три четверти
      if (phase === 'counting' && !isHold && state === 'IN_REP' && softRise()) {
        closeRep(riseMaxT, []);
        state = 'TOP';
      }
      if (phase !== 'finished') {
        phase = 'finished';
        finishedReason = reason;
      }
      const errorsCount: Partial<Record<ErrorCode, number>> = isHold ? { ...holdErrors } : {};
      for (const r of reps) for (const e of r.errors) errorsCount[e] = (errorsCount[e] ?? 0) + 1;
      return {
        exercise,
        kind: spec.kind,
        side,
        totalReps: reps.length,
        cleanReps: reps.filter((r) => r.errors.length === 0).length,
        holdMs: Math.round(holdMs),
        cleanHoldMs: Math.round(cleanHoldMs),
        errorsCount,
        reps: reps.slice(),
        durationMs: Math.max(0, Math.round(tMs - countStart)),
        finishReason: finishedReason ?? reason,
      };
    },
    debug() {
      return {
        phase,
        state,
        status,
        side,
        sideLocked,
        angle: ema === null ? null : isHold ? ema : S(ema),
        rawAngle: raw,
        reps: reps.length,
        top: S(topThr),
        start: S(startThr),
        ref: ref === null ? null : S(ref),
        holdMs: Math.round(holdMs),
        cleanHoldMs: Math.round(cleanHoldMs),
        holding,
        lastValueT,
      };
    },
  };
}
