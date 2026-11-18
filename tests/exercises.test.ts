// Новые упражнения на синтетических позах: счёт и правила техники.
import { describe, expect, it } from 'vitest';
import { createAnalyzer } from '../src/analyzer/analyzer';
import type { AnalyzerEvent, Exercise, PoseFrame } from '../src/types';
import { bridgeFrame, crunchFrame, curlFrame, loadTestConfig, pressFrame, pushupFrame, raiseFrame, squatFrame } from './synth';

const STEP = 67;
type Make = (t: number, v: number) => PoseFrame;

function run(ex: Exercise, make: Make, rest: number, seq: number[]) {
  const an = createAnalyzer(ex, loadTestConfig());
  const ev: AnalyzerEvent[] = [];
  let t = 0;
  for (; t < 1500; t += STEP) ev.push(...an.push(make(t, rest), t));
  an.startCounting(t);
  for (const v of seq) ev.push(...an.push(make(t, v), t)), (t += STEP);
  const sum = an.finish(t);
  return { ev, sum, reps: ev.filter((e) => e.type === 'rep').map((e) => (e as { rep: { errors: string[]; minAngle: number } }).rep) };
}

/** Плавный цикл от a к b и обратно. */
const cycle = (a: number, b: number, n = 24) => Array.from({ length: n }, (_, i) => b + ((a - b) * (1 + Math.cos((2 * Math.PI * i) / n))) / 2);
const hold = (v: number, n = 10) => Array(n).fill(v);

describe('выпады', () => {
  it('два глубоких выпада — чистые, неглубокий — «Ниже»', () => {
    const r = run('lunge', squatFrame, 172, [...hold(172), ...cycle(172, 88), ...cycle(172, 88), ...cycle(172, 115), ...hold(172)]);
    expect(r.reps.length).toBe(3);
    expect(r.reps[0].errors).toEqual([]);
    expect(r.reps[2].errors).toContain('LUNGE_DEPTH');
  });
  it('шаг (сгибается только маховая нога) — не выпад', () => {
    // ближняя нога сгибается до 95°, дальняя остаётся прямой
    const step: Make = (t, a) => {
      const f = squatFrame(t, a);
      const straight = squatFrame(t, 170);
      for (const i of [24, 26, 28]) f.landmarks[i] = { ...straight.landmarks[i], visibility: 0.9 };
      return f;
    };
    expect(run('lunge', step, 172, [...hold(172), ...cycle(172, 95), ...cycle(172, 95), ...hold(172)]).reps.length).toBe(0);
  });
  it('наклон корпуса в выпаде — «Корпус ровнее»', () => {
    const lean: Make = (t, a) => squatFrame(t, a, { lean: a < 130 ? 40 : 5 });
    const r = run('lunge', lean, 172, [...hold(172), ...cycle(172, 88), ...hold(172)]);
    expect(r.reps[0].errors).toContain('LUNGE_LEAN');
  });
});

describe('ягодичный мост', () => {
  it('подъём таза до прямой линии — повторения, неполный — «Таз выше»', () => {
    const r = run('bridge', bridgeFrame, 0, [...hold(0), ...cycle(0, 48), ...cycle(0, 48), ...cycle(0, 34), ...hold(0)]);
    expect(r.reps.length).toBe(3);
    expect(r.reps[0].errors).toEqual([]);
    expect(r.reps[0].minAngle).toBeGreaterThan(170);
    expect(r.reps[2].errors).toEqual(['BRIDGE_HEIGHT']);
  });
});

describe('скручивания', () => {
  it('подъём корпуса на 35° — повторение, на 27° — «Оторви лопатки»', () => {
    const r = run('crunch', crunchFrame, 3, [...hold(3), ...cycle(3, 38), ...cycle(3, 38), ...cycle(3, 27), ...hold(3)]);
    expect(r.reps.length).toBe(3);
    expect(r.reps[0].errors).toEqual([]);
    expect(r.reps[2].errors).toEqual(['CRUNCH_LOW']);
  });
});

