import './styles.css';
import { createApp, type App } from './app';
import { isExercise } from './catalog';
import { loadConfig } from './config';
import { loadSettings, saveSettings } from './storage';
import { h } from './ui/dom';
import { renderHistory } from './ui/history';
import { renderHome } from './ui/home';
import { renderSession } from './ui/session';
import { renderSummary } from './ui/summary';

const root = document.getElementById('app') as HTMLElement;
let cleanup: (() => void) | null = null;

function route(app: App) {
  try {
    cleanup?.();
  } catch (e) {
    console.error(e);
  }
  cleanup = null;
  const path = location.hash.replace(/^#/, '') || '/';
  const m = path.match(/^\/session\/([a-z]+)$/);
  try {
    if (m && isExercise(m[1])) cleanup = renderSession(root, app, m[1]);
    else if (path === '/summary') cleanup = renderSummary(root, app);
    else if (path === '/history') cleanup = renderHistory(root, app);
    else cleanup = renderHome(root, app);
  } catch (e) {
    // экран не отрисовался — не оставляем пользователя с белой страницей
    console.error(e);
    root.replaceChildren();
    cleanup = renderHome(root, app);
  }
  window.scrollTo(0, 0);
}

async function boot() {
  try {
    const config = loadConfig();
    const settings = await loadSettings();
    const app = createApp(config, settings, (s) => void saveSettings(s));
    // Браузеры разрешают речь только после жеста пользователя. Если страницу открыли сразу на экране подхода
    // (ссылка, перезагрузка), разблокируем голос первым же касанием или нажатием клавиши.
    const unlock = () => app.voice.unlock();
    window.addEventListener('pointerdown', unlock, { once: true, capture: true });
    window.addEventListener('keydown', unlock, { once: true, capture: true });
    window.addEventListener('hashchange', () => route(app));
    route(app);
  } catch (e) {
    console.error(e);
    root.append(
      h(
        'main',
        { class: 'screen' },
        h('h1', null, 'Повтор'),
        h('p', { class: 'warnline', role: 'alert' }, 'Ошибка настроек приложения. ' + String((e as Error).message ?? e)),
        h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Перезагрузить'),
      ),
    );
  }
}

void boot();
