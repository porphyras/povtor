// Прогон записей точек с реальных роликов, в том числе прореженных до 7,5 и 5 кадров/с.
// Записи лежат в tests/fixtures (точки тела, снятые со стоковых роликов Mixkit; самих видео в репозитории нет).
// Обновить: npm run e2e, затем gzip e2e/out/<имя>.chromium.frames.json в tests/fixtures/<имя>.frames.json.gz.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAnalyzer } from '../src/analyzer/analyzer';
import type { Exercise, PoseFrame } from '../src/types';
import { loadRecording } from './replay';
import { loadTestConfig } from './synth';

const CASES: { file: string; ex: Exercise; min: number; max: number; holdMin?: number }[] = [
  { file: 'pushup_side', ex: 'pushup', min: 5, max: 6 },
  { file: 'pushup_diagonal', ex: 'pushup', min: 3, max: 7 },
  { file: 'squat_side_two_people', ex: 'squat', min: 2, max: 4 },
  { file: 'squat_front', ex: 'squat', min: 0, max: 0 },
  { file: 'lunge_side', ex: 'lunge', min: 1, max: 1 },
  { file: 'lunge_side_far', ex: 'lunge', min: 3, max: 3 },
  { file: 'situp_side', ex: 'crunch', min: 1, max: 2 }, // первый подъём начинается с первого кадра — на редких кадрах исходное положение не успевает найтись
  { file: 'curl_diagonal', ex: 'curl', min: 0, max: 0 },
  { file: 'plank_side', ex: 'plank', min: 0, max: 0, holdMin: 9000 },
];

function count(frames: PoseFrame[], ex: Exercise): { reps: number; holdMs: number } {
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
  const sum = an.finish(frames.at(-1)?.tMs ?? 0);
  return { reps: sum.totalReps, holdMs: sum.holdMs };
}

for (const c of CASES) {
  const url = new URL(`./fixtures/${c.file}.frames.json.gz`, import.meta.url);
  describe.skipIf(!existsSync(url))(`запись ${c.file}`, () => {
    const frames = existsSync(url) ? loadRecording(url) : [];
    for (const k of [1, 2, 3]) {
      it(`${(15 / k).toFixed(1)} кадров/с: ${c.min}–${c.max} повторений`, () => {
        const r = count(frames.filter((_, i) => i % k === 0), c.ex);
        expect(r.reps).toBeGreaterThanOrEqual(c.min);
        expect(r.reps).toBeLessThanOrEqual(c.max);
        if (c.holdMin) expect(r.holdMs).toBeGreaterThanOrEqual(c.holdMin);
      });
    }
  });
}
