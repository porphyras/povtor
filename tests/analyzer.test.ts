import { describe, expect, it } from 'vitest';
import { createAnalyzer } from '../src/analyzer/analyzer';
import { angleAt, hipOffsetFromLine, px, tiltFromVertical } from '../src/analyzer/geometry';
import { validateConfig } from '../src/config';
import type { AnalyzerEvent, PoseFrame } from '../src/types';
import { loadTestConfig, pushupFrame, squatFrame, W, H } from './synth';

const STEP = 100; // кадры через 100 мс, как в контрольном примере архитектуры

/** Готовит анализатор: секунда стойки в подготовке, старт счёта, ещё 0,6 с стойки (ОЖИДАНИЕ → ВВЕРХУ). */
function started(exercise: 'squat' | 'pushup', make: (t: number, a: number) => PoseFrame, patch?: Parameters<typeof loadTestConfig>[0]) {
  const cfg = loadTestConfig(patch);
  const an = createAnalyzer(exercise, cfg);
  let t = 0;
  const events: AnalyzerEvent[] = [];
  const top = exercise === 'squat' ? 170 : 170;
  for (let i = 0; i < 12; i++) events.push(...an.push(make(t, top), t)), (t += STEP);
  an.startCounting(t);
  for (let i = 0; i < 7; i++) events.push(...an.push(make(t, top), t)), (t += STEP);
  return {
    an,
    cfg,
    events,
    feed(angles: number[], f: (t: number, a: number) => PoseFrame = make) {
      const out: AnalyzerEvent[] = [];
      for (const a of angles) {
        out.push(...an.push(f(t, a), t));
        t += STEP;
      }
      events.push(...out);
      return out;
    },
    feedNull(n: number) {
      const out: AnalyzerEvent[] = [];
      for (let i = 0; i < n; i++) {
        out.push(...an.push(null, t));
        t += STEP;
      }
      events.push(...out);
      return out;
    },
    get t() {
      return t;
    },
  };
}

const reps = (ev: AnalyzerEvent[]) => ev.filter((e) => e.type === 'rep').map((e) => (e as { rep: { errors: string[]; minAngle: number } }).rep);
const noSmoothing = (c: { smoothing: { tauMs: number } }) => {
  c.smoothing.tauMs = 0;
};

