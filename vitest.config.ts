import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    // Les tests n'ouvrent jamais de connexion Redis : les jobs de fond BullMQ sont désactivés.
    env: { BACKGROUND_JOBS_ENABLED: 'false' },
    root: './',
    include: ['**/*.spec.ts'],
    // Les tests de services enchaînent des hachages argon2 (volontairement lents) pendant que les fichiers tournent en parallèle.
    testTimeout: 20_000,
  },
});
