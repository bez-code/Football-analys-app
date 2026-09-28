import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// This file is ESM (the package sets "type": "module"), so __dirname is absent.
const root = dirname(fileURLToPath(import.meta.url));
const contracts = resolve(root, '../../packages/contracts/src/index.ts');
const r = (...p: string[]): string => resolve(root, ...p);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: { input: { index: r('src/main/index.ts') } },
    },
    resolve: { alias: { '@tactix/contracts': contracts } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: { input: { index: r('src/preload/index.ts') } },
    },
    resolve: { alias: { '@tactix/contracts': contracts } },
  },
  renderer: {
    root: r('src/renderer'),
    build: {
      outDir: r('out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: { index: r('src/renderer/index.html') } },
    },
    resolve: {
      alias: {
        '@renderer': r('src/renderer/src'),
        '@tactix/contracts': contracts,
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
