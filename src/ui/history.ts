import type { App } from '../app';
import { dailyStats, EXERCISE_NAME } from '../history';
import { clearHistory, exportCsv, listSets } from '../storage';
import { appError } from '../errors';
import type { SetRecord } from '../types';
import { clear, h, svg } from './dom';
import { humanDate } from './summary';

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/** Столбики за последние 7 дней: высота — все повторения, тёмная часть — чистые. */
function chart(sets: SetRecord[]): SVGElement {
  const days = dailyStats(sets, 7);
  const max = Math.max(10, ...days.map((d) => d.total));
  const W = 320;
  const H = 150;
  const bw = 28;
  const gap = (W - 7 * bw) / 8;
  const bars = days
    .map((d, i) => {
      const x = gap + i * (bw + gap);
      const th = (d.total / max) * (H - 40);
      const ch = (d.clean / max) * (H - 40);
      const wd = WEEKDAYS[new Date(d.date + 'T12:00:00').getDay()];
      return `<rect x="${x}" y="${H - 22 - th}" width="${bw}" height="${th}" rx="4" fill="var(--bar-light)"/>
        <rect x="${x}" y="${H - 22 - ch}" width="${bw}" height="${ch}" rx="4" fill="var(--accent)"/>
        ${d.total ? `<text x="${x + bw / 2}" y="${H - 27 - th}" text-anchor="middle" class="chart-num">${d.total}</text>` : ''}
        <text x="${x + bw / 2}" y="${H - 5}" text-anchor="middle" class="chart-day">${wd}</text>`;
    })
    .join('');
  return svg(`<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Повторения за неделю"><line x1="0" x2="${W}" y1="${H - 22}" y2="${H - 22}" stroke="var(--line)"/>${bars}</svg>`);
}

export function renderHistory(root: HTMLElement, app: App): () => void {
  const content = h('div', { class: 'history-body' }, h('p', { class: 'muted' }, 'Загружаем…'));
  const view = h(
    'main',
    { class: 'screen history' },
    h('header', { class: 'with-back' }, h('button', { class: 'icon-btn', 'aria-label': 'Назад', onclick: () => app.navigate('/') }, '←'), h('h1', null, 'История')),
    content,
  );
  root.append(view);

  async function load() {
    let sets: SetRecord[];
    try {
      sets = await listSets();
    } catch (e) {
      clear(content);
      content.append(h('p', { class: 'warnline' }, appError(e, 'STORAGE_UNAVAILABLE').message));
      return;
    }
    clear(content);
    if (sets.length === 0) {
      content.append(
        h('section', { class: 'empty' }, h('p', { class: 'big-text' }, 'Здесь появятся твои подходы'), h('button', { class: 'btn primary', onclick: () => app.navigate('/') }, 'Начать тренировку')),
      );
      return;
    }
    content.append(
      h('figure', { class: 'chart-box' }, chart(sets), h('figcaption', { class: 'muted' }, 'Повторений за неделю, тёмным — чистые')),
      h(
        'ul',
        { class: 'setlist' },
        ...sets.map((s) =>
          h('li', null, h('span', { class: 'when' }, humanDate(s.startedAt)), h('span', { class: 'what' }, EXERCISE_NAME[s.exercise]), h('b', { class: 'count' }, `${s.totalReps} / ${s.cleanReps}`)),
        ),
      ),
      h('p', { class: 'muted small' }, 'Число слева — все повторения, справа — чистые.'),
      h(
        'div',
        { class: 'btns column' },
        h(
          'button',
          {
            class: 'btn primary',
            id: 'export',
            onclick: async () => {
              try {
                const blob = await exportCsv(app.config);
                const a = h('a', { href: URL.createObjectURL(blob), download: `povtor-${new Date().toISOString().slice(0, 10)}.csv` });
                document.body.append(a);
                a.click();
                setTimeout(() => {
                  URL.revokeObjectURL(a.href);
                  a.remove();
                }, 1000);
              } catch (e) {
                alert(appError(e, 'STORAGE_UNAVAILABLE').message);
              }
            },
          },
          'Выгрузить CSV',
        ),
        h(
          'button',
          {
            class: 'btn ghost danger',
            onclick: async () => {
              if (!confirm('Удалить всю историю? Это действие нельзя отменить.')) return;
              await clearHistory().catch(() => undefined);
              void load();
            },
          },
          'Очистить историю',
        ),
      ),
    );
  }
  void load();
  return () => view.remove();
}
