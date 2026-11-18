import { defineConfig, type Plugin } from 'vite';

// В собранной версии страница может обращаться по сети только к своему сайту:
// так гарантируем, что кадры и данные никуда не уходят (а сторонние библиотеки не шлют метрики).
const csp: Plugin = {
  name: 'povtor-csp',
  apply: 'build',
  transformIndexHtml(html) {
    return html.replace(
      '<meta charset="UTF-8" />',
      `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'" />`,
    );
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
