import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/retro-kick-97/' : '/',
  build: { outDir: 'dist', sourcemap: true },
});