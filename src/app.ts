import type { AppConfig } from './config';
import { initPose, pickVariant, type ModelVariant, type PoseEngine } from './pose';
import type { Settings } from './storage';
import type { AnalyzerEvent, Exercise, PoseFrame, SetRecord, SetSummary } from './types';
import { createVoice, type Voice } from './voice';

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

export function readDevParams(search = location.search): DevParams {
  const q = new URLSearchParams(search);
  const step = Number(q.get('step') ?? 0);
  const cd = q.get('countdown');
  const rd = q.get('ready');
  return {
    dev: q.has('dev'),
    video: q.get('video'),
    step: Number.isFinite(step) && step > 0 ? step : 0,
    record: q.has('record'),
    countdown: cd !== null && Number.isFinite(Number(cd)) ? Number(cd) : null,
    readyMs: rd !== null && Number.isFinite(Number(rd)) ? Number(rd) : null,
    delegate: q.get('delegate') === 'CPU' ? 'CPU' : q.get('delegate') === 'GPU' ? 'GPU' : null,
    model: q.get('model') === 'lite' ? 'lite' : q.get('model') === 'full' ? 'full' : null,
  };
}

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
  navigate(path: string): void;
  getEngine(onStage?: Parameters<typeof initPose>[2]): Promise<PoseEngine>;
  persistSettings(): void;
  exercise: Exercise;
}

export function createApp(config: AppConfig, settings: Settings, persist: (s: Settings) => void): App {
  let engine: PoseEngine | null = null;
  let enginePromise: Promise<PoseEngine> | null = null;
  const hook: DebugHook = { events: [], frames: [], summary: null, engine: null, fps: 0, done: false, error: null };
  (window as unknown as { __povtor: DebugHook }).__povtor = hook;
  const app: App = {
    config,
    settings,
    voice: createVoice(settings.voiceEnabled),
    dev: readDevParams(),
    last: null,
    hook,
    exercise: settings.lastExercise,
    navigate(path) {
      if (location.hash !== '#' + path) location.hash = path;
    },
    async getEngine(onStage) {
      const variant = app.dev.model ?? pickVariant(config, settings.modelVariant);
      if (engine && engine.variant === variant) return engine;
      if (engine) {
        engine.close();
        engine = null;
        enginePromise = null;
      }
      enginePromise ??= initPose(config, variant, onStage, app.dev.delegate ?? undefined).then((e) => {
        engine = e;
        hook.engine = { variant: e.variant, delegate: e.delegate };
        return e;
      });
      try {
        return await enginePromise;
      } catch (e) {
        enginePromise = null;
        throw e;
      }
    },
    persistSettings() {
      persist(settings);
    },
  };
  return app;
}
