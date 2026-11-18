import type { AppError, AppErrorCode } from './types';

const TABLE: Record<AppErrorCode, Omit<AppError, 'code'>> = {
  INSECURE_CONTEXT: { message: 'Откройте приложение по ссылке, которая начинается с https://', recoverable: false, action: 'none' },
  CAMERA_DENIED: { message: 'Нет доступа к камере. Разрешите его в настройках браузера и нажмите «Повторить»', recoverable: true, action: 'open_settings' },
  CAMERA_NOT_FOUND: { message: 'Камера не найдена. Подключите камеру или откройте приложение на телефоне', recoverable: true, action: 'retry' },
  CAMERA_BUSY: { message: 'Камера занята другим приложением. Закройте его и нажмите «Повторить»', recoverable: true, action: 'retry' },
  MODEL_LOAD: { message: 'Не получилось загрузить модель. Проверьте интернет и нажмите «Повторить»', recoverable: true, action: 'retry' },
  FILE_FORMAT: { message: 'Нужен файл MP4 или WebM не длиннее 2 минут', recoverable: true, action: 'retry' },
  LIMIT: { message: 'Нужен файл MP4 или WebM не длиннее 2 минут', recoverable: true, action: 'retry' },
  STORAGE_UNAVAILABLE: { message: 'История недоступна в этом окне браузера. Тренироваться можно, но результат не сохранится', recoverable: false, action: 'none' },
  STORAGE_FULL: { message: 'Не хватает места для истории. Выгрузите её в CSV и очистите', recoverable: false, action: 'none' },
  VALIDATION: { message: 'Не удалось сохранить подход', recoverable: false, action: 'none' },
  CONFIG: { message: 'Ошибка настроек приложения', recoverable: true, action: 'reload' },
};

export class PovtorError extends Error {
  readonly info: AppError;
  constructor(code: AppErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.info = { code, ...TABLE[code] };
  }
}

export function appError(e: unknown, fallback: AppErrorCode): AppError {
  if (e instanceof PovtorError) return e.info;
  return { code: fallback, ...TABLE[fallback] };
}
