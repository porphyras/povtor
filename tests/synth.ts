import { readFileSync } from 'node:fs';

import { validateConfig, type AppConfig } from '../src/config';
import type { Landmark, PoseFrame } from '../src/types';
import { LM } from '../src/analyzer/geometry';

export const W = 640;
export const H = 480;

export function loadTestConfig(patch?: (c: AppConfig) => void): AppConfig {
  const raw = JSON.parse(readFileSync(new URL('../src/config.json', import.meta.url), 'utf8'));
  const c = validateConfig(raw);
  patch?.(c);
  return c;
}

type P = { x: number; y: number };
const deg = (a: number) => (a * Math.PI) / 180;

function emptyLandmarks(): Landmark[] {
  return Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.1 }));
}

function put(lms: Landmark[], idx: number, p: P, vis: number) {
  lms[idx] = { x: p.x / W, y: p.y / H, z: 0, visibility: vis };
}

export interface SquatOpts {
  lean?: number; // наклон корпуса от вертикали, град.
  hipDy?: number; // сдвиг таза по вертикали в пикселях (для проверки глубины)
  side?: 'left' | 'right';
  frontal?: boolean; // стоит лицом к камере
  visible?: number;
}

/** Человек сбоку, угол в колене = kneeAngle. Голень вертикальна, бедро повёрнуто на kneeAngle от неё. */
export function squatFrame(tMs: number, kneeAngle: number, o: SquatOpts = {}): PoseFrame {
  const lms = emptyLandmarks();
  const vis = o.visible ?? 0.95;
  const knee = { x: 330, y: 330 };
  const ankle = { x: 330, y: 450 };
  const t = deg(kneeAngle);
  const hip = { x: knee.x - 120 * Math.sin(t), y: knee.y + 120 * Math.cos(t) + (o.hipDy ?? 0) };
  const lean = deg(o.lean ?? 15);
  const shoulder = { x: hip.x + 150 * Math.sin(lean), y: hip.y - 150 * Math.cos(lean) };
  const near = o.side ?? 'left';
  const far = near === 'left' ? 'right' : 'left';
  const set = (s: 'left' | 'right', dx: number, v: number) => {
    const k = (name: string) => LM[(s + name) as keyof typeof LM];
    const sdx = o.frontal ? (s === near ? -45 : 45) : dx;
    put(lms, k('Shoulder'), { x: shoulder.x + sdx, y: shoulder.y }, v);
    put(lms, k('Hip'), { x: hip.x + dx, y: hip.y }, v);
    put(lms, k('Knee'), { x: knee.x + dx, y: knee.y }, v);
    put(lms, k('Ankle'), { x: ankle.x + dx, y: ankle.y }, v);
  };
  set(near, 0, vis);
  set(far, 4, o.frontal ? vis : 0.4);
  return { tMs, width: W, height: H, landmarks: lms };
}

export interface PushupOpts {
  hipDy?: number; // > 0 — таз ниже прямой (провисает), < 0 — выше
  visible?: number;
  kneeVisible?: number;
}

/** Отжимание сбоку: запястье на полу, угол в локте = elbowAngle. */
export function pushupFrame(tMs: number, elbowAngle: number, o: PushupOpts = {}): PoseFrame {
  const lms = emptyLandmarks();
  const vis = o.visible ?? 0.95;
  const wrist = { x: 180, y: 420 };
  const elbow = { x: 180, y: 330 };
  const t = deg(elbowAngle);
  const shoulder = { x: elbow.x + 90 * Math.sin(t), y: elbow.y + 90 * Math.cos(t) };
  const ankle = { x: shoulder.x + 400, y: 420 };
  const mid = { x: (shoulder.x + ankle.x) / 2, y: (shoulder.y + ankle.y) / 2 };
  const hip = { x: mid.x, y: mid.y + (o.hipDy ?? 0) };
  const knee = { x: (hip.x + ankle.x) / 2, y: (mid.y + ankle.y) / 2 };
  const set = (s: 'left' | 'right', dx: number, v: number) => {
    const k = (name: string) => LM[(s + name) as keyof typeof LM];
    put(lms, k('Shoulder'), { x: shoulder.x + dx, y: shoulder.y }, v);
    put(lms, k('Elbow'), { x: elbow.x + dx, y: elbow.y }, v);
    put(lms, k('Wrist'), { x: wrist.x + dx, y: wrist.y }, v);
    put(lms, k('Hip'), { x: hip.x + dx, y: hip.y }, v);
    put(lms, k('Knee'), { x: knee.x + dx, y: knee.y }, s === 'left' ? (o.kneeVisible ?? v) : v);
    put(lms, k('Ankle'), { x: ankle.x + dx, y: ankle.y }, v);
  };
  set('left', 0, vis);
  set('right', 4, 0.4);
  return { tMs, width: W, height: H, landmarks: lms };
}

/** Человек стоит (не в упоре) боком к камере и сгибает руку в локте. */
export function uprightArmFrame(tMs: number, elbowAngle: number): PoseFrame {
  const lms = emptyLandmarks();
  const shoulder = { x: 300, y: 150 };
  const elbow = { x: 300, y: 240 };
  const t = deg(elbowAngle);
  const wrist = { x: elbow.x + 90 * Math.sin(t), y: elbow.y - 90 * Math.cos(t) };
  const hip = { x: 300, y: 300 };
  const knee = { x: 300, y: 390 };
  const ankle = { x: 300, y: 470 };
  const set = (s: 'left' | 'right', dx: number, v: number) => {
    const k = (name: string) => LM[(s + name) as keyof typeof LM];
    put(lms, k('Shoulder'), { x: shoulder.x + dx, y: shoulder.y }, v);
    put(lms, k('Elbow'), { x: elbow.x + dx, y: elbow.y }, v);
    put(lms, k('Wrist'), { x: wrist.x + dx, y: wrist.y }, v);
    put(lms, k('Hip'), { x: hip.x + dx, y: hip.y }, v);
    put(lms, k('Knee'), { x: knee.x + dx, y: knee.y }, v);
    put(lms, k('Ankle'), { x: ankle.x + dx, y: ankle.y }, v);
  };
  set('left', 0, 0.95);
  set('right', 4, 0.4);
  return { tMs, width: W, height: H, landmarks: lms };
}

/** Отжимание, где к камере повёрнут правый бок (левые точки почти не видны). */
export function pushupFrameRight(tMs: number, elbowAngle: number): PoseFrame {
  const f = pushupFrame(tMs, elbowAngle);
  const swap = (a: number, b: number) => {
    const t = f.landmarks[a];
    f.landmarks[a] = f.landmarks[b];
    f.landmarks[b] = t;
  };
  for (const [l, r] of [[11, 12], [13, 14], [15, 16], [23, 24], [25, 26], [27, 28]]) swap(l, r);
  return f;
}
