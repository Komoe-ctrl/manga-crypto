# Journal des étapes

Ce qui a été livré à chaque étape, comment le lancer et le tester. Le **pourquoi** des choix est dans [`DECISIONS.md`](DECISIONS.md) (références `D1`…).

Méthode de travail : une branche `feat/etape-N-…` par étape, une PR vers `main`, jamais de commit direct sur `main`.

## Mise en route locale

```bash
npm ci
cp .env.example .env        # puis renseigner les secrets (voir ci-dessous)
npm run db:up               # PostgreSQL + Redis (Docker)
npm run prisma:generate
npm run prisma:migrate
npm run start:dev           # http://localhost:3001/api — Swagger : /docs
```

### Variables d'environnement

| Variable | Rôle | Génération |
|---|---|---|
| `DATABASE_URL` | Connexion PostgreSQL | — |
| `POSTGRES_PORT` | Port publié par Docker (défaut 5432) | À changer si PostgreSQL tourne déjà en local |
| `ENCRYPTION_KEY_V1` | Clé maître AES-256 (32 octets, base64) | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `ENCRYPTION_ACTIVE_KEY_VERSION` | Version qui chiffre | `1` |
| `JWT_ACCESS_SECRET` | Signature des access tokens (≥ 32 caractères) | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `JWT_ACCESS_TTL_SECONDS` | Durée de l'access token | `900` |
| `REFRESH_TOKEN_TTL_DAYS` | Durée du refresh token | `7` |
| `AUTH_REGISTRATION_ENABLED` | `false` ferme l'inscription | — |

Le `.env` n'est jamais commité. **Ne jamais perdre `ENCRYPTION_KEY_V*`** : sans elle, les clés d'échange stockées sont irrécupérables.

### Commandes de vérification

```bash
npm run typecheck && npm test && npm run test:e2e && npm run lint
```

### Pièges connus

- **Port 5432 déjà pris** (PostgreSQL local sous Windows) : l'authentification échoue avec `P1000`. Définir `POSTGRES_PORT=5442` et adapter `DATABASE_URL`.
- **« La migration a été modifiée après avoir été appliquée »** : fins de ligne CRLF. Corrigé par `.gitattributes` (D16). Si la base de dev a été créée avant, la réinitialiser avec `npx prisma migrate reset` (efface les données de dev).
- **`npx prisma` télécharge Prisma 8 RC** : `node_modules` n'est pas installé. Lancer `npm ci` d'abord (la SPEC impose Prisma 7.10).
- **Avertissement `install-scripts`** après `npm install` : sans conséquence, `argon2` fournit des binaires précompilés.

---

## Étape 1 — Schéma Prisma, `PrismaModule`, `CryptoModule` (PR #1)

**Livré**
- `prisma/schema.prisma` : `User`, `NotificationSettings`, `ExchangeConfig`, `RiskSettings`, `Asset`, `TradeLog`, `AlertConfig`, `DigestReport`, `AuditLog`, avec enums, index et `onDelete` (D1–D6).
- Migration `init_schema` avec le trigger d'immuabilité de `audit_logs` (D4).
- `src/prisma/` : `PrismaModule` global, `PrismaService` (adapter `pg`, D8).
- `src/crypto/` : `CryptoModule` global, `EncryptionService` (D7).

**Utiliser le chiffrement**
```ts
const payload = encryption.encrypt(secret, `exchange-config:${id}:apiSecret`);
// → { ciphertext, iv, authTag, keyVersion } à stocker tels quels
const secret = encryption.decrypt(payload, `exchange-config:${id}:apiSecret`); // même AAD
encryption.needsRotation(payload); // vrai si keyVersion ≠ clé active
```

**Rotation de clé** : ajouter `ENCRYPTION_KEY_V2`, passer `ENCRYPTION_ACTIVE_KEY_VERSION=2`, garder `V1`. Les nouvelles écritures utilisent V2, les anciennes restent lisibles. Supprimer `V1` seulement quand `needsRotation` est faux pour toutes les lignes (la tâche de re-chiffrement reste à écrire).

## Étape 2 — Authentification (PR #2)

**Livré** : `src/auth/` (service, contrôleur, garde, tokens, mots de passe, DTO), `src/audit/` (`AuditService`), migration `add_refresh_tokens`, `@nestjs/throttler`.

| Route | Accès | Effet |
|---|---|---|
| `POST /api/auth/register` | public, 5/min | Crée le compte (mode `PAPER`, réglages par défaut) et ouvre une session |
| `POST /api/auth/login` | public, 5/min | Ouvre une session |
| `POST /api/auth/refresh` | public, 5/min | Cookie `refresh_token` → nouvel access token, rotation du cookie |
| `POST /api/auth/logout` | public | Révoque la famille de refresh tokens, efface le cookie (idempotent) |
| `GET /api/auth/me` | Bearer | Profil de l'utilisateur |

Réponse de session : `{ accessToken, expiresIn, user }` ; le refresh token n'est **que** dans le cookie.

**Protéger une route** : rien à faire (garde globale). **Ouvrir une route** : `@Public()`. **Lire l'utilisateur** : `@CurrentUser() user: AuthUser`.

**Journal d'audit** : `auth.registered`, `auth.login`, `auth.login_failed`, `auth.logout`, `auth.refresh_reuse_detected`.

## Étape 3 — Clés d'échange

**Livré** : `src/exchanges/` (service, contrôleur, DTO, vérificateurs).

| Route | Effet |
|---|---|
| `POST /api/exchanges` | Vérifie les permissions, chiffre, stocke. 422 si droit « Withdrawal », clé invalide ou plateforme sans vérificateur ; 503 si la plateforme est injoignable ; 409 si doublon plateforme + libellé |
| `GET /api/exchanges` | Liste les configurations de l'utilisateur (sans aucune clé) |
| `POST /api/exchanges/:id/verify` | Re-vérifie : `ACTIVE` ou `REJECTED` |
| `POST /api/exchanges/:id/disable` | Passe en `DISABLED` |
| `DELETE /api/exchanges/:id` | Supprime les clés chiffrées ; 409 si des ordres existent |

Exemple :
```json
POST /api/exchanges
{ "exchange": "BINANCE", "label": "Principal", "apiKey": "…", "apiSecret": "…" }
→ 201 { "id": "…", "status": "ACTIVE", "permissions": ["read", "trade"], "apiKeyHint": "a1b2", … }
```

**Créer la clé côté Binance** : droits « Enable Reading » et « Enable Spot & Margin Trading » seulement, **jamais** « Enable Withdrawals ». Restreindre à l'IP du serveur si possible.

**Journal d'audit** : `exchange.key_added`, `exchange.key_rejected` (`reason: withdrawal | invalid_key`), `exchange.verified`, `exchange.rejected`, `exchange.disabled`, `exchange.deleted`.

**Ajouter une plateforme** : écrire un `XxxVerifier implements ExchangeVerifier`, l'ajouter aux `providers` de `ExchangesModule` et à la `Map` de `VerifierRegistry`, avec des tests sur les cas : droit de retrait, clé invalide, plateforme injoignable, réponse incomplète.

**Pas encore fait** : lecture des clés par le module d'ordres (`ExchangesService` ne les expose pas), passage en `LIVE` (devra refuser les configurations `sandbox` ou non vérifiées, D20).
