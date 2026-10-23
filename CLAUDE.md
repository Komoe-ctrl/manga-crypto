# crypto-api — Backend NestJS

Projet « Veille » : suivi et trading crypto automatisé pour un client qui ne surveille pas les marchés.
**Source de vérité : `docs/SPEC.md`.** La lire avant toute tâche structurante.

## Rôle de ce dépôt
- Auth, portefeuille, gestion des risques, notifications (Mode Nuit, digest 08:00), WebSocket vers le front.
- SEUL service qui déchiffre les clés API d'échange et passe les ordres (ccxt Node + BullMQ).
- Consomme les signaux du moteur Python via le Redis Stream `signals`.
- Expose une spec OpenAPI (`/docs-json`) dont crypto-web génère ses types.

Dépôts voisins : `../crypto-web` (Next.js), `../crypto-engine` (Python).

## Stack
NestJS 12 (ESM : imports relatifs avec suffixe `.js`), TypeScript 6.0 strict, Prisma 7 + PostgreSQL 18, Redis 8, Vitest, oxlint, Prettier.
Prisma 7 : URL de la base dans `prisma.config.ts`, client généré dans `src/generated/prisma` (import depuis ce dossier, pas depuis `@prisma/client`), connexion via `@prisma/adapter-pg`.

## Commandes
- `npm run db:up` — démarre PostgreSQL et Redis (Docker)
- `npm run prisma:migrate` — crée/applique une migration
- `npm run prisma:generate` — régénère le client
- `npm run start:dev` — API sur http://localhost:3001 (préfixe `/api`, Swagger sur `/docs`)
- `npm run typecheck` · `npm test` · `npm run lint`

## Règles non négociables
- Montants et quantités : `Decimal`, jamais `Float`.
- Clés API : AES-256-GCM (IV unique, authTag, `keyVersion`), jamais en clair, jamais loguées, jamais renvoyées.
- Refuser toute clé ayant le droit « Withdrawal ».
- Mode `PAPER` par défaut ; passage `LIVE` explicite et audité.
- Chaque ordre a un `clientOrderId` idempotent.
- Ne pas ajouter de dépendance hors stack sans la proposer d'abord.
- Commits et PR : aucune mention d'attribution (« Generated with Claude », Co-Authored-By).

## Façon de travailler
Avancer étape par étape. Avant de coder une étape, résumer les choix d'architecture et les points à valider en 10 lignes maximum.
- Une branche `feat/etape-N-…` par étape et une PR vers `main` ; jamais de commit direct sur `main`.
- Documenter chaque étape : décisions dans `docs/DECISIONS.md` (le pourquoi), livraison et mode d'emploi dans `docs/ETAPES.md` (le quoi et le comment). Mettre ces fichiers à jour dans la même PR que le code.
- `npm run typecheck`, `npm test`, `npm run test:e2e` et `npm run lint` doivent passer avant d'ouvrir la PR.
