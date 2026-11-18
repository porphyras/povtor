// Случаи из ревью кода: низкая частота кадров, смена бока, старт сразу после «Начали»,
// отжимания без пауз, ложное повторение после подхода, последнее повторение без выпрямления.
import { describe, expect, it } from 'vitest';
import { createAnalyzer } from '../src/analyzer/analyzer';
import type { AnalyzerEvent, PoseFrame } from '../src/types';
import { loadTestConfig, pushupFrame, pushupFrameRight, squatFrame, uprightArmFrame } from './synth';

type Make = (t: number, a: number) => PoseFrame;

function run(exercise: 'squat' | 'pushup', step: number, prepare: [Make, number][], counting: [Make, number[]][], tau?: number) {
  const cfg = loadTestConfig((c) => {
    if (tau !== undefined) c.smoothing.tauMs = tau;
  });
  const an = createAnalyzer(exercise, cfg);
  const ev: AnalyzerEvent[] = [];
  let t = 0;
  for (const [make, ms] of prepare) for (const end = t + ms; t < end; t += step) ev.push(...an.push(make(t, 170), t));
  an.startCounting(t);
  for (const [make, angles] of counting) for (const a of angles) ev.push(...an.push(make(t, a), t)), (t += step);
  return { an, ev, t, reps: ev.filter((e) => e.type === 'rep').map((e) => (e as { rep: { errors: string[] } }).rep) };
}

/** Плавное повторение: от top вниз до bottom и обратно, по кадрам с шагом step мс, длительность durMs. */
function cycle(top: number, bottom: number, durMs: number, step: number): number[] {
  const n = Math.max(3, Math.round(durMs / step));
  return Array.from({ length: n }, (_, i) => bottom + ((top - bottom) * (1 + Math.cos((2 * Math.PI * i) / n))) / 2);
}

describe('низкая частота кадров', () => {
  for (const step of [67, 135, 200]) {
    it(`приседания считаются при шаге ${step} мс`, () => {
      const one = cycle(172, 80, 2000, step);
      const hold = Array(Math.ceil(700 / step)).fill(172);
      const r = run('squat', step, [[squatFrame, 1200]], [[squatFrame, [...hold, ...one, ...one, ...one, ...hold]]]);
      expect(r.reps.length).toBe(3);
    });
    it(`отжимания считаются при шаге ${step} мс`, () => {
      const one = cycle(168, 80, 2000, step);
      const hold = Array(Math.ceil(700 / step)).fill(168);
      const r = run('pushup', step, [[pushupFrame, 1200]], [[pushupFrame, [...hold, ...one, ...one, ...hold]]]);
      expect(r.reps.length).toBe(2);
    });
  }
});

describe('смена бока и старт сразу после «Начали»', () => {
  it('на подготовке к камере левый бок, в упоре правый — отжимания считаются', () => {
    const one = cycle(168, 80, 1600, 67);
    const r = run('pushup', 67, [[uprightArmFrame, 1500]], [[pushupFrameRight, [...Array(10).fill(168), ...one, ...one, 168, 168]]]);
    expect(r.an.debug().side).toBe('right');
    expect(r.reps.length).toBe(2);
  });
  it('начал приседать сразу после «Начали»: первое повторение не теряется', () => {
    const one = cycle(172, 80, 1600, 67);
    const r = run('squat', 67, [[squatFrame, 1500]], [[squatFrame, [...one, ...one, 172]]]);
    expect(r.reps.length).toBe(2);
  });
});

describe('отжимания без пауз наверху', () => {
  it('вверху всего два кадра выше порога, повторения всё равно считаются', () => {
    const seq = [130, 145, 156, 158, 140, 115, 95, 85, 85, 100, 120, 140, 156, 158, 140, 115, 95, 85, 85, 100, 120, 140, 156, 158];
    const r = run('pushup', 67, [[uprightArmFrame, 1500]], [[pushupFrame, seq]], 0);
    expect(r.reps.length).toBe(2);
  });
  it('если долго не встаёт в исходное положение — подсказка «замри»', () => {
    const wobble = Array.from({ length: 60 }, (_, i) => 135 + 12 * Math.sin(i / 2));
    const r = run('pushup', 67, [[uprightArmFrame, 1500]], [[pushupFrame, wobble]], 0);
    expect(r.ev.some((e) => e.type === 'hint')).toBe(true);
  });
});

describe('после подхода', () => {
  it('встал из упора и согнул руку — не повторение; через 8 с подход заканчивается сам', () => {
    const one = cycle(168, 80, 1600, 67);
    const after = Array.from({ length: 140 }, (_, i) => 120 + 50 * Math.abs(Math.sin(i / 6)));
    const r = run('pushup', 67, [[uprightArmFrame, 1500]], [[pushupFrame, [...Array(10).fill(168), ...one, 168, 168]], [uprightArmFrame, after]]);
    expect(r.reps.length).toBe(1);
    expect(r.ev).toContainEqual({ type: 'finish', reason: 'away' });
  });
  it('последнее повторение без полного выпрямления засчитывается при завершении', () => {
    const r = run('pushup', 67, [[pushupFrame, 1500]], [[pushupFrame, [168, 168, 168, 168, 168, 168, 168, 168, 140, 110, 90, 85, 85, 95, 115, 130, 140]]], 0);
    expect(r.reps.length).toBe(0);
    expect(r.an.finish(r.t).totalReps).toBe(1);
  });
});
