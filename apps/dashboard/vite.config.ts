/**
 * Vite, with no React plugin.
 *
 * `@vitejs/plugin-react` is not in this machine's pnpm store and the box cannot reach the
 * registry from Node, so the app is transformed by Vite 8's own pipeline (oxc), which
 * handles `.tsx` with the automatic JSX runtime out of the box. What is lost is Fast
 * Refresh; what is gained is one dependency that does not need to be trusted.
 */
export default {
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
  esbuild: { jsx: 'automatic' },
};
