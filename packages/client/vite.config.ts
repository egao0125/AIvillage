import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => {
  // Guard: VITE_DEV_ADMIN_TOKEN must never reach a production build.
  // If set, Vite would embed the value in the JS bundle — exposing the admin
  // token to anyone who downloads the page. Fail-fast here so CI catches it.
  if (command === 'build' && process.env.VITE_DEV_ADMIN_TOKEN) {
    throw new Error(
      '[Security] VITE_DEV_ADMIN_TOKEN must not be set during production builds ' +
      '— it would be embedded in the JS bundle. Remove it from .env files and build args.'
    );
  }

  return {
    plugins: [react()],
    build: {
      sourcemap: false, // Never expose source maps in production builds
    },
    server: {
      port: 3000,
      proxy: {
        '/api': 'http://localhost:4000',
        '/socket.io': { target: 'http://localhost:4000', ws: true },
      },
    },
  };
});
