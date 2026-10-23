import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Les parcours enchaînent plusieurs hachages argon2 (volontairement lents) pendant que les fichiers tournent en parallèle.
    testTimeout: 20_000,
  },
});
