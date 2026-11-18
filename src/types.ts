export type Exercise =
  | 'squat'
  | 'lunge'
  | 'bridge'
  | 'wallsit'
  | 'pushup'
  | 'curl'
  | 'press'
  | 'raise'
  | 'crunch'
  | 'plank';
export type ExerciseKind = 'reps' | 'hold';
export type Side = 'left' | 'right';

export type ErrorCode =
  | 'SQUAT_DEPTH'
  | 'SQUAT_LEAN'
  | 'PUSHUP_HIP_SAG'
  | 'PUSHUP_HIP_PIKE'
  | 'PUSHUP_DEPTH'
  | 'LUNGE_DEPTH'
  | 'LUNGE_LEAN'
  | 'BRIDGE_HEIGHT'
  | 'WALLSIT_HIGH'
  | 'CURL_SWING'
  | 'CURL_ELBOW'
  | 'PRESS_LOCKOUT'
  | 'RAISE_LOW'
  | 'RAISE_HIGH'
  | 'CRUNCH_LOW'
  | 'PLANK_SAG'
  | 'PLANK_PIKE';

export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

/** Результат модели для одного кадра. Координаты нормированы: x в долях ширины, y в долях высоты. */
export interface PoseFrame {
  tMs: number;
  width: number;
  height: number;
  landmarks: Landmark[]; // 33 точки
  /** Те же точки в метрах относительно центра таза (worldLandmarks). Есть не всегда. */
  world?: Landmark[];
}

export interface Rep {
  index: number;
  tStartMs: number; // от начала подхода
  tEndMs: number;
  /** Крайний угол повторения: минимум для упражнений «вниз», максимум для упражнений «вверх». */
  minAngle: number;
  errors: ErrorCode[];
}

export type Status = 'OK' | 'NOT_VISIBLE' | 'WRONG_POSITION';
export type MachineState = 'WAITING' | 'TOP' | 'IN_REP' | 'PAUSED';
export type FinishReason = 'user' | 'idle' | 'away' | 'maxDuration' | 'maxReps';

export type AnalyzerEvent =
  | { type: 'status'; status: Status }
  | { type: 'ready'; ready: boolean }
  | { type: 'rep'; rep: Rep }
  | { type: 'tip'; code: ErrorCode }
  | { type: 'hint'; code: 'STAND_STILL' }
  | { type: 'hold'; holding: boolean }
  | { type: 'finish'; reason: FinishReason };

export interface SetSummary {
  exercise: Exercise;
  kind: ExerciseKind;
  side: Side;
  totalReps: number;
  cleanReps: number;
  /** Для удержания: сколько времени человек был в позе и сколько из него — без ошибок. */
  holdMs: number;
  cleanHoldMs: number;
  errorsCount: Partial<Record<ErrorCode, number>>;
  reps: Rep[];
  durationMs: number;
  finishReason: FinishReason;
}

export interface SetRecord {
  id: string;
  exercise: Exercise;
  startedAt: string;
  endedAt: string;
  totalReps: number;
  cleanReps: number;
  /** Только для упражнений на удержание (планка, «стульчик»). */
  holdMs?: number;
  cleanHoldMs?: number;
  side: Side;
  source: 'camera' | 'file';
  configVersion: string;
}

export interface RepRecord extends Rep {
  setId: string;
}

export type AppErrorCode =
  | 'INSECURE_CONTEXT'
  | 'CAMERA_DENIED'
  | 'CAMERA_NOT_FOUND'
  | 'CAMERA_BUSY'
  | 'MODEL_LOAD'
  | 'FILE_FORMAT'
  | 'LIMIT'
  | 'STORAGE_UNAVAILABLE'
  | 'STORAGE_FULL'
  | 'VALIDATION'
  | 'CONFIG';

export interface AppError {
  code: AppErrorCode;
  message: string;
  recoverable: boolean;
  action: 'retry' | 'open_settings' | 'reload' | 'none';
}
