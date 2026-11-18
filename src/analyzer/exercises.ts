// Описания упражнений для анализатора: какой угол считаем, как проверяем положение, какие правила техники.
// Углы «естественные», в градусах. Для упражнений «вверх» (мост, жим, разведения, скручивания) повторение — рост угла.
import type { AppConfig, HoldConfig, RepConfig } from '../config';
import type { ErrorCode, Exercise, PoseFrame, Side } from '../types';
import { angleAt, angleAt3, hipOffsetFromLine, jointIndex, px, shoulderRatio, thighAngle, tiltFromHorizontal, tiltFromVertical, type Joint, type Pt } from './geometry';

export type PosMode = 'prepare' | 'stance' | 'motion';

export interface Ctx {
  f: PoseFrame;
  ex?: Exercise;
  /** Сейчас ракурс верный (статус OK): для запаса у порога. */
  viewOk?: boolean;
  side: Side;
  config: AppConfig;
  visMin: number;
}

/** Наблюдения за одно повторение. */
export interface RepTrack {
  snap: Record<string, number>; // снимок в крайней точке
  acc: Record<string, number>; // накопленное по кадрам
  bad: { since: number | null; max: number; worst: number; offset: number }; // длительное нарушение формы
}

export function newTrack(): RepTrack {
  return { snap: {}, acc: {}, bad: { since: null, max: 0, worst: Infinity, offset: NaN } };
}

export interface ExerciseSpec {
  id: Exercise;
  kind: 'reps' | 'hold';
  view: 'side' | 'front';
  /** Точки, которые должны быть видны, чтобы считать. Для вида сбоку — по выбранной стороне. */
  countPoints(side: Side): number[];
  /** Точки для выбора стороны (только вид сбоку). */
  sidePoints(side: Side): number[];
  /** Сигнал: естественный угол. NaN — посчитать нельзя. */
  value(c: Ctx): number;
  position(c: Ctx, mode: PosMode): boolean;
  snapshot?(c: Ctx): Record<string, number>;
  track?(c: Ctx, t: RepTrack, tMs: number): void;
  /** ref — естественный угол исходного положения, если он найден (калибровка), иначе null. */
  evaluate?(t: RepTrack, extreme: number, config: AppConfig, ref: number | null): ErrorCode[];
  accept?(t: RepTrack, config: AppConfig): boolean;
  /** current — ошибка, которая держится сейчас: для зоны нечувствительности у порога. */
  hold?: { inPose(c: Ctx, value: number): boolean; formError(c: Ctx, value: number, current: ErrorCode | null): ErrorCode | null };
  /** Хватает ли места в кадре (например, для рук над головой). false — статус NO_ROOM. */
  room?(c: Ctx): boolean;
}

// ---------- помощники ----------
const J = (side: Side, joint: Joint) => jointIndex(side, joint);
const P = (c: Ctx, joint: Joint, side: Side = c.side): Pt => px(c.f, J(side, joint));
const vis = (c: Ctx, joint: Joint, side: Side = c.side) => c.f.landmarks[J(side, joint)]?.visibility ?? 0;
const both = (joints: Joint[]) => [...joints.map((j) => J('left', j)), ...joints.map((j) => J('right', j))];
const oneSide = (joints: Joint[]) => (s: Side) => joints.map((j) => J(s, j));
/** Угол в суставе b. С angles3d — по объёмным точкам: так угол в колене или локте меньше искажается, если телефон стоит не строго сбоку. */
const angle3 = (c: Ctx, a: Joint, b: Joint, d: Joint, side: Side = c.side) => {
  const a3 = c.config.smoothing.angles3d;
  const w = a3 === true || (Array.isArray(a3) && c.ex !== undefined && a3.includes(c.ex)) ? c.f.world : undefined;
  if (w && w.length >= 33) return angleAt3(w[J(side, a)], w[J(side, b)], w[J(side, d)]);
  return angleAt(P(c, a, side), P(c, b, side), P(c, d, side));
};
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Боком к камере: ширина плеч по горизонтали меньше половины длины корпуса. */
// Необязательные параметры из предложенных исправлений (нет в config.json — поведение прежнее).
const opt = (c: Ctx) => c.config.position;
/** Мягкий порог ракурса во время повторения, если он задан для упражнения (motionSideRatio / motionFrontRatio). */
const motionOpt = (c: Ctx, ex: Exercise | undefined, key: 'motionSideRatio' | 'motionFrontRatio') =>
  ex ? ((c.config.exercises[ex] as Record<string, unknown>)[key] as number | undefined) : undefined;

