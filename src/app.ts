import type { AppConfig } from './config';
import { initPose, pickVariant, type ModelVariant, type PoseEngine } from './pose';
import type { Settings } from './storage';
import type { AnalyzerEvent, PoseFrame, SetRecord, SetSummary } from './types';
import { readDevParams, type DevParams } from './devparams';
import { createVoice, type Voice } from './voice';

export type { DevParams };

export interface LastResult {
  summary: SetSummary;
  record: SetRecord;
  saveError: string | null;
}

/** Окно для автотестов и отладки. */
export interface DebugHook {
  events: AnalyzerEvent[];
  frames: PoseFrame[];
  summary: SetSummary | null;
  engine: { variant: ModelVariant; delegate: string } | null;
  fps: number;
  done: boolean;
  error: string | null;
}

export interface App {
  config: AppConfig;
  settings: Settings;
  voice: Voice;
  dev: DevParams;
  last: LastResult | null;
  hook: DebugHook;
  /** replace: заменить текущую запись истории браузера, чтобы системная «назад» не возвращала на экран подхода. */
  navigate(path: string, replace?: boolean): void;
  getEngine(onStage?: Parameters<typeof initPose>[2]): Promise<PoseEngine>;
  persistSettings(): void;
}

export function createApp(config: AppConfig, settings: Settings, persist: (s: Settings) => void): App {
  let engine: PoseEngine | null = null;
  // Загрузка, которая идёт сейчас, и для какой модели. Если пользователь сменил модель во время загрузки,
  // начинаем новую, а результат старой закрываем.
  let pending: { variant: ModelVariant; promise: Promise<PoseEngine> } | null = null;
  // Загрузку модели может начать один экран, а дождаться другой («назад» и снова вход) — прогресс шлём текущему.
  let stageListener: Parameters<typeof initPose>[2] | undefined;
  const hook: DebugHook = { events: [], frames: [], summary: null, engine: null, fps: 0, done: false, error: null };
  const dev = readDevParams();
  // окно для автотестов открываем только в режиме проверки
  if (import.meta.env.DEV || new URLSearchParams(location.search).has('dev')) (window as unknown as { __povtor: DebugHook }).__povtor = hook;
  const app: App = {
    config,
    settings,
    voice: createVoice(settings.voiceEnabled),
    dev,
    last: null,
    hook,
    navigate(path, replace = false) {
      if (location.hash === '#' + path) return;
      if (replace) location.replace('#' + path);
      else location.hash = path;
    },
    async getEngine(onStage) {
      stageListener = onStage;
      const variant = app.dev.model ?? pickVariant(config, settings.modelVariant);
      if (engine?.failed) {
        engine = null;
        hook.engine = null;
      }
      if (engine && engine.variant === variant) return engine;
      if (engine) {
        engine.close();
        engine = null;
      }
      if (!pending || pending.variant !== variant) {
        const promise: Promise<PoseEngine> = initPose(config, variant, (st, sh) => stageListener?.(st, sh), app.dev.delegate ?? undefined).then((e) => {
          if (pending?.promise !== promise) {
            e.close(); // пока грузилось, пользователь выбрал другую модель
            throw new Error('загрузка устарела');
          }
          pending = null;
          engine = e;
          hook.engine = { variant: e.variant, delegate: e.delegate };
          return e;
        });
        pending = { variant, promise };
      }
      const my = pending;
      try {
        return await my.promise;
      } catch (e) {
        if (pending === my) pending = null;
        throw e;
      }
    },
    persistSettings() {
      persist(settings);
    },
  };
  return app;
}
