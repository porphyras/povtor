import rawConfig from './config.json';
import type { ErrorCode, Exercise } from './types';

/** Пороги упражнения на повторения. Углы «естественные»: для direction=up повторение идёт вверх по углу. */
export interface RepConfig {
  direction: 'down' | 'up';
  top: number; // исходное положение: угол не ниже (down) или не выше (up)
  start: number; // начало повторения
  attempt: number; // повторение засчитано, если крайний угол прошёл этот порог
  topHoldMs: number;
  minRepMs: number;
  topMargin?: number; // свои отступы калибровки, если амплитуда упражнения маленькая
  startMargin?: number;
  [rule: string]: number | string | undefined;
}

export interface HoldConfig {
  badHoldMs: number;
  [rule: string]: number | undefined;
}

export interface ErrorType {
  code: ErrorCode;
  exercise: Exercise;
  screen: string;
  voice: string;
  priority: number;
}

export interface AppConfig {
  version: string;
  camera: { width: number; height: number; fps: number };
  model: { desktop: 'lite' | 'full'; mobile: 'lite' | 'full'; minDetection: number; minPresence: number; minTracking: number };
  visibility: { min: number; lostAfterMs: number };
  smoothing: { tauMs: number; gapResetMs: number };
  calibration: { topMargin: number; startMargin: number };
  position: { maxSideRatio: number; minFrontRatio: number; maxTorsoTilt: number; maxBodyTilt: number; maxLyingTilt: number };
  prepare: { readyHoldMs: number; countdownSec: number };
  exercises: Record<Exercise, RepConfig | HoldConfig>;
  feedback: { minTipIntervalMs: number; tipVisibleMs: number; holdVoiceEverySec: number };
  set: { idleStopMs: number; awayStopMs: number; waitHintMs: number; maxDurationMs: number; maxReps: number };
  errors: ErrorType[];
}

export const REP_EXERCISES: Exercise[] = ['squat', 'lunge', 'bridge', 'pushup', 'curl', 'press', 'raise', 'crunch'];
export const HOLD_EXERCISES: Exercise[] = ['wallsit', 'plank'];

const ERROR_CODES: ErrorCode[] = [
  'SQUAT_DEPTH', 'SQUAT_LEAN', 'LUNGE_DEPTH', 'LUNGE_LEAN', 'BRIDGE_HEIGHT', 'WALLSIT_HIGH', 'PUSHUP_HIP_SAG', 'PUSHUP_HIP_PIKE',
  'PUSHUP_DEPTH', 'CURL_SWING', 'CURL_ELBOW', 'PRESS_LOCKOUT', 'RAISE_LOW', 'RAISE_HIGH', 'CRUNCH_LOW', 'PLANK_SAG', 'PLANK_PIKE',
];

function num(v: unknown, path: string, min = -Infinity, max = Infinity): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`config.json: поле ${path} должно быть числом от ${min} до ${max}`);
  }
}

