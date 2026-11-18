// Каталог упражнений для интерфейса: названия, группы, значки, подсказки по расстановке.
import type { Exercise } from './types';

export type Group = 'legs' | 'arms' | 'core';

export interface ExerciseInfo {
  id: Exercise;
  name: string;
  group: Group;
  kind: 'reps' | 'hold';
  view: 'side' | 'front';
  phone: 'вертикально' | 'горизонтально';
  /** Что сделать на экране подготовки. */
  setup: string;
  /** Подсказка, если приложение не может найти исходное положение. */
  still: string;
  /** Что сказать, если положение неверное: на подготовке и во время подхода. */
  wrongPrepare: string;
  wrongCounting: string;
  icon: string;
  silhouette: keyof typeof SILHOUETTES;
}

export const GROUPS: { id: Group; name: string }[] = [
  { id: 'legs', name: 'Ноги' },
  { id: 'arms', name: 'Руки и плечи' },
  { id: 'core', name: 'Пресс и корпус' },
];

const svg = (body: string) =>
  `<svg viewBox="0 0 64 64" width="44" height="44" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const FLOOR = '<path d="M4 58 L60 58" stroke-width="2.5" opacity="0.5"/>';

export const ICONS: Record<Exercise, string> = {
  squat: svg('<circle cx="33" cy="9" r="6"/><path d="M31 16 L24 34 L42 36 L40 56 M29 22 L48 22 M36 56 L46 56"/>'),
  lunge: svg('<circle cx="30" cy="8" r="6"/><path d="M30 15 L30 33 M30 33 L44 39 L44 56 M30 33 L22 47 L10 52 M30 20 L30 30"/>'),
  bridge: svg(`${FLOOR}<circle cx="9" cy="50" r="5"/><path d="M15 52 L33 38 L46 30 L52 52"/>`),
  wallsit: svg('<path d="M12 4 L12 60" stroke-width="3" opacity="0.5"/><circle cx="21" cy="10" r="6"/><path d="M19 17 L19 36 L40 36 L40 56 M19 22 L34 28"/>'),
  pushup: svg('<circle cx="12" cy="30" r="6"/><path d="M18 34 L56 44 M22 35 L20 50 M56 44 L58 50"/>'),
  curl: svg('<circle cx="30" cy="8" r="6"/><path d="M30 15 L30 36 L26 56 M30 36 L34 56 M30 18 L30 30 L41 22"/><path d="M38 18 L44 26" stroke-width="5"/>'),
  press: svg('<circle cx="32" cy="14" r="6"/><path d="M32 21 L32 40 L26 58 M32 40 L38 58 M24 23 L40 23 M24 23 L19 13 L21 3 M40 23 L45 13 L43 3"/>'),
  raise: svg('<circle cx="32" cy="12" r="6"/><path d="M32 19 L32 40 L26 58 M32 40 L38 58 M24 22 L40 22 M24 22 L6 24 M40 22 L58 24"/>'),
  crunch: svg(`${FLOOR}<circle cx="14" cy="30" r="5"/><path d="M19 34 L34 52 L46 38 L54 52"/>`),
  plank: svg(`${FLOOR}<circle cx="10" cy="32" r="5"/><path d="M16 36 L58 46 M17 37 L17 52 L26 52"/>`),
};

/** Пунктирные контуры для экрана подготовки. */
export const SILHOUETTES = {
  standSide: { wide: false, svg: `<svg viewBox="0 0 100 200" class="silhouette" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="7 6" stroke-linecap="round"><circle cx="52" cy="22" r="12"/><path d="M52 34 L50 100 M50 52 L64 84 M50 100 L48 146 L50 190 M50 100 L54 146 L52 190"/></g></svg>` },
  standFront: { wide: false, svg: `<svg viewBox="0 0 100 200" class="silhouette" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="7 6" stroke-linecap="round"><circle cx="50" cy="22" r="12"/><path d="M50 34 L50 100 M32 42 L68 42 M32 42 L26 100 M68 42 L74 100 M50 100 L38 190 M50 100 L62 190"/></g></svg>` },
  plank: { wide: true, svg: `<svg viewBox="0 0 200 100" class="silhouette wide" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="7 6" stroke-linecap="round"><circle cx="30" cy="40" r="11"/><path d="M42 46 L178 70 M48 47 L46 82 M178 70 L184 82"/></g></svg>` },
  lying: { wide: true, svg: `<svg viewBox="0 0 200 100" class="silhouette wide" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="7 6" stroke-linecap="round"><circle cx="24" cy="76" r="11"/><path d="M36 80 L110 80 L140 48 L160 82"/></g></svg>` },
} as const;

const SIDE_WRONG = 'Встань боком к камере';
const LIE_WRONG = 'Ляг на спину боком к камере';
const PLANK_WRONG = 'Прими упор лёжа боком к камере';

export const CATALOG: Record<Exercise, ExerciseInfo> = {
  squat: {
    id: 'squat', name: 'Приседания', group: 'legs', kind: 'reps', view: 'side', phone: 'вертикально',
    setup: 'Встань боком к камере, чтобы было видно с головы до ног',
    still: 'Выпрямись и замри на секунду', wrongPrepare: SIDE_WRONG, wrongCounting: SIDE_WRONG,
    icon: ICONS.squat, silhouette: 'standSide',
  },
  lunge: {
    id: 'lunge', name: 'Выпады', group: 'legs', kind: 'reps', view: 'side', phone: 'вертикально',
    setup: 'Встань боком к камере. Шагай вперёд и опускайся, пока заднее колено почти не коснётся пола',
    still: 'Встань прямо и замри на секунду', wrongPrepare: SIDE_WRONG, wrongCounting: SIDE_WRONG,
    icon: ICONS.lunge, silhouette: 'standSide',
  },
  bridge: {
    id: 'bridge', name: 'Ягодичный мост', group: 'legs', kind: 'reps', view: 'side', phone: 'горизонтально',
    setup: 'Ляг на спину боком к камере: колени согнуты, стопы на полу',
    still: 'Опусти таз на пол и замри на секунду', wrongPrepare: LIE_WRONG, wrongCounting: LIE_WRONG,
    icon: ICONS.bridge, silhouette: 'lying',
  },
  wallsit: {
    id: 'wallsit', name: '«Стульчик» у стены', group: 'legs', kind: 'hold', view: 'side', phone: 'вертикально',
    setup: 'Встань спиной к стене, боком к камере. После отсчёта опустись, будто садишься на стул',
    still: 'Опустись, будто садишься на стул', wrongPrepare: SIDE_WRONG, wrongCounting: 'Встань боком, спиной к стене',
    icon: ICONS.wallsit, silhouette: 'standSide',
  },
  pushup: {
    id: 'pushup', name: 'Отжимания', group: 'arms', kind: 'reps', view: 'side', phone: 'горизонтально',
    setup: 'Встань боком к камере, чтобы было видно с головы до ног. После отсчёта прими упор лёжа',
    still: 'Выпрями руки в упоре и замри на секунду', wrongPrepare: SIDE_WRONG, wrongCounting: PLANK_WRONG,
    icon: ICONS.pushup, silhouette: 'plank',
  },
  curl: {
    id: 'curl', name: 'Сгибания рук с гантелями', group: 'arms', kind: 'reps', view: 'side', phone: 'вертикально',
    setup: 'Встань боком к камере, гантели в опущенных руках. Считается рука, ближняя к камере',
    still: 'Опусти руки и замри на секунду', wrongPrepare: SIDE_WRONG, wrongCounting: SIDE_WRONG,
    icon: ICONS.curl, silhouette: 'standSide',
  },
  press: {
    id: 'press', name: 'Жим над головой', group: 'arms', kind: 'reps', view: 'front', phone: 'вертикально',
    setup: 'Встань лицом к камере, гантели у плеч. Отойди так, чтобы руки над головой тоже были в кадре',
    still: 'Опусти гантели к плечам и замри', wrongPrepare: 'Встань лицом к камере', wrongCounting: 'Встань лицом к камере',
    icon: ICONS.press, silhouette: 'standFront',
  },
  raise: {
    id: 'raise', name: 'Разведение рук в стороны', group: 'arms', kind: 'reps', view: 'front', phone: 'вертикально',
    setup: 'Встань лицом к камере, руки вдоль тела',
    still: 'Опусти руки вдоль тела и замри', wrongPrepare: 'Встань лицом к камере', wrongCounting: 'Встань лицом к камере',
    icon: ICONS.raise, silhouette: 'standFront',
  },
  crunch: {
    id: 'crunch', name: 'Скручивания', group: 'core', kind: 'reps', view: 'side', phone: 'горизонтально',
    setup: 'Ляг на спину боком к камере, колени согнуты',
    still: 'Опусти плечи на пол и замри на секунду', wrongPrepare: LIE_WRONG, wrongCounting: LIE_WRONG,
    icon: ICONS.crunch, silhouette: 'lying',
  },
  plank: {
    id: 'plank', name: 'Планка', group: 'core', kind: 'hold', view: 'side', phone: 'горизонтально',
    setup: 'Встань боком к камере. После отсчёта прими планку на локтях или на прямых руках',
    still: 'Прими планку', wrongPrepare: SIDE_WRONG, wrongCounting: PLANK_WRONG,
    icon: ICONS.plank, silhouette: 'plank',
  },
};

export const EXERCISES = Object.values(CATALOG);
export const exerciseName = (ex: Exercise) => CATALOG[ex]?.name ?? ex;
export const isExercise = (s: string): s is Exercise => s in CATALOG;

/** 65 000 мс → «1:05». */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
