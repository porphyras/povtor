import type { App } from '../app';
import type { Exercise } from '../types';
import { h, svg } from './dom';

export const SQUAT_ICON = `<svg viewBox="0 0 64 64" width="44" height="44" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><circle cx="33" cy="9" r="6"/><path d="M31 16 L24 34 L42 36 L40 56 M29 22 L48 22 M36 56 L46 56"/></svg>`;
export const PUSHUP_ICON = `<svg viewBox="0 0 64 64" width="44" height="44" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="30" r="6"/><path d="M18 34 L56 44 M22 35 L20 50 M56 44 L58 50"/></svg>`;

export function renderHome(root: HTMLElement, app: App): () => void {
  const start = (ex: Exercise) => {
    app.voice.unlock(); // жест пользователя: разрешаем голос на iOS
    app.exercise = ex;
    app.settings.lastExercise = ex;
    app.persistSettings();
    app.navigate('/session/' + ex);
  };
  const voiceToggle = h('input', {
    type: 'checkbox',
    class: 'switch',
    checked: app.settings.voiceEnabled,
    'aria-label': 'Голосовые подсказки',
    onchange: (e: Event) => {
      app.settings.voiceEnabled = (e.target as HTMLInputElement).checked;
      app.voice.enabled = app.settings.voiceEnabled;
      app.persistSettings();
    },
  });
  const modelSelect = h(
    'select',
    {
      onchange: (e: Event) => {
        app.settings.modelVariant = (e.target as HTMLSelectElement).value as 'auto' | 'lite' | 'full';
        app.persistSettings();
      },
    },
    h('option', { value: 'auto', selected: app.settings.modelVariant === 'auto' }, 'Автоматически'),
    h('option', { value: 'lite', selected: app.settings.modelVariant === 'lite' }, 'Облегчённая: быстрее, но подсказки менее точные'),
    h('option', { value: 'full', selected: app.settings.modelVariant === 'full' }, 'Точная'),
  );
  const inApp = /Telegram|VKAndroidApp|VKClient|vkclient|Instagram|FBAN|FBAV|; wv\)/i.test(navigator.userAgent);
  const view = h(
    'main',
    { class: 'screen home' },
    inApp
      ? h('p', { class: 'warnline', role: 'alert' }, 'Похоже, ссылка открыта внутри мессенджера. Камера здесь может не работать: откройте «Повтор» в Chrome, Яндекс Браузере или Safari (меню мессенджера → «Открыть в браузере»).')
      : null,
    h('header', { class: 'home-head' }, h('h1', null, 'Повтор'), h('p', { class: 'lead' }, 'Что делаем сегодня?')),
    h(
      'div',
      { class: 'choices' },
      h('button', { class: 'choice', id: 'start-squat', onclick: () => start('squat') }, svg(SQUAT_ICON), h('span', null, 'Приседания')),
      h('button', { class: 'choice', id: 'start-pushup', onclick: () => start('pushup') }, svg(PUSHUP_ICON), h('span', null, 'Отжимания')),
    ),
    h(
      'section',
      { class: 'how' },
      h('h2', null, 'Как поставить телефон'),
      h(
        'ol',
        null,
        h('li', null, 'Положите телефон боком к себе на стул или пол, в 2–3 метрах.'),
        h('li', null, 'Для приседаний держите телефон вертикально, для отжиманий горизонтально.'),
        h('li', null, 'Камера должна видеть вас целиком, с головы до ног.'),
      ),
    ),
    h('label', { class: 'row' }, h('span', null, 'Голосовые подсказки'), voiceToggle),
    h('details', { class: 'settings' }, h('summary', null, 'Настройки'), h('label', { class: 'field' }, h('span', null, 'Модель распознавания'), modelSelect)),
    h('nav', { class: 'links' }, h('a', { href: '#/history', class: 'link' }, 'История')),
    h('p', { class: 'note' }, 'Видео не записывается и не отправляется в интернет: всё обрабатывается на вашем устройстве. «Повтор» не ставит диагнозов и не заменяет врача или тренера, подсказки касаются только формы движения.'),
  );
  root.append(view);
  return () => view.remove();
}