/** Проверяет конфигурацию и возвращает её. Бросает Error с понятным текстом при ошибке. */
export function validateConfig(raw: unknown): AppConfig {
  const c = raw as AppConfig;
  if (!c || typeof c !== 'object') throw new Error('config.json: ожидается объект');
  if (typeof c.version !== 'string' || !c.version) throw new Error('config.json: нет version');
  num(c.camera?.width, 'camera.width', 160, 4096);
  num(c.camera?.height, 'camera.height', 120, 4096);
  num(c.camera?.fps, 'camera.fps', 5, 120);
  for (const k of ['desktop', 'mobile'] as const) {
    if (c.model?.[k] !== 'lite' && c.model?.[k] !== 'full') throw new Error(`config.json: model.${k} должно быть lite или full`);
  }
  num(c.model.minDetection, 'model.minDetection', 0, 1);
  num(c.model.minPresence, 'model.minPresence', 0, 1);
  num(c.model.minTracking, 'model.minTracking', 0, 1);
  num(c.visibility?.min, 'visibility.min', 0, 1);
  num(c.visibility?.lostAfterMs, 'visibility.lostAfterMs', 0, 10000);
  num(c.smoothing?.tauMs, 'smoothing.tauMs', 0, 2000);
  num(c.smoothing?.gapResetMs, 'smoothing.gapResetMs', 50, 10000);
  num(c.calibration?.topMargin, 'calibration.topMargin', 0, 60);
  num(c.calibration?.startMargin, 'calibration.startMargin', 0, 90);
  if (!(c.calibration.startMargin > c.calibration.topMargin)) throw new Error('config.json: нужно startMargin > topMargin');
  for (const k of ['maxSideRatio', 'minFrontRatio'] as const) num(c.position?.[k], `position.${k}`, 0, 2);
  for (const k of ['maxTorsoTilt', 'maxBodyTilt', 'maxLyingTilt'] as const) num(c.position?.[k], `position.${k}`, 0, 90);
  num(c.prepare?.readyHoldMs, 'prepare.readyHoldMs', 0, 10000);
  num(c.prepare?.countdownSec, 'prepare.countdownSec', 0, 10);
  if (!c.exercises || typeof c.exercises !== 'object') throw new Error('config.json: нет exercises');
  for (const ex of REP_EXERCISES) {
    const e = c.exercises[ex] as RepConfig;
    if (!e) throw new Error(`config.json: нет настроек упражнения ${ex}`);
    if (e.direction !== 'down' && e.direction !== 'up') throw new Error(`config.json: ${ex}.direction должно быть down или up`);
    for (const k of ['top', 'start', 'attempt'] as const) num(e[k], `${ex}.${k}`, 0, 180);
    num(e.topHoldMs, `${ex}.topHoldMs`, 0, 5000);
    num(e.minRepMs, `${ex}.minRepMs`, 0, 5000);
    const ordered = e.direction === 'down' ? e.attempt < e.start && e.start < e.top : e.attempt > e.start && e.start > e.top;
    if (!ordered) throw new Error(`config.json: для ${ex} пороги идут не по порядку (${e.direction === 'down' ? 'attempt < start < top' : 'attempt > start > top'})`);
    if (e.topMargin !== undefined || e.startMargin !== undefined) {
      num(e.topMargin, `${ex}.topMargin`, 0, 60);
      num(e.startMargin, `${ex}.startMargin`, 0, 90);
      if (!((e.startMargin as number) > (e.topMargin as number))) throw new Error(`config.json: для ${ex} нужно startMargin > topMargin`);
    }
  }
  for (const ex of HOLD_EXERCISES) {
    const e = c.exercises[ex] as HoldConfig;
    if (!e) throw new Error(`config.json: нет настроек упражнения ${ex}`);
    num(e.badHoldMs, `${ex}.badHoldMs`, 0, 5000);
  }
  const need: [Exercise, string][] = [
    ['squat', 'maxThighAngle'], ['squat', 'maxLean'], ['lunge', 'maxDepthAngle'], ['lunge', 'maxLean'], ['bridge', 'minPeak'],
    ['wallsit', 'maxKnee'], ['wallsit', 'cleanMaxKnee'], ['pushup', 'clean'], ['pushup', 'minBodyLine'], ['pushup', 'bodyLineHoldMs'],
    ['curl', 'maxSwing'], ['curl', 'maxElbowDrift'], ['press', 'minLockout'], ['raise', 'minPeak'], ['raise', 'maxPeak'],
    ['crunch', 'minPeak'], ['plank', 'maxBodyTilt'], ['plank', 'minBodyLine'],
  ];
  for (const [ex, k] of need) num((c.exercises[ex] as Record<string, unknown>)[k], `${ex}.${k}`, 0, 5000);
  num(c.feedback?.minTipIntervalMs, 'feedback.minTipIntervalMs', 0, 60000);
  num(c.feedback?.tipVisibleMs, 'feedback.tipVisibleMs', 0, 60000);
  num(c.feedback?.holdVoiceEverySec, 'feedback.holdVoiceEverySec', 1, 600);
  num(c.set?.idleStopMs, 'set.idleStopMs', 1000, 3600000);
  num(c.set.awayStopMs, 'set.awayStopMs', 1000, 3600000);
  num(c.set.waitHintMs, 'set.waitHintMs', 500, 60000);
  num(c.set?.maxDurationMs, 'set.maxDurationMs', 1000, 3600000);
  num(c.set?.maxReps, 'set.maxReps', 1, 10000);
  if (!Array.isArray(c.errors)) throw new Error('config.json: errors должен быть массивом');
  for (const code of ERROR_CODES) {
    const e = c.errors.find((x) => x.code === code);
    if (!e) throw new Error(`config.json: нет описания ошибки ${code}`);
    if (typeof e.screen !== 'string' || typeof e.voice !== 'string') throw new Error(`config.json: у ${code} нет текстов`);
    num(e.priority, `errors.${code}.priority`, 1, 100);
  }
  return c;
}

/** Конфигурация встраивается в сборку: код и пороги всегда одной версии, лишнего запроса нет. */
export function loadConfig(): AppConfig {
  return validateConfig(structuredClone(rawConfig));
}

export function errorType(config: AppConfig, code: ErrorCode): ErrorType {
  const e = config.errors.find((x) => x.code === code);
  if (!e) throw new Error('Неизвестный код ошибки ' + code);
  return e;
}

export const repConfig = (config: AppConfig, ex: Exercise) => config.exercises[ex] as RepConfig;
export const holdConfig = (config: AppConfig, ex: Exercise) => config.exercises[ex] as HoldConfig;
