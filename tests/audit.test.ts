// Проверки по итогам аудита: экранирование CSV, отбор записей из базы, параметры режима проверки, каталог.
import { describe, expect, it } from 'vitest';
import { isExercise, exerciseName } from '../src/catalog';
import { readDevParams } from '../src/devparams';
import { csvCell, isSaneSet, toCsv, validateSet } from '../src/history';
import type { SetRecord } from '../src/types';
import { loadTestConfig } from './synth';

const cfg = loadTestConfig();
const set = (over: Partial<SetRecord> = {}): SetRecord => ({
  id: 'abcdef12-0000-4000-8000-000000000000',
  exercise: 'squat',
  startedAt: '2026-11-18T10:00:00.000Z',
  endedAt: '2026-11-18T10:01:00.000Z',
  totalReps: 0,
  cleanReps: 0,
  side: 'left',
  source: 'camera',
  configVersion: cfg.version,
  ...over,
});

describe('CSV', () => {
  it('текст, похожий на формулу, выгружается с апострофом', () => {
    expect(csvCell('=cmd|x')).toBe("'=cmd|x");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });
  it('числа и обычный текст не меняются', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('Приседания')).toBe('Приседания');
    expect(csvCell('a;b')).toBe('"a;b"');
  });
  it('файл начинается с BOM и разделён «;»', () => {
    const csv = toCsv([set({ totalReps: 1, cleanReps: 1 })], new Map(), cfg);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.split('\r\n')[0].split(';')[0]).toBe('﻿Дата');
  });
});

describe('записи из базы', () => {
  it('нормальная запись проходит', () => {
    expect(isSaneSet(set({ totalReps: 3, cleanReps: 2 }))).toBe(true);
    expect(isSaneSet(set({ exercise: 'plank', holdMs: 65000, cleanHoldMs: 52000 }))).toBe(true);
  });
  it('разметка вместо числа, чужое упражнение, мусор — отбрасываются', () => {
    expect(isSaneSet(set({ totalReps: '<svg onload=alert(1)>' as unknown as number }))).toBe(false);
    expect(isSaneSet(set({ exercise: 'constructor' as never }))).toBe(false);
    expect(isSaneSet(set({ startedAt: 'вчера' }))).toBe(false);
    expect(isSaneSet(set({ holdMs: Infinity }))).toBe(false);
    expect(isSaneSet(null)).toBe(false);
    expect(isSaneSet('строка')).toBe(false);
  });
  it('удержание ровно 10 минут сохраняется', () => {
    const s = set({ exercise: 'plank', holdMs: cfg.set.maxDurationMs, cleanHoldMs: cfg.set.maxDurationMs });
    expect(validateSet(s, [], cfg)).toEqual([]);
  });
});

describe('каталог', () => {
  it('свойства прототипа не считаются упражнениями', () => {
    for (const k of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) expect(isExercise(k)).toBe(false);
    expect(isExercise('squat')).toBe(true);
    expect(isExercise(5)).toBe(false);
    expect(exerciseName('toString' as never)).toBe('toString');
  });
});

describe('параметры режима проверки', () => {
  it('на боевом сайте без ?dev не действуют', () => {
    const d = readDevParams('?countdown=100000&ready=1e12&video=/x.mp4&step=15', false);
    expect(d).toEqual({ dev: false, video: null, step: 0, record: false, countdown: null, readyMs: null, delegate: null, model: null });
  });
  it('с ?dev действуют, но в разумных пределах', () => {
    const d = readDevParams('?dev&countdown=100000&ready=1e12&step=15&delegate=CPU', false);
    expect(d.dev).toBe(true);
    expect(d.countdown).toBeNull();
    expect(d.readyMs).toBeNull();
    expect(d.step).toBe(15);
    expect(d.delegate).toBe('CPU');
    expect(readDevParams('?dev&countdown=3&ready=600&step=0', false)).toMatchObject({ countdown: 3, readyMs: 600, step: 0 });
  });
  it('на локальном сервере разработки действуют без ?dev', () => {
    expect(readDevParams('?step=15&video=/a.mp4', true)).toMatchObject({ step: 15, video: '/a.mp4', dev: false });
  });
});
