import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: 'dist',
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        popup: 'src/popup/index.html',
        background: 'src/bg/index.ts',
        content: 'src/content/index.ts',
        'page-fetch': 'src/content/page-fetch.js',
      },
      output: {
        /**
         * 页面脚本必须落在 manifest.web_accessible_resources 声明的那个路径上
         * （content/page-fetch.js）：content script 用
         * chrome.runtime.getURL('content/page-fetch.js') 注入，路径对不上就 404。
         *
         * 其余 entry 保持 Vite 默认的 assets/[name]-[hash].js。
         */
        entryFileNames: (chunk) =>
          chunk.name === 'page-fetch' ? 'content/page-fetch.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
