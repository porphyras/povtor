import type { App } from '../app';
import { EXERCISES, GROUPS } from '../catalog';
import type { Exercise } from '../types';
import { h, svg } from './dom';

export function renderHome(root: HTMLElement, app: App): () => void {
  const start = (ex: Exercise) => {
    app.voice.unlock(); // жест пользователя: разрешаем голос на iOS
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
    h('option', { value: 'lite', selected: app.settings.modelVariant === 'lite' }, 'Облегчённая (быстрее, но менее точная)'),
    h('option', { value: 'full', selected: app.settings.modelVariant === 'full' }, 'Точная'),
  );
  const inApp = /Telegram|VKAndroidApp|VKClient|vkclient|Instagram|FBAN|FBAV|; wv\)/i.test(navigator.userAgent);

  const card = (ex: (typeof EXERCISES)[number]) =>
    h(
      'button',
      { class: 'choice', id: 'start-' + ex.id, onclick: () => start(ex.id) },
      svg(ex.icon),
      h('span', { class: 'choice-text' }, h('span', { class: 'choice-name' }, ex.name), h('small', null, `${ex.view === 'side' ? 'боком' : 'лицом'} к камере${ex.kind === 'hold' ? ', на время' : ''}`)),
    );

  const view = h(
    'main',
    { class: 'screen home' },
    inApp
      ? h('p', { class: 'warnline', role: 'alert' }, 'Похоже, ссылка открыта внутри мессенджера. Камера здесь может не работать: открой «Повтор» в Chrome, Яндекс Браузере или Safari (меню мессенджера → «Открыть в браузере»).')
      : null,
    h(
      'header',
      { class: 'home-head' },
      h('div', { class: 'home-title' }, h('h1', null, 'Повтор'), h('a', { href: '#/history', class: 'link head-link', id: 'history-link' }, 'История')),
      h('p', { class: 'lead' }, 'Что делаем сегодня?'),
    ),
    ...GROUPS.map((g) =>
      h('section', { class: 'group' }, h('h2', null, g.name), h('div', { class: 'choices' }, ...EXERCISES.filter((e) => e.group === g.id).map(card))),
    ),
    h(
      'div',
      { class: 'home-foot' },
      h(
        'section',
        { class: 'how' },
        h('h2', null, 'Как поставить камеру'),
        h(
          'ol',
          null,
          h('li', null, 'Поставь телефон или ноутбук экраном к себе в 2–3 метрах: на стул, стол или пол.'),
          h('li', null, 'Встань к нему боком или лицом — как подписано у упражнения. Перед стартом приложение подскажет, что делать.'),
          h('li', null, 'Камера должна видеть тебя целиком, с головы до ног.'),
        ),
      ),
      h(
        'div',
        { class: 'home-side' },
        h('label', { class: 'row' }, h('span', null, 'Голосовые подсказки'), voiceToggle),
        h('details', { class: 'settings' }, h('summary', null, 'Настройки'), h('label', { class: 'field' }, h('span', null, 'Модель распознавания'), modelSelect)),
        h('p', { class: 'note' }, 'Видео не записывается и не отправляется в интернет: всё обрабатывается на твоём устройстве. «Повтор» не ставит диагнозов и не заменяет врача или тренера, подсказки касаются только формы движения.'),
      ),
    ),
  );
  root.append(view);
  return () => view.remove();
}