describe('геометрия', () => {
  it('угол в суставе', () => {
    expect(angleAt({ x: 0, y: -1 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(90);
    expect(angleAt({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(180);
    expect(Number.isNaN(angleAt({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }))).toBe(true);
  });
  it('перевод в пиксели учитывает разные стороны кадра', () => {
    const f = squatFrame(0, 120);
    const knee = px(f, 25);
    expect(knee.x).toBeCloseTo(330);
    expect(knee.y).toBeCloseTo(330);
    // угол в колене, посчитанный в пикселях, совпадает с заданным
    expect(angleAt(px(f, 23), px(f, 25), px(f, 27))).toBeCloseTo(120, 5);
    // а в нормированных координатах был бы искажён (кадр не квадратный)
    const n = (i: number) => ({ x: f.landmarks[i].x, y: f.landmarks[i].y });
    expect(Math.abs(angleAt(n(23), n(25), n(27)) - 120)).toBeGreaterThan(5);
    expect(W).not.toBe(H);
  });
  it('наклон от вертикали и положение таза', () => {
    expect(tiltFromVertical({ x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(0);
    expect(tiltFromVertical({ x: 0, y: 0 }, { x: 10, y: 10 })).toBeCloseTo(45);
    expect(hipOffsetFromLine({ x: 0, y: 0 }, { x: 50, y: 10 }, { x: 100, y: 0 }, 10)).toBeCloseTo(10);
    expect(hipOffsetFromLine({ x: 0, y: 0 }, { x: 50, y: -10 }, { x: 100, y: 0 }, 10)).toBeCloseTo(-10);
    expect(Number.isNaN(hipOffsetFromLine({ x: 0, y: 0 }, { x: 1, y: 5 }, { x: 2, y: 10 }, 10))).toBe(true);
  });
});

describe('контрольный пример из архитектуры (приседания, без сглаживания)', () => {
  it('2 повторения на всей последовательности', () => {
    const s = started('squat', squatFrame, noSmoothing);
    const seq = [
      170, 158, 140, 115, 95, 92, 92, 110, 140, 162, // одно повторение, минимум 92
      165, 145, 130, 128, 135, 150, 165, // покачивание: минимум 130
      165, 148, 118, 117, 125, 155, 158, 161, // одно повторение, засчитано на 161
      165, 149, 155, 148, 161, // ничего
    ];
    const r = reps(s.feed(seq));
    expect(r.length).toBe(2);
    expect(r[0].minAngle).toBe(92);
    expect(r[1].minAngle).toBe(118);
  });
  it('повторение засчитывается только на возврате выше 160°', () => {
    const s = started('squat', squatFrame, noSmoothing);
    expect(reps(s.feed([165, 148, 118, 117, 125, 155, 158])).length).toBe(0);
    expect(reps(s.feed([161])).length).toBe(1);
  });
  it('выброс в один кадр не делает повторение засчитанным (медиана трёх кадров)', () => {
    const s = started('squat', squatFrame, noSmoothing);
    expect(reps(s.feed([145, 140, 100, 140, 145, 165])).length).toBe(0);
  });
  it('слишком быстрое движение (< 0,4 с) не считается', () => {
    const s = started('squat', squatFrame, noSmoothing);
    expect(reps(s.feed([140, 100, 100, 165])).length).toBe(0); // 300 мс
  });
});

describe('подстройка под стойку и «мягкий верх»', () => {
  it('человек не выпрямляет ноги до 160°: пороги подстраиваются под его стойку', () => {
    const cfg = loadTestConfig(noSmoothing);
    const an = createAnalyzer('squat', cfg);
    let t = 0;
    for (; t < 1200; t += STEP) an.push(squatFrame(t, 156), t);
    an.startCounting(t);
    const ev: AnalyzerEvent[] = [];
    const feed = (a: number[]) => a.forEach((x) => ((ev.push(...an.push(squatFrame(t, x), t)), (t += STEP))));
    feed([156, 156, 156, 156, 156, 156, 156]);
    expect(an.debug().top).toBeLessThanOrEqual(146);
    feed([140, 120, 100, 95, 95, 110, 130, 150, 156, 156, 140, 120, 100, 95, 95, 110, 130, 150, 156]);
    expect(reps(ev).length).toBe(2);
  });
  it('устал и не выпрямился до порога между повторениями — повторения не склеиваются', () => {
    const s = started('pushup', pushupFrame, noSmoothing);
    // вверху только до 140°, хотя порог 155°
    const r = reps(s.feed([170, 140, 100, 85, 85, 110, 130, 140, 135, 120, 100, 85, 85, 110, 140, 160]));
    expect(r.length).toBe(2);
  });
});

describe('техника приседаний', () => {
  it('глубокий присед чистый, неглубокий — SQUAT_DEPTH (по углу бедра)', () => {
    const s = started('squat', squatFrame, noSmoothing);
    const deep = reps(s.feed([140, 110, 85, 80, 80, 110, 140, 170]));
    expect(deep[0].errors).toEqual([]);
    const shallow = reps(s.feed([140, 120, 112, 110, 110, 125, 140, 170]));
    expect(shallow[0].errors).toEqual(['SQUAT_DEPTH']);
  });
  it('сильный наклон корпуса — SQUAT_LEAN, приоритет у глубины', () => {
    const s = started('squat', squatFrame, noSmoothing);
    const lean = (t: number, a: number) => squatFrame(t, a, { lean: a < 130 ? 65 : 15 });
    const r = reps(s.feed([140, 110, 85, 80, 80, 110, 140, 170], lean));
    expect(r[0].errors).toEqual(['SQUAT_LEAN']);
    const both = s.feed([140, 120, 110, 110, 110, 125, 140, 170], lean);
    expect(reps(both)[0].errors).toEqual(['SQUAT_DEPTH', 'SQUAT_LEAN']);
  });
  it('подсказки не чаще раза в 2 секунды', () => {
    const s = started('squat', squatFrame, noSmoothing);
    const ev = s.feed([140, 112, 110, 110, 170, 140, 112, 110, 110, 170]); // два неглубоких подряд за 1 с
    expect(reps(ev).length).toBe(2);
    expect(ev.filter((e) => e.type === 'tip').length).toBe(1);
  });
});

describe('отжимания', () => {
  it('контрольный пример: чистое и с ошибкой глубины', () => {
    const s = started('pushup', pushupFrame, noSmoothing);
    const a = reps(s.feed([170, 140, 95, 85, 85, 120, 160]));
    expect(a.length).toBe(1);
    expect(a[0].errors).toEqual([]);
    const b = reps(s.feed([165, 130, 100, 98, 98, 130, 158]));
    expect(b.length).toBe(1);
    expect(b[0].errors).toEqual(['PUSHUP_DEPTH']);
  });
  it('таз провисает и таз задран (линия плечо–таз–колено держится ≥ 250 мс)', () => {
    const s = started('pushup', pushupFrame, noSmoothing);
    const seq = [170, 140, 110, 95, 85, 85, 90, 110, 130, 160];
    const sag = (t: number, a: number) => pushupFrame(t, a, { hipDy: a < 120 ? 70 : 0 });
    expect(reps(s.feed(seq, sag))[0].errors).toEqual(['PUSHUP_HIP_SAG']);
    const pike = (t: number, a: number) => pushupFrame(t, a, { hipDy: a < 120 ? -70 : 0 });
    expect(reps(s.feed(seq, pike))[0].errors).toEqual(['PUSHUP_HIP_PIKE']);
  });
  it('провис в одном кадре не считается ошибкой', () => {
    const s = started('pushup', pushupFrame, noSmoothing);
    const blip = (t: number, a: number) => pushupFrame(t, a, { hipDy: a === 84 ? 70 : 0 });
    expect(reps(s.feed([170, 140, 110, 95, 85, 84, 85, 90, 110, 130, 160], blip))[0].errors).toEqual([]);
  });
  it('колена не видно — счёт идёт, правило линии тела пропускается', () => {
    const s = started('pushup', (t, a) => pushupFrame(t, a, { kneeVisible: 0.2, hipDy: a < 120 ? 70 : 0 }), noSmoothing);
    const r = reps(s.feed([170, 140, 110, 95, 85, 85, 90, 110, 130, 160]));
    expect(r.length).toBe(1);
    expect(r[0].errors).toEqual([]);
  });
});

describe('видимость, сторона, положение', () => {
  it('человек пропал дольше 1 с — пауза, начатое повторение отбрасывается', () => {
    const s = started('squat', squatFrame, noSmoothing);
    s.feed([140, 110, 90]);
    const lost = s.feedNull(12);
    expect(lost).toContainEqual({ type: 'status', status: 'NOT_VISIBLE' });
    expect(s.an.debug().state).toBe('PAUSED');
    const back = s.feed([110, 140, 170, 170, 170, 170, 170, 170, 170]);
    expect(back).toContainEqual({ type: 'status', status: 'OK' });
    expect(reps(back).length).toBe(0);
    expect(reps(s.feed([140, 110, 90, 90, 110, 140, 170])).length).toBe(1);
  });
  it('короткое пропадание (< 1 с) не прерывает повторение', () => {
    const s = started('squat', squatFrame, noSmoothing);
    s.feed([140, 110]);
    s.feedNull(4);
    expect(reps(s.feed([90, 90, 90, 110, 140, 170])).length).toBe(1);
  });
  it('выбирает сторону, которая лучше видна', () => {
    const cfg = loadTestConfig();
    const an = createAnalyzer('squat', cfg);
    for (let t = 0; t < 1200; t += STEP) an.push(squatFrame(t, 170, { side: 'right' }), t);
    an.startCounting(1200);
    expect(an.debug().side).toBe('right');
  });
  it('стоит лицом к камере — WRONG_POSITION, готовности нет', () => {
    const cfg = loadTestConfig();
    const an = createAnalyzer('squat', cfg);
    const ev: AnalyzerEvent[] = [];
    for (let t = 0; t < 2000; t += STEP) ev.push(...an.push(squatFrame(t, 170, { frontal: true }), t));
    expect(ev).toContainEqual({ type: 'status', status: 'WRONG_POSITION' });
    expect(ev.some((e) => e.type === 'ready' && e.ready)).toBe(false);
  });
  it('сбоку и целиком в кадре — готовность через readyHoldMs', () => {
    const cfg = loadTestConfig();
    const an = createAnalyzer('squat', cfg);
    const ev: AnalyzerEvent[] = [];
    for (let t = 0; t <= 1500; t += STEP) ev.push(...an.push(squatFrame(t, 170), t));
    expect(ev).toContainEqual({ type: 'status', status: 'OK' });
    expect(ev).toContainEqual({ type: 'ready', ready: true });
  });
});

describe('завершение подхода', () => {
  it('60 секунд без повторений — finish idle', () => {
    const s = started('squat', squatFrame);
    let ev: AnalyzerEvent[] = [];
    for (let i = 0; i < 620; i++) ev = ev.concat(s.feed([170]));
    expect(ev).toContainEqual({ type: 'finish', reason: 'idle' });
  });
  it('итог считает чистые и ошибки', () => {
    const s = started('squat', squatFrame, noSmoothing);
    s.feed([140, 110, 85, 80, 80, 110, 140, 170]);
    s.feed([140, 120, 112, 110, 110, 125, 140, 170]);
    const sum = s.an.finish(s.t);
    expect(sum.totalReps).toBe(2);
    expect(sum.cleanReps).toBe(1);
    expect(sum.errorsCount).toEqual({ SQUAT_DEPTH: 1 });
    expect(sum.reps.map((r) => r.index)).toEqual([1, 2]);
  });
  it('сглаживание по умолчанию не ломает счёт', () => {
    const s = started('squat', squatFrame);
    const one = [170, 160, 145, 130, 115, 100, 90, 85, 85, 90, 100, 115, 130, 145, 160, 170, 175, 175];
    expect(reps(s.feed([...one, ...one, ...one])).length).toBe(3);
  });
});

describe('конфигурация', () => {
  it('ловит неверные пороги', () => {
    const c = loadTestConfig();
    const bad = JSON.parse(JSON.stringify(c));
    bad.exercises.squat.start = 170; // start больше top
    expect(() => validateConfig(bad)).toThrow(/attempt < start < top/);
    const noErr = JSON.parse(JSON.stringify(c));
    noErr.errors = noErr.errors.slice(1);
    expect(() => validateConfig(noErr)).toThrow(/SQUAT_DEPTH/);
  });
});
