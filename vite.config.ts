import { defineConfig, type Plugin } from 'vite';

// В собранной версии страница загружает и отправляет что-либо только на свой сайт: по умолчанию запрещено всё,
// разрешены свои скрипты, стили, картинки, видео с камеры и сборка WebAssembly. Так кадры и данные никуда не уходят,
// а сторонние библиотеки не могут ни прислать метрики, ни подгрузить чужой код (даже через картинку или фрейм).
export const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const csp: Plugin = {
  name: 'povtor-csp',
  apply: 'build',
  transformIndexHtml(html) {
    return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
  },
};

export default defineConfig({
  base: './',
  plugins: [csp],
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  server: { host: '127.0.0.1', port: 5173 },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