/** Боком к камере. Во время движения порог мягче: в подъёме корпуса плечи «раскрываются» в кадре. */
function sideView(c: Ctx, mode: PosMode = 'stance', ex?: Exercise): boolean {
  const r = shoulderRatio(c.f);
  const m = mode === 'motion' ? motionOpt(c, ex, 'motionSideRatio') : undefined;
  const h = (c.config.position.viewHysteresis ?? 0) * (c.viewOk === undefined ? 0 : c.viewOk ? 1 : -1);
  const max = (m ?? c.config.position.maxSideRatio) + h;
  return Number.isNaN(r) || r <= max;
}

/** Лицом к камере: плечи широко разнесены по горизонтали. */
function frontView(c: Ctx, mode: PosMode = 'stance', ex?: Exercise): boolean {
  const r = shoulderRatio(c.f);
  const m = mode === 'motion' ? motionOpt(c, ex, 'motionFrontRatio') : undefined;
  const h = (c.config.position.viewHysteresis ?? 0) * (c.viewOk === undefined ? 0 : c.viewOk ? 1 : -1);
  const min = (m ?? c.config.position.minFrontRatio) - h;
  // слишком «широкие» плечи при коротком корпусе — человек наклонился к камере (бёрпи, наклон), а не стоит лицом
  return !Number.isNaN(r) && r >= min && r <= (opt(c).maxFrontRatio ?? Infinity) + h;
}

/** Насколько линия плеч вертикальна в пространстве (worldLandmarks), градусы. В боковой планке ~70–90°, в обычной < 30°. */
function shoulderStack(c: Ctx): number {
  const w = c.f.world;
  if (!w?.[11] || !w?.[12]) return NaN;
  const dx = w[11].x - w[12].x, dy = w[11].y - w[12].y, dz = w[11].z - w[12].z;
  return (Math.atan2(Math.abs(dy), Math.hypot(dx, dz)) * 180) / Math.PI;
}

/** На сколько плечо выше таза, в долях корпуса (> 0 — плечи выше, < 0 — таз выше плеч, как в мосте). */
function shoulderRise(c: Ctx): number {
  const sh = P(c, 'shoulder'), hp = P(c, 'hip');
  const torso = dist(sh, hp);
  return torso ? (hp.y - sh.y) / torso : NaN;
}

/** На сколько кисть ниже плеча, в долях корпуса: в упоре на прямых руках ~0,8–1. */
function armSupport(c: Ctx): number {
  const sh = P(c, 'shoulder');
  const torso = dist(sh, P(c, 'hip'));
  return torso ? (P(c, 'wrist').y - sh.y) / torso : NaN;
}

const optNum = (config: AppConfig, ex: Exercise, key: string) => (config.exercises[ex] as Record<string, unknown>)[key] as number | undefined;

/** Разнос стоп по горизонтали в долях длины ноги: в выпаде ноги разведены вперёд-назад, в приседе стопы рядом. */
function footSplit(c: Ctx): number {
  const other: Side = c.side === 'left' ? 'right' : 'left';
  const leg = dist(P(c, 'hip'), P(c, 'knee')) + dist(P(c, 'knee'), P(c, 'ankle'));
  if (!leg) return NaN;
  return Math.abs(P(c, 'ankle').x - P(c, 'ankle', other).x) / leg;
}

