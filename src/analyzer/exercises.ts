// Описания упражнений для анализатора: какой угол считаем, как проверяем положение, какие правила техники.
// Углы «естественные», в градусах. Для упражнений «вверх» (мост, жим, разведения, скручивания) повторение — рост угла.
import type { AppConfig, HoldConfig, RepConfig } from '../config';
import type { ErrorCode, Exercise, PoseFrame, Side } from '../types';
import { angleAt, hipOffsetFromLine, jointIndex, px, shoulderRatio, thighAngle, tiltFromHorizontal, tiltFromVertical, type Joint, type Pt } from './geometry';

export type PosMode = 'prepare' | 'stance' | 'motion';

export interface Ctx {
  f: PoseFrame;
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
  evaluate?(t: RepTrack, extreme: number, config: AppConfig): ErrorCode[];
  accept?(t: RepTrack, config: AppConfig): boolean;
  hold?: { inPose(c: Ctx, value: number): boolean; formError(c: Ctx, value: number): ErrorCode | null };
}

// ---------- помощники ----------
const J = (side: Side, joint: Joint) => jointIndex(side, joint);
const P = (c: Ctx, joint: Joint, side: Side = c.side): Pt => px(c.f, J(side, joint));
const vis = (c: Ctx, joint: Joint, side: Side = c.side) => c.f.landmarks[J(side, joint)]?.visibility ?? 0;
const both = (joints: Joint[]) => [...joints.map((j) => J('left', j)), ...joints.map((j) => J('right', j))];
const oneSide = (joints: Joint[]) => (s: Side) => joints.map((j) => J(s, j));
const angle3 = (c: Ctx, a: Joint, b: Joint, d: Joint, side: Side = c.side) => angleAt(P(c, a, side), P(c, b, side), P(c, d, side));
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Боком к камере: ширина плеч по горизонтали меньше половины длины корпуса. */
function sideView(c: Ctx): boolean {
  const r = shoulderRatio(c.f);
  return Number.isNaN(r) || r <= c.config.position.maxSideRatio;
}

