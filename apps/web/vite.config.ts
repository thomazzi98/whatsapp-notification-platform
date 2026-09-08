import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_ORIGIN = process.env.VITE_API_ORIGIN ?? 'http://127.0.0.1:3100';

/**
 * The dashboard is served from the same origin as the API in every
 * environment, which is why there is no API base URL to configure and no CORS
 * layer anywhere: the session cookie stays first-party, `SameSite=Lax` does its
 * job, and the build has no idea where it will be deployed.
 *
 * In development that sameness is provided by this proxy; in production by the
 * static file server in front of both.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/dashboard': { target: API_ORIGIN, changeOrigin: false },
      '/v1': { target: API_ORIGIN, changeOrigin: false },
      '/ready': { target: API_ORIGIN, changeOrigin: false },
    },
  },
  build: {
    // Source maps ship: this is a self-hosted product, the bundle holds no
    // secrets, and a stack trace an operator can read is worth more than the
    // obscurity of one they cannot.
    sourcemap: true,
  },
});
