import type { App } from '../app';
import { CATALOG, exerciseName, formatDuration } from '../catalog';
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
  const errs = Object.entries(summary.errorsCount) as [ErrorCode, number][];
  const errList = () =>
    errs.length
      ? h(
          'ul',
          { class: 'errlist' },
          ...errs
            .sort((a, b) => b[1] - a[1])
            .map(([code, n]) => h('li', null, h('span', null, app.config.errors.find((e) => e.code === code)?.screen ?? code), h('b', null, String(n)))),
        )
      : h('p', { class: 'good' }, 'Ошибок в технике не заметили. Так держать.');
  if (summary.kind === 'hold') {
    body =
      summary.holdMs < 1000
        ? h('section', { class: 'empty' }, h('p', { class: 'big-text' }, 'Удержания не было'), h('p', null, 'Проверь, что камера видит тебя сбоку целиком, и прими позу после отсчёта.'))
        : h(
            'section',
            { class: 'result' },
            h(
              'div',
              { class: 'numbers' },
              h('div', { class: 'num' }, h('b', { id: 'sum-total' }, formatDuration(summary.holdMs)), h('span', null, 'в позе')),
              h('div', { class: 'num' }, h('b', { id: 'sum-clean' }, formatDuration(summary.cleanHoldMs)), h('span', null, 'без ошибок')),
            ),
            errList(),
          );
  } else if (summary.totalReps === 0) {
    body = h(
      'section',
      { class: 'empty' },
      h('p', { class: 'big-text' }, 'Повторений не было'),
      h('p', null, `Проверь, что камера видит тебя ${CATALOG[summary.exercise].view === 'side' ? 'сбоку' : 'спереди'} целиком и что между повторениями ты возвращаешься в исходное положение.`),
    );
  } else {
    body = h(
      'section',
      { class: 'result' },
      h(
        'div',
        { class: 'numbers' },
        h('div', { class: 'num' }, h('b', { id: 'sum-total' }, String(summary.totalReps)), h('span', null, plural(summary.totalReps, 'повторение', 'повторения', 'повторений'))),
        h('div', { class: 'num' }, h('b', { id: 'sum-clean' }, String(summary.cleanReps)), h('span', null, plural(summary.cleanReps, 'чистое', 'чистых', 'чистых'))),
      ),
      errList(),
    );
  }
  const reasonText =
    summary.finishReason === 'away'
      ? 'Подход закончился сам: тебя не было видно 8 секунд или ты вышел из позы.'
      : summary.finishReason === 'idle'
        ? 'Подход закончился сам: целую минуту не было движения.'
        : summary.finishReason === 'maxDuration'
          ? 'Подход закончился сам: прошло 10 минут.'
          : null;
  const view = h(
    'main',
    { class: 'screen summary' },
    saveError ? h('p', { class: 'warnline', role: 'alert' }, 'Результат не сохранён. ' + saveError) : null,
    h('header', null, h('h1', null, exerciseName(summary.exercise)), h('p', { class: 'muted' }, humanDate(record.startedAt))),
    body,
    reasonText ? h('p', { class: 'muted small', id: 'finish-reason' }, reasonText) : null,
    h(
      'div',
      { class: 'btns column' },
      h('button', { class: 'btn primary', id: 'again', onclick: again }, summary.totalReps === 0 && summary.holdMs < 1000 ? 'Ещё раз' : 'Ещё подход'),
      h('button', { class: 'btn', onclick: () => app.navigate('/history') }, 'История'),
      h('button', { class: 'btn ghost', onclick: () => app.navigate('/') }, 'На главную'),
    ),
  );
  root.append(view);
  return () => view.remove();
}
