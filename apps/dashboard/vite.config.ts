import react from '@vitejs/plugin-react';

/**
 * Vite, with the React plugin.
 *
 * An earlier pass of this file said the plugin was unavailable because the box could not reach
 * the registry from Node. That was wrong: the probes were run with `--offline` against the local
 * store and nobody checked whether an install actually worked. It does, so Fast Refresh works and
 * `pnpm dev` keeps component state while a screen is being edited.
 */
export default {
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
};
