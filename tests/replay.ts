import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { PoseFrame } from '../src/types';

/** Формат записи точек из e2e: компактные массивы с 4 знаками. */
export interface RecordedFrame {
  t: number;
  w: number;
  h: number;
  l: [number, number, number, number][];
  g?: [number, number, number][];
}

export function loadRecording(path: string | URL): PoseFrame[] {
  const buf = readFileSync(path);
  const text = String(path).endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  const raw = JSON.parse(text) as RecordedFrame[];
  return raw.map((f) => ({
    tMs: f.t,
    width: f.w,
    height: f.h,
    landmarks: f.l.map(([x, y, z, visibility]) => ({ x, y, z, visibility })),
    world: f.g?.map(([x, y, z]) => ({ x, y, z, visibility: 1 })),
  }));
}