/** Наклон корпуса (плечо–таз) от вертикали на выбранной стороне. */
const torsoTilt = (c: Ctx) => tiltFromVertical(P(c, 'shoulder'), P(c, 'hip'));
/** То же по серединам плеч и таза — для вида спереди. */
const torsoTiltFront = (c: Ctx) => tiltFromVertical(mid(P(c, 'shoulder', 'left'), P(c, 'shoulder', 'right')), mid(P(c, 'hip', 'left'), P(c, 'hip', 'right')));
/** Подъём корпуса от пола: наклон линии плечо–таз от горизонтали. */
const torsoElevation = (c: Ctx) => tiltFromHorizontal(P(c, 'shoulder'), P(c, 'hip'));
/** Наклон тела от горизонтали для упора лёжа: по плечу и колену (или тазу, если колено не видно). */
function bodyTilt(c: Ctx): number {
  const far = vis(c, 'knee') >= c.visMin ? P(c, 'knee') : P(c, 'hip');
  return tiltFromHorizontal(P(c, 'shoulder'), far);
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Плечи выше опоры (локтя или запястья) хотя бы на долю длины корпуса: человек в планке, а не лежит на полу. */
function aboveSupport(c: Ctx, minShare: number): boolean {
  const sh = P(c, 'shoulder');
  const torso = dist(sh, P(c, 'hip'));
  if (!torso) return false;
  const supports = (['elbow', 'wrist'] as const).filter((j) => vis(c, j) >= c.visMin * 0.5).map((j) => P(c, j).y);
  if (!supports.length) return true; // руки не видны — не мешаем, решает наклон тела
  return (Math.max(...supports) - sh.y) / torso >= minShare;
}

/** Колени не намного ниже таза: человек лежит или сидит с согнутыми ногами, а не стоит. */
function kneesUp(c: Ctx): boolean {
  if (vis(c, 'knee') < c.visMin * 0.5) return true;
  const hip = P(c, 'hip');
  const torso = dist(P(c, 'shoulder'), hip);
  return !torso || (P(c, 'knee').y - hip.y) / torso < 0.45;
}

/** Линия тела плечо–таз–колено: провис или задранный таз, если держится дольше holdMs. */
function trackBodyLine(c: Ctx, t: RepTrack, tMs: number, minLine: number) {
  if (!(vis(c, 'shoulder') >= c.visMin && vis(c, 'hip') >= c.visMin && vis(c, 'knee') >= c.visMin)) {
    t.bad.since = null;
    return;
  }
  const sh = P(c, 'shoulder');
  const hp = P(c, 'hip');
  const kn = P(c, 'knee');
  const line = angleAt(sh, hp, kn);
  if (line < minLine) {
    if (t.bad.since === null) t.bad.since = tMs;
    t.bad.max = Math.max(t.bad.max, tMs - t.bad.since);
    if (line < t.bad.worst) {
      t.bad.worst = line;
      t.bad.offset = hipOffsetFromLine(sh, hp, kn, 0.05 * c.f.width);
    }
  } else {
    t.bad.since = null;
  }
}

/** Ошибка линии тела в текущем кадре (для планки). Пока ошибка держится, выход из неё на 3° позже входа. */
function bodyLineError(c: Ctx, minLine: number, sag: ErrorCode, pike: ErrorCode, current: ErrorCode | null): ErrorCode | null {
  if (!(vis(c, 'hip') >= c.visMin && vis(c, 'knee') >= c.visMin)) return null;
  const sh = P(c, 'shoulder');
  const hp = P(c, 'hip');
  const kn = P(c, 'knee');
  if (angleAt(sh, hp, kn) >= minLine + (current ? 3 : 0)) return null;
  const off = hipOffsetFromLine(sh, hp, kn, 0.05 * c.f.width);
  if (Number.isNaN(off)) return null;
  return off > 0 ? sag : pike;
}

const rc = (config: AppConfig, ex: Exercise) => config.exercises[ex] as RepConfig;
const hc = (config: AppConfig, ex: Exercise) => config.exercises[ex] as HoldConfig;
const n = (v: unknown) => v as number;

// ---------- упражнения ----------
export const SPECS: Record<Exercise, ExerciseSpec> = {
  squat: {
    id: 'squat',
    kind: 'reps',
    view: 'side',
    countPoints: oneSide(['hip', 'knee', 'ankle']),
    sidePoints: oneSide(['shoulder', 'hip', 'knee', 'ankle']),
    value: (c) => angle3(c, 'hip', 'knee', 'ankle'),
    position: (c, mode) => sideView(c, mode, 'squat') && (mode === 'motion' || !(torsoTilt(c) > c.config.position.maxTorsoTilt)),
    snapshot: (c) => ({
      thigh: thighAngle(P(c, 'hip'), P(c, 'knee')),
      torso: vis(c, 'shoulder') >= c.visMin ? torsoTilt(c) : NaN,
      split: (['hip', 'knee', 'ankle'] as const).every((j) => vis(c, j, c.side === 'left' ? 'right' : 'left') >= 0.3) ? footSplit(c) : NaN,
    }),
    // стопы рядом: если в нижней точке ноги разведены вперёд-назад — это выпад, а не присед
    accept: (t, config) => {
      const m = optNum(config, 'squat', 'maxSplit');
      return m === undefined || !(t.snap.split > m);
    },
    evaluate(t, _x, config) {
      const e = rc(config, 'squat');
      const out: ErrorCode[] = [];
      if (t.snap.thigh > n(e.maxThighAngle)) out.push('SQUAT_DEPTH');
      if (t.snap.torso > n(e.maxLean)) out.push('SQUAT_LEAN');
      return out;
    },
  },

  lunge: {
    id: 'lunge',
    kind: 'reps',
    view: 'side',
    countPoints: oneSide(['hip', 'knee', 'ankle']),
    sidePoints: oneSide(['shoulder', 'hip', 'knee', 'ankle']),
    // В выпаде сгибаются ОБА колена, а при шаге — только маховая нога, опорная остаётся прямой.
    // Поэтому берём больший из двух углов: шаг его почти не меняет, выпад — опускает до ~90°.
    value(c) {
      const near = angle3(c, 'hip', 'knee', 'ankle');
      const other: Side = c.side === 'left' ? 'right' : 'left';
      // дальняя нога не видна — кадр пропускаем: по одной ноге шаг не отличить от выпада
      const farVisible = (['hip', 'knee', 'ankle'] as const).every((j) => vis(c, j, other) >= 0.3);
      if (!farVisible) return NaN;
      return Math.max(near, angle3(c, 'hip', 'knee', 'ankle', other));
    },
    position: (c, mode) => sideView(c, mode, 'lunge') && (mode === 'motion' || !(torsoTilt(c) > c.config.position.maxTorsoTilt)),
    snapshot: (c) => ({ torso: vis(c, 'shoulder') >= c.visMin ? torsoTilt(c) : NaN, split: footSplit(c) }),
    // в нижней точке стопы должны быть разведены: присед на двух ногах и низкий старт — не выпад
    // и корпус почти вертикален: с наклоном 70° это низкий старт или растяжка с рукой на полу, а не выпад
    accept: (t, config) => {
      const e = rc(config, 'lunge');
      const m = e.minSplit as number | undefined;
      const lean = e.maxRepLean as number | undefined;
      if (m !== undefined && !Number.isNaN(t.snap.split ?? NaN) && t.snap.split < m) return false;
      if (lean !== undefined && t.snap.torso > lean) return false;
      return true;
    },
    evaluate(t, extreme, config) {
      const e = rc(config, 'lunge');
      const out: ErrorCode[] = [];
      if (extreme > n(e.maxDepthAngle)) out.push('LUNGE_DEPTH');
      if (t.snap.torso > n(e.maxLean)) out.push('LUNGE_LEAN');
      return out;
    },
  },

  bridge: {
    id: 'bridge',
    kind: 'reps',
    view: 'side',
    countPoints: oneSide(['shoulder', 'hip', 'knee']),
    sidePoints: oneSide(['shoulder', 'hip', 'knee', 'ankle']),
    value: (c) => angle3(c, 'shoulder', 'hip', 'knee'),
    position(c, mode) {
      if (!sideView(c, mode, 'bridge')) return false;
      if (mode === 'motion') return kneesUp(c) && !(torsoElevation(c) > 60);
      return !(torsoElevation(c) > c.config.position.maxLyingTilt); // лежит на спине
    },
    snapshot: (c) => ({ rise: shoulderRise(c) }),
    // в верхней точке таз выше плеч: при подъёме корпуса (скручивание) выше плечи
    accept: (t, config) => {
      const m = optNum(config, 'bridge', 'maxShoulderRise');
      return m === undefined || !(t.snap.rise > m);
    },
    evaluate: (_t, extreme, config) => (extreme < n(rc(config, 'bridge').minPeak) ? ['BRIDGE_HEIGHT'] : []),
  },

  wallsit: {
    id: 'wallsit',
    kind: 'hold',
    view: 'side',
    countPoints: oneSide(['hip', 'knee', 'ankle']),
    sidePoints: oneSide(['shoulder', 'hip', 'knee', 'ankle']),
    value: (c) => angle3(c, 'hip', 'knee', 'ankle'),
    position: (c, mode) => sideView(c, mode, 'wallsit') && (mode === 'prepare' || !(torsoTilt(c) > c.config.position.maxTorsoTilt)),
    hold: {
      inPose: (c, v) => {
        if (!(v >= 50 && v <= n(hc(c.config, 'wallsit').maxKnee))) return false;
        const e = hc(c.config, 'wallsit') as Record<string, number | undefined>;
        const other: Side = c.side === 'left' ? 'right' : 'left';
        // стопы рядом (статичный выпад — не «стульчик»)
        if (e.maxSplit !== undefined && (['hip', 'knee', 'ankle'] as const).every((j) => vis(c, j, other) >= 0.3) && footSplit(c) > e.maxSplit) return false;
        // таз заметно выше стоп: сидя на полу с согнутыми коленями таз на уровне стоп
        if (e.minHipHeight !== undefined) {
          const leg = dist(P(c, 'hip'), P(c, 'knee')) + dist(P(c, 'knee'), P(c, 'ankle'));
          if (leg && (P(c, 'ankle').y - P(c, 'hip').y) / leg < e.minHipHeight) return false;
        }
        return true;
      },
      formError: (c, v, current) => (v > n(hc(c.config, 'wallsit').cleanMaxKnee) - (current ? 3 : 0) ? 'WALLSIT_HIGH' : null),
    },
  },

  pushup: {
    id: 'pushup',
    kind: 'reps',
    view: 'side',
    countPoints: oneSide(['shoulder', 'elbow', 'wrist']),
    sidePoints: oneSide(['shoulder', 'elbow', 'wrist', 'hip', 'knee']),
    value: (c) => angle3(c, 'shoulder', 'elbow', 'wrist'),
    // на подготовке можно стоять, в упоре тело почти горизонтально
    position: (c, mode) => sideView(c, mode, 'pushup') && (mode === 'prepare' || !(bodyTilt(c) > c.config.position.maxBodyTilt)),
    snapshot: (c) => ({ bodyTilt: vis(c, 'hip') >= c.visMin * 0.5 ? bodyTilt(c) : NaN }),
    track: (c, t, tMs) => {
      trackBodyLine(c, t, tMs, n(rc(c.config, 'pushup').minBodyLine));
      const a = armSupport(c);
      if (!Number.isNaN(a)) t.acc.support = Math.max(t.acc.support ?? -Infinity, a);
    },
    evaluate(t, extreme, config) {
      const e = rc(config, 'pushup');
      const out: ErrorCode[] = [];
      if (t.bad.max >= n(e.bodyLineHoldMs) && !Number.isNaN(t.bad.offset)) out.push(t.bad.offset > 0 ? 'PUSHUP_HIP_SAG' : 'PUSHUP_HIP_PIKE');
      if (extreme > n(e.clean)) out.push('PUSHUP_DEPTH');
      return out;
    },
    // засчитываем, только если в нижней точке человек был в упоре, а не стоял
    // и хотя бы раз за повторение руки выпрямлялись под плечами (упор): сгибание рук лёжа на спине — не отжимание
    accept: (t, config) => {
      if (!(Number.isNaN(t.snap.bodyTilt ?? NaN) || t.snap.bodyTilt <= config.position.maxBodyTilt)) return false;
      const m = optNum(config, 'pushup', 'minArmSupport');
      return m === undefined || !(t.acc.support < m);
    },
  },

  curl: {
    id: 'curl',
    kind: 'reps',
    view: 'side',
    countPoints: oneSide(['shoulder', 'elbow', 'wrist']),
    sidePoints: oneSide(['shoulder', 'elbow', 'wrist', 'hip']),
    value: (c) => angle3(c, 'shoulder', 'elbow', 'wrist'),
    position: (c, mode) => sideView(c, mode, 'curl') && (mode === 'motion' || !(torsoTilt(c) > c.config.position.maxTorsoTilt)),
    // локоть уходит вперёд: плечевая кость (плечо→локоть) отклоняется от вертикали
    snapshot: (c) => ({ drift: tiltFromVertical(P(c, 'shoulder'), P(c, 'elbow')), torso: vis(c, 'hip') >= c.visMin ? torsoTilt(c) : NaN }),
    // в верхней точке человек стоит прямо: сгибание рук в приседе или лёжа — не «бицепс»
    accept: (t, config) => {
      const m = optNum(config, 'curl', 'maxRepLean');
      return m === undefined || !(t.snap.torso > m);
    },
    track(c, t) {
      if (vis(c, 'hip') < c.visMin) return;
      // наклон со знаком (вперёд или назад): раскачка через вертикаль, от +8° до −8°, — это размах 16°, а не 8°
      const tilt = torsoTilt(c) * (P(c, 'shoulder').x >= P(c, 'hip').x ? 1 : -1);
      if (t.acc.tilt0 === undefined) t.acc.tilt0 = tilt;
      t.acc.swing = Math.max(t.acc.swing ?? 0, Math.abs(tilt - t.acc.tilt0));
    },
    evaluate(t, _x, config) {
      const e = rc(config, 'curl');
      const out: ErrorCode[] = [];
      if ((t.acc.swing ?? 0) > n(e.maxSwing)) out.push('CURL_SWING');
      if (t.snap.drift > n(e.maxElbowDrift)) out.push('CURL_ELBOW');
      return out;
    },
  },

  press: {
    id: 'press',
    kind: 'reps',
    view: 'front',
    countPoints: () => both(['shoulder', 'elbow', 'wrist']),
    sidePoints: () => [],
    // обе руки должны выпрямиться — берём меньший из двух углов в локтях
    value: (c) => Math.min(angle3(c, 'shoulder', 'elbow', 'wrist', 'left'), angle3(c, 'shoulder', 'elbow', 'wrist', 'right')),
    position: (c, mode) => frontView(c, mode, 'press') && !(torsoTiltFront(c) > c.config.position.maxTorsoTilt),
    // руки над головой должны поместиться в кадр: плечо выше верхнего края хотя бы на длину руки
    room(c) {
      return (['left', 'right'] as const).every((sd) => {
        const sh = P(c, 'shoulder', sd);
        const arm = dist(sh, P(c, 'elbow', sd)) + dist(P(c, 'elbow', sd), P(c, 'wrist', sd));
        return sh.y - arm >= 0.02 * c.f.height;
      });
    },
    evaluate: (_t, extreme, config) => (extreme < n(rc(config, 'press').minLockout) ? ['PRESS_LOCKOUT'] : []),
  },

  raise: {
    id: 'raise',
    kind: 'reps',
    view: 'front',
    countPoints: () => both(['shoulder', 'elbow', 'hip']),
    sidePoints: () => [],
    // угол в плече между корпусом (плечо→таз) и рукой (плечо→локоть), меньший из двух рук
    value: (c) => Math.min(angle3(c, 'hip', 'shoulder', 'elbow', 'left'), angle3(c, 'hip', 'shoulder', 'elbow', 'right')),
    position: (c, mode) => frontView(c, mode, 'raise') && !(torsoTiltFront(c) > c.config.position.maxTorsoTilt),
    snapshot: (c) => ({ top: Math.max(angle3(c, 'hip', 'shoulder', 'elbow', 'left'), angle3(c, 'hip', 'shoulder', 'elbow', 'right')) }),
    evaluate(t, extreme, config) {
      const e = rc(config, 'raise');
      if (extreme < n(e.minPeak)) return ['RAISE_LOW'];
      if ((t.snap.top ?? extreme) > n(e.maxPeak)) return ['RAISE_HIGH'];
      return [];
    },
  },

  crunch: {
    id: 'crunch',
    kind: 'reps',
    view: 'side',
    countPoints: oneSide(['shoulder', 'hip']),
    sidePoints: oneSide(['shoulder', 'hip', 'knee', 'ankle']),
    value: (c) => torsoElevation(c),
    position(c, mode) {
      if (!sideView(c, mode, 'crunch')) return false;
      // во время повторения корпус может подняться до вертикали (подъём корпуса), но человек не встаёт
      if (mode === 'motion') return kneesUp(c);
      return !(torsoElevation(c) > c.config.position.maxLyingTilt);
    },
    snapshot: (c) => ({ rise: shoulderRise(c) }),
    // в верхней точке плечи выше таза: если выше таз — это мост, а не скручивание
    accept: (t, config) => {
      const m = optNum(config, 'crunch', 'minShoulderRise');
      return m === undefined || !(t.snap.rise < m);
    },
    // «Оторви лопатки»: подъём от исходного положения меньше minRise (телефон может стоять с наклоном)
    evaluate: (_t, extreme, config, ref) => {
      const e = rc(config, 'crunch');
      return extreme - (ref ?? n(e.top)) < n(e.minRise) ? ['CRUNCH_LOW'] : [];
    },
  },

  plank: {
    id: 'plank',
    kind: 'hold',
    view: 'side',
    countPoints: oneSide(['shoulder', 'hip', 'knee']),
    sidePoints: oneSide(['shoulder', 'elbow', 'hip', 'knee', 'ankle']),
    value: (c) => angle3(c, 'shoulder', 'hip', 'knee'),
    position: (c, mode) => sideView(c, mode, 'plank') && (mode === 'prepare' || !(bodyTilt(c) > n(hc(c.config, 'plank').maxBodyTilt))),
    hold: {
      // в позе: тело почти горизонтально и плечи над опорой (лежащий на полу — не планка)
      inPose: (c) =>
        !(bodyTilt(c) > n(hc(c.config, 'plank').maxBodyTilt)) &&
        aboveSupport(c, n(hc(c.config, 'plank').minSupport)) &&
        // боковая планка: плечи друг над другом
        !(shoulderStack(c) > ((hc(c.config, 'plank').maxShoulderStack as number | undefined) ?? Infinity)),
      formError: (c, _v, current) => bodyLineError(c, n(hc(c.config, 'plank').minBodyLine), 'PLANK_SAG', 'PLANK_PIKE', current),
    },
  },
};
