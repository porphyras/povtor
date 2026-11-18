import type { PoseFrame, Side } from '../types';
import { jointIndex, LM } from '../analyzer/geometry';

const PAIRS: [number, number][] = [
  [LM.leftShoulder, LM.rightShoulder],
  [LM.leftHip, LM.rightHip],
  [LM.leftShoulder, LM.leftHip],
  [LM.rightShoulder, LM.rightHip],
  [LM.leftShoulder, LM.leftElbow],
  [LM.leftElbow, LM.leftWrist],
  [LM.rightShoulder, LM.rightElbow],
  [LM.rightElbow, LM.rightWrist],
  [LM.leftHip, LM.leftKnee],
  [LM.leftKnee, LM.leftAnkle],
  [LM.rightHip, LM.rightKnee],
  [LM.rightKnee, LM.rightAnkle],
];

function sideSet(side: Side | null): Set<number> {
  if (!side) return new Set();
  return new Set((['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle'] as const).map((j) => jointIndex(side, j)));
}

/** Рисует скелет поверх видео. Сторона, по которой считаем, выделена. */
export function drawSkeleton(ctx: CanvasRenderingContext2D, frame: PoseFrame | null, side: Side | null, minVis: number, warn = false): void {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  if (!frame) return;
  const main = sideSet(side);
  const p = (i: number) => ({ x: frame.landmarks[i].x * width, y: frame.landmarks[i].y * height, v: frame.landmarks[i].visibility });
  const scale = Math.max(1, Math.min(width, height) / 360);
  ctx.lineCap = 'round';
  for (const [a, b] of PAIRS) {
    const A = p(a);
    const B = p(b);
    if (A.v < minVis * 0.5 || B.v < minVis * 0.5) continue;
    const strong = main.has(a) && main.has(b);
    ctx.strokeStyle = strong ? (warn ? '#F08A24' : '#3D8BFD') : 'rgba(255,255,255,0.55)';
    ctx.lineWidth = (strong ? 5 : 3) * scale;
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    ctx.lineTo(B.x, B.y);
    ctx.stroke();
  }
  for (const i of new Set(PAIRS.flat())) {
    const P = p(i);
    if (P.v < minVis * 0.5) continue;
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = main.has(i) ? (warn ? '#F08A24' : '#3D8BFD') : 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2.5 * scale;
    ctx.beginPath();
    ctx.arc(P.x, P.y, (main.has(i) ? 6 : 4) * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}
