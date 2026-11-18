// Копирует файлы WebAssembly MediaPipe из node_modules в public/wasm,
// чтобы версия библиотеки и wasm всегда совпадали.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const dst = join(root, 'public', 'wasm');
mkdirSync(dst, { recursive: true });
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']) {
  const from = join(src, f);
  if (!existsSync(from)) throw new Error('Нет файла ' + from);
  cpSync(from, join(dst, f));
}
console.log('wasm скопирован в public/wasm');
