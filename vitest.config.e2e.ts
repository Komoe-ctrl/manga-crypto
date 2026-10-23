import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    // Les tests n'ouvrent jamais de connexion Redis : la surveillance BullMQ est désactivée.
    env: { RISK_MONITOR_ENABLED: 'false' },
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Les parcours enchaÃ®nent plusieurs hachages argon2 (volontairement lents) pendant que les fichiers tournent en parallÃ¨le.
    testTimeout: 20_000,
  },
});
