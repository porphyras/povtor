// Корпус реальных роликов: 106 стоковых видео по всем 10 упражнениям (Mixkit, Pexels, Wikimedia Commons).
// Самих видео в репозитории нет — только записанные с них точки тела (tests/corpus/frames) и эталон
// (tests/corpus/manifest.json: сколько повторений или секунд удержания там на самом деле, источник, лицензия).
// Анализатор переигрывает записи так же, как в режиме видеофайла: подготовка 200 мс, без отсчёта.
// Переигровка совпадает с браузером по повторениям и удержанию на всех 106 роликах.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAnalyzer } from '../src/analyzer/analyzer';
import type { AnalyzerEvent, Exercise, PoseFrame } from '../src/types';
import { loadRecording } from './replay';
import { loadTestConfig } from './synth';

interface Entry {
  file: string;
  exercise: Exercise;
  view: 'side' | 'front';
  expect: [number, number];
  hold?: [number, number];
  status?: string;
  kind: 'positive' | 'hard' | 'negative';
  note: string;
}

/** Известные провалы: причина разобрана, правилом без вреда для остальных роликов не лечится. */
const KNOWN: Record<string, string> = {
  squat_side_silhouette_kettlebell_wm: 'подъём гирь с пола (колени 110–114°) засчитывается как неглубокий присед с подсказкой «Ниже»',
  press_kettlebell_silhouette_wm: 'силуэт вполоборота: во время жима ракурс уходит за порог «лицом»',
  press_neg_raise_px5319098: 'разведения засчитываются как один жим',
  raise_neg_jumpingjacks_wm: 'прыжки «джампинг-джек» с руками над головой засчитываются как разведения с подсказкой «Не выше плеч»',
  plank_transitions_vertical_px6437916: 'колени у края кадра, видимость ниже порога: планка не засчитывается',
};

const dir = new URL('./corpus/', import.meta.url);
const manifestUrl = new URL('manifest.json', dir);
const manifest: Entry[] = existsSync(manifestUrl) ? JSON.parse(readFileSync(manifestUrl, 'utf8')) : [];

function replay(ex: Exercise, frames: PoseFrame[]) {
  const cfg = loadTestConfig((c) => (c.prepare.readyHoldMs = 200));
  const an = createAnalyzer(ex, cfg);
  const statuses = new Set<string>();
  let started = false;
  for (const f of frames) {
    const ev: AnalyzerEvent[] = an.push(f, f.tMs);
    for (const e of ev) if (e.type === 'status') statuses.add(e.status);
    if (!started && ev.some((e) => e.type === 'ready' && e.ready)) {
      an.startCounting(f.tMs);
      started = true;
    }
    if (ev.some((e) => e.type === 'finish')) break;
  }
  if (!started) return { reps: 0, holdSec: 0, statuses };
  const sum = an.finish(frames.at(-1)?.tMs ?? 0);
  return { reps: sum.totalReps, holdSec: sum.holdMs / 1000, statuses };
}

function passes(e: Entry, r: ReturnType<typeof replay>): boolean {
  const okReps = r.reps >= e.expect[0] && r.reps <= e.expect[1];
  const okHold = !e.hold || (r.holdSec >= e.hold[0] - 0.5 && r.holdSec <= e.hold[1] + 0.5);
  const okStatus = !e.status || r.statuses.has(e.status);
  return okReps && okHold && okStatus;
}

describe.skipIf(!manifest.length)('корпус реальных роликов', () => {
  for (const e of manifest) {
    const name = e.file.replace(/\.mp4$/, '');
    const known = KNOWN[name];
    const title = `${e.exercise} ${name}: ${e.hold ? `${e.hold.join('–')} с` : `${e.expect.join('–')} повт.`}${known ? ' (известный провал)' : ''}`;
    it(title, () => {
      const r = replay(e.exercise, loadRecording(new URL(`frames/${name}.frames.json.gz`, dir)));
      const ok = passes(e, r);
      const got = `${r.reps} повт., ${r.holdSec.toFixed(1)} с, статусы ${[...r.statuses].join(',')}`;
      // известный провал, который вдруг прошёл, — повод убрать его из списка
      if (known) expect(ok, `ролик прошёл: уберите его из KNOWN (${got})`).toBe(false);
      else expect(ok, `${e.note}; получилось ${got}`).toBe(true);
    });
  }
});
