import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(({mode}) => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: {
        ignored: ['**/server/**'],
      },
      proxy: {
        '/api': 'http://localhost:3001',
        '/outputs': 'http://localhost:3001',
        '/originals': 'http://localhost:3001',
        '/upscaled': 'http://localhost:3001',
        '/annotations': 'http://localhost:3001',
      },
    },
  };
});
