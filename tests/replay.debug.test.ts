// Отладочный прогон записи точек через анализатор с печатью сигналов по кадрам.
// Запуск: REPLAY=e2e/out/pushup_side.frames.json EX=pushup npx vitest run tests/replay.debug.test.ts
import { describe, it } from 'vitest';
import { createAnalyzer } from '../src/analyzer/analyzer';
import { angleAt, angleAt3, jointIndex, px, shoulderRatio, tiltFromHorizontal, tiltFromVertical } from '../src/analyzer/geometry';
import { loadRecording } from './replay';
import { loadTestConfig } from './synth';
import type { Exercise } from '../src/types';

const file = process.env.REPLAY;
const ex = (process.env.EX ?? 'pushup') as Exercise;

describe.skipIf(!file)('replay', () => {
  it('печатает сигналы', () => {
    const k = Number(process.env.THIN ?? 1);
    const frames = loadRecording(new URL('../' + file, import.meta.url)).filter((_, i) => i % k === 0);
    const cfg = loadTestConfig((c) => {
      c.prepare.readyHoldMs = 200;
    });
    const an = createAnalyzer(ex, cfg);
    const lines: string[] = [];
    let started = false;
    for (const f of frames) {
      const ev = an.push(f, f.tMs);
      if (!started && ev.some((e) => e.type === 'ready' && e.ready)) {
        an.startCounting(f.tMs);
        started = true;
      }
      const d = an.debug();
      const s = d.side;
      const [a, b, c] = ['squat', 'lunge', 'wallsit'].includes(ex) ? (['hip', 'knee', 'ankle'] as const) : (['shoulder', 'elbow', 'wrist'] as const);
      const ia = jointIndex(s, a), ib = jointIndex(s, b), ic = jointIndex(s, c);
      const a2 = angleAt(px(f, ia), px(f, ib), px(f, ic));
      const a3 = f.world ? angleAt3(f.world[ia], f.world[ib], f.world[ic]) : NaN;
      const vis = [ia, ib, ic].map((i) => f.landmarks[i].visibility.toFixed(2)).join('/');
      const other = s === 'left' ? 'right' : 'left';
      const visO = [jointIndex(other, a), jointIndex(other, b), jointIndex(other, c)].map((i) => f.landmarks[i].visibility.toFixed(2)).join('/');
      const sh = px(f, jointIndex(s, 'shoulder'));
      const hp = px(f, jointIndex(s, 'hip'));
      const kn = px(f, jointIndex(s, 'knee'));
      const tilt = ['pushup', 'plank'].includes(ex) ? tiltFromHorizontal(sh, kn) : tiltFromVertical(sh, hp);
      lines.push(
        `${String(f.tMs).padStart(6)} ${d.phase.padEnd(8)} ${d.state.padEnd(7)} ${String(d.status).padEnd(14)} side=${s[0]} 2d=${a2.toFixed(0).padStart(4)} 3d=${a3.toFixed(0).padStart(4)} ema=${d.angle?.toFixed(0) ?? '—'} thr=${d.top.toFixed(0)}/${d.start.toFixed(0)} lock=${d.sideLocked ? 1 : 0} vis=${vis} other=${visO} ratio=${shoulderRatio(f).toFixed(2)} tilt=${tilt.toFixed(0)} ${ev.map((e) => e.type + (e.type === 'rep' ? '#' + e.rep.index + ':' + e.rep.errors.join(',') : e.type === 'status' ? ':' + e.status : '')).join(' ')}`,
      );
    }
    const sum = an.finish(frames.at(-1)?.tMs ?? 0);
    console.log(lines.join('\n'));
    console.log('ИТОГ', sum.totalReps, 'чистых', sum.cleanReps, 'удержание', sum.holdMs, sum.cleanHoldMs, JSON.stringify(sum.errorsCount));
  });
});
