import { PovtorError } from './errors';

export interface CameraOptions {
  facingMode: 'user' | 'environment';
  width: number;
  height: number;
  fps: number;
}

/** Запрашивает камеру. Бросает PovtorError с кодом из таблицы ошибок архитектуры. */
export async function startCamera(opts: CameraOptions): Promise<MediaStream> {
  if (!window.isSecureContext) throw new PovtorError('INSECURE_CONTEXT');
  if (!navigator.mediaDevices?.getUserMedia) throw new PovtorError('CAMERA_NOT_FOUND', 'нет mediaDevices');
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: opts.facingMode,
        width: { ideal: opts.width },
        height: { ideal: opts.height },
        frameRate: { ideal: opts.fps, max: opts.fps },
      },
    });
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new PovtorError('CAMERA_DENIED', name);
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new PovtorError('CAMERA_NOT_FOUND', name);
    if (name === 'NotReadableError' || name === 'AbortError') throw new PovtorError('CAMERA_BUSY', name);
    throw new PovtorError('CAMERA_NOT_FOUND', String(e));
  }
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Подключает поток к элементу video и ждёт первого кадра. */
export async function attachStream(video: HTMLVideoElement, stream: MediaStream): Promise<void> {
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  if (video.readyState < 2) {
    await new Promise<void>((resolve) => video.addEventListener('loadeddata', () => resolve(), { once: true }));
  }
}

/** Режим проверки: источник кадров — видеофайл по ссылке или выбранный пользователем. */
export async function attachVideoFile(video: HTMLVideoElement, src: string, maxSec = 120): Promise<void> {
  video.srcObject = null;
  video.src = src;
  video.muted = true;
  video.playsInline = true;
  video.loop = false;
  await new Promise<void>((resolve, reject) => {
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(new PovtorError('FILE_FORMAT', 'video error')), { once: true });
  });
  if (!Number.isFinite(video.duration) || video.duration > maxSec) throw new PovtorError('LIMIT', `duration ${video.duration}`);
}
