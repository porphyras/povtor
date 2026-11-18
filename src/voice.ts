/** Голосовые подсказки через Web Speech API. Если синтеза нет, всё молча работает без голоса. */
export interface Voice {
  enabled: boolean;
  /** Вызывать из обработчика нажатия: iOS разрешает речь только после жеста пользователя. */
  unlock(): void;
  say(text: string): void;
  cancel(): void;
}

const NUMBERS = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять',
  'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать',
  'восемнадцать', 'девятнадцать', 'двадцать'];

/** Число словами до 20, дальше цифрами (синтезатор прочтёт сам). */
export function numberWord(n: number): string {
  return n >= 0 && n < NUMBERS.length ? NUMBERS[n] : String(n);
}

export function createVoice(enabled: boolean): Voice {
  const synth: SpeechSynthesis | undefined = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  let ru: SpeechSynthesisVoice | null = null;
  let anyVoices = false;
  const pickVoice = () => {
    const voices = synth?.getVoices() ?? [];
    anyVoices = voices.length > 0;
    // Только голос, который синтезирует речь на самом устройстве. Сетевые голоса (например, «Google русский»
    // в Chrome на компьютере) отправляют текст подсказок на сервер — браузер делает это в обход политики безопасности страницы.
    ru = voices.find((v) => v.lang?.toLowerCase().startsWith('ru') && v.localService) ?? null;
  };
  if (synth) {
    pickVoice();
    synth.addEventListener?.('voiceschanged', pickVoice);
  }
  const speak = (text: string, volume = 1) => {
    if (!synth) return;
    // список голосов уже пришёл, а русского локального в нём нет — лучше промолчать, чем отдать текст в сеть
    if (!ru && anyVoices) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU';
    if (ru) u.voice = ru;
    u.rate = 1.15;
    u.volume = volume;
    synth.speak(u);
  };
  return {
    enabled,
    unlock() {
      if (!synth) return;
      synth.cancel();
      speak(' ', 0);
    },
    say(text) {
      if (!this.enabled || !synth) return;
      // не копим очередь: если предыдущая фраза ещё звучит, новая её заменяет
      if (synth.speaking || synth.pending) synth.cancel();
      speak(text);
    },
    cancel() {
      synth?.cancel();
    },
  };
}