/** Лицом к камере: плечи широко разнесены по горизонтали. */
function frontView(c: Ctx): boolean {
  const r = shoulderRatio(c.f);
  return !Number.isNaN(r) && r >= c.config.position.minFrontRatio;
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

/** Ошибка линии тела в текущем кадре (для планки). */
function bodyLineError(c: Ctx, minLine: number, sag: ErrorCode, pike: ErrorCode): ErrorCode | null {
  if (!(vis(c, 'hip') >= c.visMin && vis(c, 'knee') >= c.visMin)) return null;
  const sh = P(c, 'shoulder');
  const hp = P(c, 'hip');
  const kn = P(c, 'knee');
  if (angleAt(sh, hp, kn) >= minLine) return null;
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
    position: (c, mode) => sideView(c) && (mode === 'motion' || !(torsoTilt(c) > c.config.position.maxTorsoTilt)),
    snapshot: (c) => ({
      thigh: thighAngle(P(c, 'hip'), P(c, 'knee')),
      torso: vis(c, 'shoulder') >= c.visMin ? torsoTilt(c) : NaN,
    }),
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
      const farVisible = (['hip', 'knee', 'ankle'] as const).every((j) => vis(c, j, other) >= 0.3);
      const far = farVisible ? angle3(c, 'hip', 'knee', 'ankle', other) : NaN;
      return Number.isNaN(far) ? near : Math.max(near, far);
    },
    position: (c, mode) => sideView(c) && (mode === 'motion' || !(torsoTilt(c) > c.config.position.maxTorsoTilt)),
    snapshot: (c) => ({ torso: vis(c, 'shoulder') >= c.visMin ? torsoTilt(c) : NaN }),
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
      if (!sideView(c)) return false;
      if (mode === 'motion') return !(torsoElevation(c) > 60);
      return !(torsoElevation(c) > c.config.position.maxLyingTilt); // лежит на спине
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
    position: (c, mode) => sideView(c) && (mode === 'prepare' || !(torsoTilt(c) > c.config.position.maxTorsoTilt)),
    hold: {
      inPose: (c, v) => v >= 50 && v <= n(hc(c.config, 'wallsit').maxKnee),
      formError: (c, v) => (v > n(hc(c.config, 'wallsit').cleanMaxKnee) ? 'WALLSIT_HIGH' : null),
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
    position: (c, mode) => sideView(c) && (mode === 'prepare' || !(bodyTilt(c) > c.config.position.maxBodyTilt)),
    snapshot: (c) => ({ bodyTilt: vis(c, 'hip') >= c.visMin * 0.5 ? bodyTilt(c) : NaN }),
    track: (c, t, tMs) => trackBodyLine(c, t, tMs, n(rc(c.config, 'pushup').minBodyLine)),
    evaluate(t, extreme, config) {
      const e = rc(config, 'pushup');
      const out: ErrorCode[] = [];
      if (t.bad.max >= n(e.bodyLineHoldMs) && !Number.isNaN(t.bad.offset)) out.push(t.bad.offset > 0 ? 'PUSHUP_HIP_SAG' : 'PUSHUP_HIP_PIKE');
      if (extreme > n(e.clean)) out.push('PUSHUP_DEPTH');
      return out;
    },
    // засчитываем, только если в нижней точке человек был в упоре, а не стоял
    accept: (t, config) => Number.isNaN(t.snap.bodyTilt ?? NaN) || t.snap.bodyTilt <= config.position.maxBodyTilt,
  },

  curl: {
    id: 'curl',
    kind: 'reps',
    view: 'side',
    countPoints: oneSide(['shoulder', 'elbow', 'wrist']),
    sidePoints: oneSide(['shoulder', 'elbow', 'wrist', 'hip']),
    value: (c) => angle3(c, 'shoulder', 'elbow', 'wrist'),
    position: (c, mode) => sideView(c) && (mode === 'motion' || !(torsoTilt(c) > c.config.position.maxTorsoTilt)),
    // локоть уходит вперёд: плечевая кость (плечо→локоть) отклоняется от вертикали
    snapshot: (c) => ({ drift: tiltFromVertical(P(c, 'shoulder'), P(c, 'elbow')) }),
    track(c, t) {
      if (vis(c, 'hip') < c.visMin) return;
      const tilt = torsoTilt(c);
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
    position: (c) => frontView(c) && !(torsoTiltFront(c) > c.config.position.maxTorsoTilt),
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
    position: (c) => frontView(c) && !(torsoTiltFront(c) > c.config.position.maxTorsoTilt),
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
      if (!sideView(c)) return false;
      if (mode === 'motion') return !(torsoElevation(c) > 80);
      return !(torsoElevation(c) > c.config.position.maxLyingTilt);
    },
    evaluate: (_t, extreme, config) => (extreme < n(rc(config, 'crunch').minPeak) ? ['CRUNCH_LOW'] : []),
  },

  plank: {
    id: 'plank',
    kind: 'hold',
    view: 'side',
    countPoints: oneSide(['shoulder', 'hip', 'knee']),
    sidePoints: oneSide(['shoulder', 'elbow', 'hip', 'knee', 'ankle']),
    value: (c) => angle3(c, 'shoulder', 'hip', 'knee'),
    position: (c, mode) => sideView(c) && (mode === 'prepare' || !(bodyTilt(c) > n(hc(c.config, 'plank').maxBodyTilt))),
    hold: {
      inPose: (c) => !(bodyTilt(c) > n(hc(c.config, 'plank').maxBodyTilt)),
      formError: (c) => bodyLineError(c, n(hc(c.config, 'plank').minBodyLine), 'PLANK_SAG', 'PLANK_PIKE'),
    },
  },
};
