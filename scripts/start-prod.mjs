// Démarrage en production (image Docker) : applique les migrations en attente, puis lance l'API.
//
// - `prisma migrate deploy` applique seulement les migrations déjà écrites (jamais `migrate dev`, qui peut proposer de
//   réinitialiser la base). Prisma prend un verrou : deux instances qui démarrent ensemble ne les appliquent pas deux fois.
// - RUN_MIGRATIONS=false saute cette étape (migrations lancées à part, par une commande de pré-déploiement).
// - Si une migration échoue, l'API ne démarre pas : mieux vaut un déploiement raté qu'une API sur un schéma périmé.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.RUN_MIGRATIONS !== 'false') {
  console.log('Migrations : prisma migrate deploy');
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    { cwd: root, stdio: 'inherit', env: process.env },
  );
  if (result.status !== 0) {
    console.error('Migrations en échec : l’API ne démarre pas.');
    process.exit(result.status ?? 1);
  }
}

// Même processus : les signaux (SIGTERM d'un déploiement) arrivent directement à l'API, qui s'arrête proprement.
await import(pathToFileURL(path.join(root, 'dist/main.js')).href);
