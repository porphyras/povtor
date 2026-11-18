// Прогон записей точек с реальных роликов (e2e/out/*.frames.json), в том числе прореженных до 7,5 и 5 кадров/с.
// Записи появляются после `npm run e2e`; если их нет, тест пропускается.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAnalyzer } from '../src/analyzer/analyzer';
import type { PoseFrame } from '../src/types';
import { loadRecording } from './replay';
import { loadTestConfig } from './synth';

const CASES: { file: string; ex: 'squat' | 'pushup'; min: number; max: number }[] = [
  { file: 'pushup_side', ex: 'pushup', min: 5, max: 6 },
  { file: 'pushup_diagonal', ex: 'pushup', min: 3, max: 7 },
  { file: 'squat_side_two_people', ex: 'squat', min: 2, max: 4 },
  { file: 'squat_front', ex: 'squat', min: 0, max: 0 },
];

function count(frames: PoseFrame[], ex: 'squat' | 'pushup'): number {
  const cfg = loadTestConfig((c) => (c.prepare.readyHoldMs = 200));
  const an = createAnalyzer(ex, cfg);
  let started = false;
  for (const f of frames) {
    const ev = an.push(f, f.tMs);
    if (!started && ev.some((e) => e.type === 'ready' && e.ready)) {
      an.startCounting(f.tMs);
      started = true;
    }
  }
  return an.finish(frames.at(-1)?.tMs ?? 0).totalReps;
}

for (const c of CASES) {
  const url = new URL(`../e2e/out/${c.file}.chromium.frames.json`, import.meta.url);
  describe.skipIf(!existsSync(url))(`запись ${c.file}`, () => {
    const frames = existsSync(url) ? loadRecording(url) : [];
    for (const k of [1, 2, 3]) {
      it(`${(15 / k).toFixed(1)} кадров/с: ${c.min}–${c.max} повторений`, () => {
        const n = count(frames.filter((_, i) => i % k === 0), c.ex);
        expect(n).toBeGreaterThanOrEqual(c.min);
        expect(n).toBeLessThanOrEqual(c.max);
      });
    }
  });
}
