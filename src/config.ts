import rawConfig from './config.json';
import type { ErrorCode, Exercise } from './types';

export interface ExerciseConfig {
  signal: 'angle2d' | 'angle3d';
  top: number;
  start: number;
  attempt: number;
  topHoldMs: number;
  minRepMs: number;
}

export interface SquatConfig extends ExerciseConfig {
  maxThighAngle: number;
  maxLean: number;
}

export interface PushupConfig extends ExerciseConfig {
  clean: number;
  minBodyLine: number;
  bodyLineHoldMs: number;
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
  position: { squatMaxTorsoTilt: number; pushupMaxBodyTilt: number; maxShoulderRatio: number };
  prepare: { readyHoldMs: number; countdownSec: number };
  squat: SquatConfig;
  pushup: PushupConfig;
  feedback: { minTipIntervalMs: number; tipVisibleMs: number };
  set: { idleStopMs: number; awayStopMs: number; waitHintMs: number; maxDurationMs: number; maxReps: number };
  errors: ErrorType[];
}

const ERROR_CODES: ErrorCode[] = ['SQUAT_DEPTH', 'SQUAT_LEAN', 'PUSHUP_HIP_SAG', 'PUSHUP_HIP_PIKE', 'PUSHUP_DEPTH'];

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
  num(c.position?.squatMaxTorsoTilt, 'position.squatMaxTorsoTilt', 0, 90);
  num(c.position?.pushupMaxBodyTilt, 'position.pushupMaxBodyTilt', 0, 90);
  num(c.position?.maxShoulderRatio, 'position.maxShoulderRatio', 0, 2);
  num(c.prepare?.readyHoldMs, 'prepare.readyHoldMs', 0, 10000);
  num(c.prepare?.countdownSec, 'prepare.countdownSec', 0, 10);
  for (const ex of ['squat', 'pushup'] as const) {
    const e = c[ex];
    if (e?.signal !== 'angle2d' && e?.signal !== 'angle3d') throw new Error(`config.json: ${ex}.signal должно быть angle2d или angle3d`);
    num(e.top, `${ex}.top`, 0, 180);
    num(e.start, `${ex}.start`, 0, 180);
    num(e.attempt, `${ex}.attempt`, 0, 180);
    num(e.topHoldMs, `${ex}.topHoldMs`, 0, 5000);
    num(e.minRepMs, `${ex}.minRepMs`, 0, 5000);
    if (!(e.attempt < e.start && e.start < e.top)) {
      throw new Error(`config.json: для ${ex} нужно attempt < start < top`);
    }
  }
  num(c.squat.maxThighAngle, 'squat.maxThighAngle', 0, 90);
  num(c.squat.maxLean, 'squat.maxLean', 0, 90);
  num(c.pushup.clean, 'pushup.clean', 0, 180);
  num(c.pushup.minBodyLine, 'pushup.minBodyLine', 0, 180);
  num(c.pushup.bodyLineHoldMs, 'pushup.bodyLineHoldMs', 0, 5000);
  num(c.feedback?.minTipIntervalMs, 'feedback.minTipIntervalMs', 0, 60000);
  num(c.feedback?.tipVisibleMs, 'feedback.tipVisibleMs', 0, 60000);
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
