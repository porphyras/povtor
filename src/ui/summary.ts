import type { App } from '../app';
import { EXERCISE_NAME } from '../history';
import type { ErrorCode } from '../types';
import { h } from './dom';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export function humanDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Склонение: 1 повторение, 2 повторения, 5 повторений. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export function renderSummary(root: HTMLElement, app: App): () => void {
  const last = app.last;
  if (!last) {
    app.navigate('/');
    return () => undefined;
  }
  const { summary, record, saveError } = last;
  const again = () => {
    app.voice.unlock();
    app.navigate('/session/' + summary.exercise);
  };
  let body: HTMLElement;
  if (summary.totalReps === 0) {
    body = h(
      'section',
      { class: 'empty' },
      h('p', { class: 'big-text' }, 'Повторений не было'),
      h('p', null, summary.exercise === 'squat' ? 'Проверь, что камера видит тебя сбоку целиком и что ты встаёшь в полный рост между повторениями.' : 'Проверь, что камера видит тебя сбоку целиком и что руки выпрямляются между повторениями.'),
    );
  } else {
    const errs = Object.entries(summary.errorsCount) as [ErrorCode, number][];
    body = h(
      'section',
      { class: 'result' },
      h(
        'div',
        { class: 'numbers' },
        h('div', { class: 'num' }, h('b', { id: 'sum-total' }, String(summary.totalReps)), h('span', null, plural(summary.totalReps, 'повторение', 'повторения', 'повторений'))),
        h('div', { class: 'num' }, h('b', { id: 'sum-clean' }, String(summary.cleanReps)), h('span', null, plural(summary.cleanReps, 'чистое', 'чистых', 'чистых'))),
      ),
      errs.length
        ? h(
            'ul',
            { class: 'errlist' },
            ...errs
              .sort((a, b) => b[1] - a[1])
              .map(([code, n]) => h('li', null, h('span', null, app.config.errors.find((e) => e.code === code)?.screen ?? code), h('b', null, String(n)))),
          )
        : h('p', { class: 'good' }, 'Ошибок в технике не заметили. Так держать.'),
    );
  }
  const view = h(
    'main',
    { class: 'screen summary' },
    saveError ? h('p', { class: 'warnline', role: 'alert' }, 'Результат не сохранён. ' + saveError) : null,
    h('header', null, h('h1', null, EXERCISE_NAME[summary.exercise]), h('p', { class: 'muted' }, humanDate(record.startedAt))),
    body,
    h(
      'div',
      { class: 'btns column' },
      h('button', { class: 'btn primary', id: 'again', onclick: again }, summary.totalReps === 0 ? 'Ещё раз' : 'Ещё подход'),
      h('button', { class: 'btn', onclick: () => app.navigate('/history') }, 'История'),
      h('button', { class: 'btn ghost', onclick: () => app.navigate('/') }, 'На главную'),
    ),
  );
  root.append(view);
  return () => view.remove();
}
