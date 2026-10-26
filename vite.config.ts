import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./client/index.html', import.meta.url)),
        callback: fileURLToPath(new URL('./client/auth/callback.html', import.meta.url)),
      },
    },
  },
  server: { port: 5174, strictPort: true, proxy: { '/api': 'http://localhost:8081' } },
  test: {
    root: '.',
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'client/src/**/*.test.ts'],
    environment: 'node',
  },
});
