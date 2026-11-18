import type { Landmark, PoseFrame, Side } from '../types';

/** Индексы точек MediaPipe Pose. */
export const LM = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
} as const;

export type Joint = 'shoulder' | 'elbow' | 'wrist' | 'hip' | 'knee' | 'ankle';

export function jointIndex(side: Side, joint: Joint): number {
  const key = (side + joint[0].toUpperCase() + joint.slice(1)) as keyof typeof LM;
  return LM[key];
}

export interface Pt {
  x: number;
  y: number;
}

/** Переводит нормированную точку в пиксели кадра. Без этого углы искажаются: x и y нормированы по разным сторонам. */
export function px(frame: PoseFrame, idx: number): Pt {
  const l = frame.landmarks[idx];
  return { x: l.x * frame.width, y: l.y * frame.height };
}

/** Угол в точке b между отрезками b→a и b→c, в градусах (0…180). */
export function angleAt(a: Pt, b: Pt, c: Pt): number {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const n1 = Math.hypot(v1x, v1y);
  const n2 = Math.hypot(v2x, v2y);
  if (n1 === 0 || n2 === 0) return NaN;
  let cos = (v1x * v2x + v1y * v2y) / (n1 * n2);
  cos = Math.max(-1, Math.min(1, cos));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Отклонение отрезка от вертикали, в градусах (0 — строго вертикально, 90 — горизонтально). */
export function tiltFromVertical(a: Pt, b: Pt): number {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  if (dx === 0 && dy === 0) return NaN;
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

/** Отклонение отрезка от горизонтали, в градусах. */
export function tiltFromHorizontal(a: Pt, b: Pt): number {
  const v = tiltFromVertical(a, b);
  return Number.isNaN(v) ? NaN : 90 - v;
}

export function visibilityOf(frame: PoseFrame, idx: number): number {
  const l: Landmark | undefined = frame.landmarks[idx];
  return l ? l.visibility ?? 0 : 0;
}

export function allVisible(frame: PoseFrame, idxs: number[], min: number): boolean {
  return idxs.every((i) => visibilityOf(frame, i) >= min);
}

/**
 * Положение таза относительно прямой плечо–лодыжка.
 * > 0 — таз ниже прямой (y растёт вниз), < 0 — выше. Возвращает NaN, если прямая почти вертикальна.
 * Значение в пикселях.
 */
export function hipOffsetFromLine(shoulder: Pt, hip: Pt, ankle: Pt, minDx: number): number {
  const dx = ankle.x - shoulder.x;
  if (Math.abs(dx) < minDx) return NaN;
  const yLine = shoulder.y + ((ankle.y - shoulder.y) * (hip.x - shoulder.x)) / dx;
  return hip.y - yLine;
}

/** Отношение ширины плеч по горизонтали к длине корпуса. Сбоку оно маленькое, анфас большое. */
export function shoulderRatio(frame: PoseFrame): number {
  const ls = px(frame, LM.leftShoulder);
  const rs = px(frame, LM.rightShoulder);
  const lh = px(frame, LM.leftHip);
  const rh = px(frame, LM.rightHip);
  const midS = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const midH = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  const torso = Math.hypot(midS.x - midH.x, midS.y - midH.y);
  if (torso === 0) return NaN;
  return Math.abs(ls.x - rs.x) / torso;
}

/** Угол в точке b по трём точкам в пространстве (worldLandmarks), в градусах. */
export function angleAt3(a: Landmark, b: Landmark, c: Landmark): number {
  const v1 = [a.x - b.x, a.y - b.y, a.z - b.z];
  const v2 = [c.x - b.x, c.y - b.y, c.z - b.z];
  const n1 = Math.hypot(v1[0], v1[1], v1[2]);
  const n2 = Math.hypot(v2[0], v2[1], v2[2]);
  if (n1 === 0 || n2 === 0) return NaN;
  const cos = Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (n1 * n2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Наклон бедра: угол отрезка колено→таз к горизонтали. > 0 — таз выше колена, < 0 — ниже. */
export function thighAngle(hip: Pt, knee: Pt): number {
  const up = knee.y - hip.y; // y растёт вниз
  const dx = Math.abs(hip.x - knee.x);
  if (up === 0 && dx === 0) return NaN;
  return (Math.atan2(up, dx) * 180) / Math.PI;
}

export function median3(a: number[]): number {
  const s = a.slice(-3).sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
}
