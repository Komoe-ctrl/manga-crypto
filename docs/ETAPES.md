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
- **`prettier --check` signale des fichiers déjà formatés** : fins de ligne CRLF écrites par Git au `pull` sous Windows. Sans conséquence (le dépôt contient du LF) ; `npx prettier --write <fichier>` les remet en LF.
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

## Étape 4 — Gestion des risques et contrôle du robot

**Livré** : `src/risk/` (`risk-rules.ts`, `RiskSettingsService`, `TradingControlService`, contrôleur, DTO). Pas de migration : les colonnes existaient depuis l'étape 1.

| Route | Effet |
|---|---|
| `GET /api/risk/settings` | Réglages : `maxExposurePct`, `maxDailyLossPct`, `defaultStopLossPct`, `defaultTakeProfitPct` (défaut 5 / 3 / 3 / 6) |
| `PATCH /api/risk/settings` | Modifie les champs fournis (bornes : D26) ; audité avec ancien et nouveau chiffre |
| `GET /api/risk/status` | `{ tradingMode, killSwitchActive, botPausedUntil, canTrade, blockedReason, … }` |
| `POST /api/risk/kill-switch/activate` | Arrête le robot (idempotent) |
| `POST /api/risk/kill-switch/deactivate` | Le relance |
| `POST /api/risk/mode/live` | Passage en LIVE : `{ "password": "…", "confirmation": "PASSER EN LIVE" }` ; 403 mauvais mot de passe, 422 prérequis manquant ; 5/min |
| `POST /api/risk/mode/paper` | Retour en simulation, toujours immédiat |

**Prérequis du LIVE** : kill switch désactivé et une configuration d'échange `ACTIVE`, non testnet, vérifiée (D28).

**Journal d'audit** : `risk.settings_updated`, `kill_switch.activated`, `kill_switch.deactivated`, `mode.live_enabled`, `mode.live_denied` (`reason`), `mode.paper_enabled`.

**Utiliser les règles dans le module d'ordres** (à venir)
```ts
const status = await tradingControl.status(userId);
if (!status.canTrade) return; // KILL_SWITCH ou PAUSED_DAILY_LOSS

if (exceedsExposure(orderValue, totalCapital, settings.maxExposurePct)) reject();
const { stopLoss, takeProfit } = stopLossTakeProfit('BUY', entryPrice, settings.defaultStopLossPct, settings.defaultTakeProfitPct);
```

**Pas encore fait** : pause automatique sur perte journalière (D30), contrôle d'éligibilité LIVE à chaque ordre (D28).

## Étape 5 — Portefeuille et valorisation

**Livré** : `src/portfolio/` (`portfolio-math.ts`, `PortfolioService`, `PortfolioValuationService`, `PriceProvider`, contrôleur, DTO). Pas de migration. Aucune dépendance ajoutée.

| Route | Effet |
|---|---|
| `GET /api/portfolio` | Positions valorisées en USD : prix courant, valeur, P&L, poids, totaux, `complete` |
| `POST /api/portfolio/transactions` | Achat ou vente déclaré ; renvoie la position après transaction et le gain réalisé (vente) ; 422 si vente > quantité détenue |
| `PUT /api/portfolio/assets/:symbol` | Définit une position (import, correction) |
| `DELETE /api/portfolio/assets/:symbol` | Supprime une position ; 404 si absente |

Quantités et prix : **chaînes décimales** strictement positives (`"0.015"`), jamais des nombres JSON (D34). Les symboles sont normalisés en majuscules (`btc` → `BTC`), 2 à 12 caractères alphanumériques.

```json
POST /api/portfolio/transactions
{ "symbol": "BTC", "side": "BUY", "quantity": "0.5", "price": "60000" }
→ 200 { "holding": { "symbol": "BTC", "quantity": "0.5", "avgBuyPrice": "60000" }, "realizedPnl": null }

GET /api/portfolio
→ { "currency": "USD", "totalValue": "35000", "totalPnl": "5000", "totalPnlPct": "16.67", "complete": true,
    "assets": [{ "symbol": "BTC", "currentPrice": "70000", "value": "35000", "pnlPct": "16.67", "weightPct": "100", … }] }
```

**Erreurs à connaître** : `409` « modifiée en parallèle, réessayez » (écriture simultanée, D35) ; `complete: false` avec des valeurs `null` (prix indisponibles, D37).

**Journal d'audit** : `portfolio.transaction_recorded` (symbole, sens, quantité, prix, gain réalisé), `portfolio.asset_set` (ancienne et nouvelle valeur), `portfolio.asset_removed`.

**Remplacer la source de prix** : implémenter `PriceProvider.getPrices(symbols)` (renvoyer `Map<symbole, Decimal | null>`, lever `PriceUnavailableError` si la source est injoignable) et changer le `useClass` dans `PortfolioModule`.

**Pour la pause sur perte journalière** : `PortfolioValuationService.totalValue(userId)` renvoie la valeur totale, ou `null` si une position n'a pas pu être valorisée (D38).

**Pas encore fait** : valeur d'ouverture du jour et pause automatique (nécessitent instantanés d'équité et planificateur), historique des transactions, synchronisation avec les soldes de la plateforme, cache Redis des prix.
