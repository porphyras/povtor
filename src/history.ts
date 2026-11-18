// Чистые функции для истории: проверка подхода перед сохранением, CSV, статистика по дням.
import { CATALOG, exerciseName, formatDuration } from './catalog';
import type { AppConfig } from './config';
import type { ErrorCode, RepRecord, SetRecord } from './types';

/** Подход на удержание (планка, «стульчик»): вместо повторений — время в позе. */
export const isHoldSet = (s: SetRecord) => CATALOG[s.exercise]?.kind === 'hold';

/** Возвращает список нарушений; пустой список — данные можно сохранять. */
export function validateSet(set: SetRecord, reps: RepRecord[], config: AppConfig): string[] {
  const p: string[] = [];
  if (typeof set.id !== 'string' || set.id.length < 8) p.push('id');
  if (!(set.exercise in CATALOG)) p.push('exercise');
  const st = Date.parse(set.startedAt);
  const en = Date.parse(set.endedAt);
  if (Number.isNaN(st) || Number.isNaN(en) || en < st) p.push('startedAt/endedAt');
  if (isHoldSet(set)) {
    if (set.totalReps !== 0 || set.cleanReps !== 0) p.push('totalReps/cleanReps у удержания');
    if (!(typeof set.holdMs === 'number' && set.holdMs >= 1000 && set.holdMs <= config.set.maxDurationMs)) p.push('holdMs');
    if (!(typeof set.cleanHoldMs === 'number' && set.cleanHoldMs >= 0 && set.cleanHoldMs <= (set.holdMs ?? 0))) p.push('cleanHoldMs');
  } else {
    if (!Number.isInteger(set.totalReps) || set.totalReps < 1 || set.totalReps > config.set.maxReps) p.push('totalReps');
    if (!Number.isInteger(set.cleanReps) || set.cleanReps < 0 || set.cleanReps > set.totalReps) p.push('cleanReps');
  }
  if (set.side !== 'left' && set.side !== 'right') p.push('side');
  if (set.source !== 'camera' && set.source !== 'file') p.push('source');
  if (typeof set.configVersion !== 'string' || !set.configVersion) p.push('configVersion');
  if (reps.length !== set.totalReps) p.push('reps.length != totalReps');
  if (reps.filter((r) => r.errors.length === 0).length !== set.cleanReps) p.push('cleanReps != чистых повторений');
  const allowed = new Set(config.errors.filter((e) => e.exercise === set.exercise).map((e) => e.code));
  reps.forEach((r, i) => {
    if (r.setId !== set.id) p.push(`reps[${i}].setId`);
    if (r.index !== i + 1) p.push(`reps[${i}].index`);
    if (!(r.tStartMs >= 0 && r.tStartMs < r.tEndMs)) p.push(`reps[${i}].tStartMs/tEndMs`);
    if (!(r.minAngle >= 0 && r.minAngle <= 180)) p.push(`reps[${i}].minAngle`);
    if (!Array.isArray(r.errors) || r.errors.some((c) => !allowed.has(c))) p.push(`reps[${i}].errors`);
  });
  return p;
}

export function countErrors(reps: { errors: ErrorCode[] }[]): Partial<Record<ErrorCode, number>> {
  const out: Partial<Record<ErrorCode, number>> = {};
  for (const r of reps) for (const e of r.errors) out[e] = (out[e] ?? 0) + 1;
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const localDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const localTime = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function csvCell(v: string | number): string {
  const s = String(v);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV для Excel: UTF-8 с BOM, разделитель «;». */
export function toCsv(sets: SetRecord[], repsBySet: Map<string, RepRecord[]>, config: AppConfig): string {
  const head = ['Дата', 'Время', 'Упражнение', 'Повторений', 'Чистых', 'В позе, с', 'Без ошибок, с', 'Ошибки', 'Длительность, с', 'Версия настроек'];
  const rows = sets.map((s) => {
    const errs = countErrors(repsBySet.get(s.id) ?? []);
    const errText = Object.entries(errs)
      .map(([code, n]) => `${config.errors.find((e) => e.code === code)?.screen ?? code}: ${n}`)
      .join(', ');
    const dur = Math.round((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 1000);
    const hold = isHoldSet(s);
    const sec = (ms?: number) => (hold && typeof ms === 'number' ? Math.round(ms / 1000) : '');
    return [localDate(s.startedAt), localTime(s.startedAt), exerciseName(s.exercise), hold ? '' : s.totalReps, hold ? '' : s.cleanReps, sec(s.holdMs), sec(s.cleanHoldMs), errText, dur, s.configVersion];
  });
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

export interface DayStat {
  date: string; // YYYY-MM-DD, местное время
  total: number;
  clean: number;
}

/** Сумма повторений по дням за последние days дней (включая сегодня). */
export function dailyStats(sets: SetRecord[], days: number, now = new Date()): DayStat[] {
  const out: DayStat[] = [];
  const index = new Map<string, DayStat>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const stat = { date: key, total: 0, clean: 0 };
    out.push(stat);
    index.set(key, stat);
  }
  for (const s of sets) {
    const stat = index.get(localDate(s.startedAt));
    if (stat) {
      stat.total += s.totalReps;
      stat.clean += s.cleanReps;
    }
  }
  return out;
}

/** Короткая строка результата для списка: «12, чистых 9» или «1:05, без ошибок 0:52». */
export function setResult(s: SetRecord): { main: string; rest: string } {
  if (isHoldSet(s)) return { main: formatDuration(s.holdMs ?? 0), rest: `, без ошибок ${formatDuration(s.cleanHoldMs ?? 0)}` };
  return { main: String(s.totalReps), rest: `, чистых ${s.cleanReps}` };
}
