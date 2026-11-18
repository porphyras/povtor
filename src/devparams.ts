// Параметры режима проверки из адресной строки (покадровый прогон видеофайла, отладочная панель и т. п.).

/** Параметры режима разработчика из адресной строки. */
export interface DevParams {
  dev: boolean; // панель отладки
  video: string | null; // источник — видеофайл по ссылке
  step: number; // >0: покадровый проход файла с этой частотой (детерминированно, для тестов)
  record: boolean; // сохранять точки тела для регрессионных тестов
  countdown: number | null; // переопределить обратный отсчёт
  readyMs: number | null; // переопределить время «вижу целиком» перед стартом
  delegate: 'GPU' | 'CPU' | null; // принудительный делегат (для воспроизводимых замеров — CPU)
  model: 'lite' | 'full' | null; // принудительная модель
}

export const NO_DEV: DevParams = { dev: false, video: null, step: 0, record: false, countdown: null, readyMs: null, delegate: null, model: null };

/** Число из адреса в допустимых пределах, иначе null. */
function bounded(v: string | null, min: number, max: number): number | null {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** Параметры режима проверки работают на локальном сервере разработки или с явным ?dev,
 *  иначе ссылкой с ?countdown=100000 можно было бы «сломать» приложение тому, кто её открыл. */
export function readDevParams(search = location.search, isDevServer = import.meta.env.DEV): DevParams {
  const q = new URLSearchParams(search);
  if (!isDevServer && !q.has('dev')) return { ...NO_DEV };
  return {
    dev: q.has('dev'),
    video: q.get('video'),
    step: bounded(q.get('step'), 1, 60) ?? 0,
    record: q.has('record'),
    countdown: bounded(q.get('countdown'), 0, 10),
    readyMs: bounded(q.get('ready'), 0, 10000),
    delegate: q.get('delegate') === 'CPU' ? 'CPU' : q.get('delegate') === 'GPU' ? 'GPU' : null,
    model: q.get('model') === 'lite' ? 'lite' : q.get('model') === 'full' ? 'full' : null,
  };
}