describe('сгибания рук', () => {
  it('чистые повторения, раскачка корпусом и локоть вперёд', () => {
    const clean = run('curl', curlFrame, 170, [...hold(170), ...cycle(170, 45), ...cycle(170, 45), ...hold(170)]);
    expect(clean.reps.length).toBe(2);
    expect(clean.reps.every((r) => r.errors.length === 0)).toBe(true);
    const swing: Make = (t, a) => curlFrame(t, a, { lean: a < 120 ? 22 : 0 });
    expect(run('curl', swing, 170, [...hold(170), ...cycle(170, 45), ...hold(170)]).reps[0].errors).toContain('CURL_SWING');
    const drift: Make = (t, a) => curlFrame(t, a, { drift: a < 90 ? 45 : 0 });
    expect(run('curl', drift, 170, [...hold(170), ...cycle(170, 45), ...hold(170)]).reps[0].errors).toContain('CURL_ELBOW');
  });
});

describe('жим над головой', () => {
  it('руки выпрямляются — чистые повторения, не до конца — «Выпрями руки»', () => {
    const r = run('press', pressFrame, 85, [...hold(85), ...cycle(85, 172), ...cycle(85, 172), ...cycle(85, 160), ...hold(85)]);
    expect(r.reps.length).toBe(3);
    expect(r.reps[0].errors).toEqual([]);
    expect(r.reps[2].errors).toEqual(['PRESS_LOCKOUT']);
  });
  it('стоит боком — просим встать лицом', () => {
    const r = run('press', (t, a) => curlFrame(t, a), 170, hold(170, 20));
    expect(r.ev).toContainEqual({ type: 'status', status: 'WRONG_POSITION' });
    expect(r.reps.length).toBe(0);
  });
});

describe('разведение рук', () => {
  it('до уровня плеч — чистые, ниже — «Выше», сильно выше — «Не выше плеч»', () => {
    const r = run('raise', raiseFrame, 15, [...hold(15), ...cycle(15, 88), ...cycle(15, 70), ...cycle(15, 130), ...hold(15)]);
    expect(r.reps.length).toBe(3);
    expect(r.reps[0].errors).toEqual([]);
    expect(r.reps[1].errors).toEqual(['RAISE_LOW']);
    expect(r.reps[2].errors).toEqual(['RAISE_HIGH']);
  });
});

describe('удержание', () => {
  it('«стульчик»: время в позе копится, слишком высоко — «Ниже» и меньше чистого времени', () => {
    const good = run('wallsit', (t, a) => squatFrame(t, a, { lean: 3 }), 172, [...hold(172, 5), ...hold(90, 45), ...hold(172, 5)]);
    expect(good.sum.kind).toBe('hold');
    expect(good.sum.holdMs).toBeGreaterThan(2500);
    expect(good.sum.cleanHoldMs).toBe(good.sum.holdMs);
    const high = run('wallsit', (t, a) => squatFrame(t, a, { lean: 3 }), 172, [...hold(90, 30), ...hold(118, 30)]);
    expect(high.sum.errorsCount.WALLSIT_HIGH).toBe(1);
    expect(high.sum.cleanHoldMs).toBeLessThan(high.sum.holdMs);
  });
  it('планка: провис таза — подсказка; ушёл из позы на 8 с — подход окончен', () => {
    const sag: Make = (t, v) => pushupFrame(t, 170, { hipDy: v });
    const seq = [...hold(0, 30), ...hold(80, 30)];
    const r = run('plank', sag, 0, seq);
    expect(r.ev).toContainEqual({ type: 'tip', code: 'PLANK_SAG' });
    expect(r.sum.holdMs).toBeGreaterThan(3000);
    expect(r.sum.cleanHoldMs).toBeLessThan(r.sum.holdMs);
    // в планке, потом встал (вертикально) на 9 секунд
    const an = createAnalyzer('plank', loadTestConfig());
    let t = 0;
    const ev: AnalyzerEvent[] = [];
    for (; t < 1500; t += STEP) ev.push(...an.push(pushupFrame(t, 170), t));
    an.startCounting(t);
    for (let i = 0; i < 40; i++, t += STEP) ev.push(...an.push(pushupFrame(t, 170), t));
    for (let i = 0; i < 140; i++, t += STEP) ev.push(...an.push(curlFrame(t, 170), t));
    expect(ev).toContainEqual({ type: 'finish', reason: 'away' });
  });
});
