import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { AppConfig } from './config';
import { PovtorError } from './errors';
import type { PoseFrame } from './types';

export type ModelVariant = 'lite' | 'full';
export type Delegate = 'GPU' | 'CPU';

export interface PoseEngine {
  variant: ModelVariant;
  delegate: Delegate;
  /** Детекция на текущем кадре. null — человека нет (или кадр пропущен из-за сбоя). */
  detect(source: HTMLVideoElement): PoseFrame | null;
  close(): void;
}

export function isMobile(): boolean {
  return matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function pickVariant(config: AppConfig, setting: 'auto' | ModelVariant): ModelVariant {
  if (setting !== 'auto') return setting;
  return isMobile() ? config.model.mobile : config.model.desktop;
}

/** Размеры файлов моделей без сжатия: хостинг может отдавать их в gzip, и content-length тогда меньше. */
const MODEL_BYTES: Record<ModelVariant, number> = { lite: 5777746, full: 9398198 };

/** Один проход загрузки: если данных нет дольше stallMs, загрузка прерывается. */
async function fetchOnce(url: string, expected: number, stallMs: number, onProgress?: (share: number) => void): Promise<Uint8Array> {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), stallMs);
  const poke = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), stallMs);
  };
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`model HTTP ${res.status}`);
    const encoded = !!res.headers.get('content-encoding');
    const total = encoded ? expected : Number(res.headers.get('content-length')) || expected;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      poke();
      chunks.push(value);
      got += value.length;
      if (total) onProgress?.(Math.min(1, got / total));
    }
    const buf = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.length;
    }
    onProgress?.(1);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/** Скачивает файл модели с прогрессом. Зависшая загрузка (бывает на мобильной сети) перезапускается до трёх раз. */
async function fetchModel(url: string, expected: number, onProgress?: (share: number) => void, onRetry?: (attempt: number) => void): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) onRetry?.(attempt);
      return await fetchOnce(url, expected, 15000, onProgress);
    } catch (e) {
      lastErr = e;
      console.warn(`загрузка модели, попытка ${attempt}`, e);
    }
  }
  throw lastErr;
}

let filesetPromise: ReturnType<typeof FilesetResolver.forVisionTasks> | null = null;

export async function initPose(
  config: AppConfig,
  variant: ModelVariant,
  onStage?: (stage: 'wasm' | 'model' | 'retry' | 'init' | 'warmup', share?: number) => void,
  forceDelegate?: Delegate,
): Promise<PoseEngine> {
  try {
    onStage?.('wasm');
    filesetPromise ??= FilesetResolver.forVisionTasks(new URL('./wasm', document.baseURI).href);
    const fileset = await filesetPromise;
    onStage?.('model', 0);
    const model = await fetchModel(new URL(`./models/pose_landmarker_${variant}.task`, document.baseURI).href, MODEL_BYTES[variant], (s) => onStage?.('model', s), (n) => onStage?.('retry', n));
    onStage?.('init');
    const make = (delegate: Delegate) =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: model, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: config.model.minDetection,
        minPosePresenceConfidence: config.model.minPresence,
        minTrackingConfidence: config.model.minTracking,
        outputSegmentationMasks: false,
      });

    let delegate: Delegate = forceDelegate ?? 'GPU';
    let landmarker: PoseLandmarker;
    try {
      landmarker = await make(delegate);
    } catch (gpuErr) {
      if (delegate === 'CPU') throw gpuErr;
      console.warn('GPU-делегат недоступен, переключаемся на CPU', gpuErr);
      delegate = 'CPU';
      landmarker = await make('CPU');
    }

    // Метки времени для модели: строго растут за всё время жизни landmarker.
    // Одна метка «назад» ломает граф MediaPipe насовсем, поэтому считаем их здесь, а не берём время видео.
    let lastTs = 0;
    const nextTs = () => {
      const now = Math.round(performance.now() * 1000) / 1000;
      lastTs = now > lastTs ? now : lastTs + 1;
      return lastTs;
    };

    // Прогрев: первый кадр на GPU может идти несколько секунд — пусть это случится на экране загрузки.
    // Если GPU падает уже на прогреве, сразу переходим на CPU.
    onStage?.('warmup');
    const warm = document.createElement('canvas');
    warm.width = 256;
    warm.height = 256;
    const wctx = warm.getContext('2d');
    if (wctx) {
      wctx.fillStyle = '#808080';
      wctx.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 2; i++) {
        try {
          landmarker.detectForVideo(warm, nextTs());
        } catch (e) {
          console.warn('прогрев', e);
          if (delegate === 'GPU') {
            try {
              landmarker.close();
            } catch {
              /* уже закрыт */
            }
            delegate = 'CPU';
            landmarker = await make('CPU');
          } else break;
        }
      }
    }

    let broken = false;
    let rebuilding = false;
    const rebuild = () => {
      if (rebuilding) return;
      rebuilding = true;
      try {
        landmarker.close();
      } catch {
        /* уже закрыт */
      }
      // сбой на GPU — дальше работаем на CPU, иначе можно бесконечно пересоздавать сломанный делегат
      if (delegate === 'GPU') {
        delegate = 'CPU';
        engine.delegate = 'CPU';
      }
      make(delegate)
        .then((l) => {
          landmarker = l;
          broken = false;
        })
        .catch((e) => console.error('не удалось пересоздать модель', e))
        .finally(() => (rebuilding = false));
    };

    const engine: PoseEngine = {
      variant,
      delegate,
      detect(source) {
        const w = source.videoWidth;
        const h = source.videoHeight;
        if (!w || !h || broken) return null;
        try {
          const res = landmarker.detectForVideo(source, nextTs());
          const lms = res.landmarks[0];
          if (!lms || lms.length < 33) return null;
          const world = res.worldLandmarks[0];
          return {
            tMs: 0,
            width: w,
            height: h,
            landmarks: lms.map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? 0 })),
            world: world?.map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? 0 })),
          };
        } catch (e) {
          console.error('detect: сбой графа, пересоздаём модель', e);
          broken = true;
          rebuild();
          return null;
        }
      },
      close() {
        landmarker.close();
      },
    };
    return engine;
  } catch (e) {
    if (e instanceof PovtorError) throw e;
    console.error(e);
    throw new PovtorError('MODEL_LOAD', String(e));
  }
}
