import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Configuration Prisma 7 : l'URL de la base est lue ici (plus dans schema.prisma).
 * Le client est généré dans src/generated/prisma (ignoré par git).
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
