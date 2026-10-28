// Comptes en ligne de commande, pour un produit à clients connus (l'inscription publique est fermée) :
//
//   npm run user:create -- client@example.com [--name "Prénom Nom"] [--timezone Europe/Paris]
//   npm run user:password -- client@example.com
//
// Le mot de passe est saisi à l'invite (masqué, deux fois) : il ne passe JAMAIS en argument de commande, qui resterait
// dans l'historique du shell. Pour un usage sans terminal, la variable VEILLE_PASSWORD le fournit (à éviter sinon).
// Prérequis : l'API est construite (`npm run build`) et `.env` donne DATABASE_URL.
import { existsSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';

if (existsSync('.env')) process.loadEnvFile('.env');

const { PrismaClient } = await import('../dist/generated/prisma/client.js');
const { PasswordService } = await import('../dist/auth/password.service.js');
const { AuditService } = await import('../dist/audit/audit.service.js');
const { createUser, resetPassword, UserAdminError, validatePassword } = await import('../dist/cli/user-admin.js');

const [command, email, ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(
  rest.flatMap((arg, i) => (arg.startsWith('--') ? [[arg.slice(2), rest[i + 1]]] : [])),
);

function usage(message) {
  if (message) console.error(`Erreur : ${message}\n`);
  console.error('Usage :\n  npm run user:create -- <email> [--name "Prénom Nom"] [--timezone Europe/Paris]\n  npm run user:password -- <email>');
  process.exit(2);
}
if (!['create', 'password'].includes(command ?? '')) usage('commande inconnue');
if (!email || email.startsWith('--')) usage("l'adresse e-mail est obligatoire");

/** Saisie masquée au terminal : les caractères ne sont pas affichés. */
function ask(question) {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    const { stdin } = process;
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') return reject(new Error('Annulé.')); // Ctrl+C
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPassword() {
  if (process.env.VEILLE_PASSWORD) return process.env.VEILLE_PASSWORD;
  if (!process.stdin.isTTY) usage('pas de terminal : fournissez le mot de passe par la variable VEILLE_PASSWORD');
  const password = await ask('Mot de passe (12 caractères au moins) : ');
  const problem = validatePassword(password);
  if (problem) usage(problem);
  if (password !== (await ask('Confirmez le mot de passe : '))) usage('les deux saisies diffèrent');
  return password;
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
try {
  const password = await readPassword();
  const passwords = new PasswordService();
  const audit = new AuditService(prisma);
  if (command === 'create') {
    const user = await createUser(prisma, passwords, audit, { email, password, displayName: flags.name, timezone: flags.timezone });
    console.log(`Compte créé : ${user.email} (${user.id}). Mode simulation (PAPER) par défaut.`);
  } else {
    const { revokedSessions } = await resetPassword(prisma, passwords, audit, email, password);
    console.log(`Mot de passe remplacé. ${revokedSessions} session(s) fermée(s) : le client devra se reconnecter.`);
  }
} catch (error) {
  console.error(error instanceof UserAdminError ? `Erreur : ${error.message}` : `Échec inattendu : ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
