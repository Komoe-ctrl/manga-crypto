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

## Étape 6 — Pause automatique sur perte journalière

**Livré** : `src/risk/monitor/` (`DailyLossMonitor`, `RiskMonitorProcessor`, `RiskMonitorScheduler`, `RiskMonitorModule`, `RedisConnection`, `local-day.ts`, `daily-loss.ts`), migration `add_equity_snapshots` (table `equity_snapshots`). **Dépendances ajoutées** : `bullmq`, `@nestjs/bullmq`, `ioredis` (D40).

**Fonctionnement** : toutes les 5 minutes, pour chaque utilisateur actif ayant des positions :
1. première observation du jour local → instantané d'ouverture (valeur et positions) ;
2. ensuite, valeur actuelle des **positions d'ouverture** comparée à la valeur d'ouverture ;
3. perte ≥ `maxDailyLossPct` → `User.botPausedUntil` = prochain minuit local, audit `risk.daily_loss_paused`. `GET /api/risk/status` renvoie alors `canTrade: false`, `blockedReason: "PAUSED_DAILY_LOSS"`.

Aucune route nouvelle. La pause se lève seule à minuit local ; il n'y a pas de bouton « reprendre » (D44).

**Prérequis** : Redis démarré (`npm run db:up`), `REDIS_URL` dans `.env`, migration appliquée (`npm run prisma:migrate`, ou `npx prisma migrate deploy`).

**Variable** : `BACKGROUND_JOBS_ENABLED` (`true` par défaut ; elle s'appelait `RISK_MONITOR_ENABLED` avant l'étape 8) ; `false` désactive tous les jobs de fond et n'ouvre aucune connexion Redis. Les tests la posent à `false`.

**Journal d'audit** : `risk.daily_loss_paused` — `metadata` : `localDate`, `openEquity`, `currentValue`, `lossPct`, `maxDailyLossPct`, `pausedUntil`.

**Résultat d'un passage** (`DailyLossOutcome`) : `baseline_created`, `ok`, `paused`, `already_paused`, `no_holdings`, `no_prices`, `skipped`. Un passage global renvoie `{ checked, paused, failed }`.

**Vérifier sur un vrai Redis, sans toucher à la base de dev**
1. Créer une base temporaire (`CREATE DATABASE crypto_smoke`) et y appliquer les migrations : `DATABASE_URL=…/crypto_smoke npx prisma migrate deploy`.
2. Lancer l'application avec `REDIS_URL=redis://localhost:6379/9` (base Redis n° 9) et cette `DATABASE_URL`.
3. Créer un compte et une position, puis ajouter un job à la file `risk-monitor` (ou attendre 5 minutes) : un instantané apparaît dans `equity_snapshots`.
4. Simuler une perte : `update equity_snapshots set equity = 100000` puis relancer un job → `audit_logs` contient `risk.daily_loss_paused` et `/api/risk/status` renvoie `PAUSED_DAILY_LOSS`.
5. Supprimer la base temporaire et vider la base Redis n° 9.

**Pas encore fait** : alerte critique (D46), pertes dues aux ordres du robot (D43), purge des anciens instantanés.

## Étape 7 — Centre de notifications (cœur)

**Livré** : `src/notifications/` (`NotificationService`, `NotificationSettingsService`, `AlertsService`, canaux `TelegramSender` et `UnavailableSender`, `night-mode.ts`, contrôleurs, DTO), migration `add_notifications` (table `notifications`, enum `NotificationStatus`). `local-day.ts` déplacé dans `src/common/`. **Aucune dépendance ajoutée.**

### Routes

| Route | Effet |
|---|---|
| `GET /api/notifications/settings` | Mode Nuit, heure du rapport, canaux, conversation Telegram, adresse d'envoi |
| `PATCH /api/notifications/settings` | Modification partielle ; `null` efface `telegramChatId` / `notificationEmail` ; 422 si plage vide ou Telegram sans conversation |
| `GET /api/notifications` | Boîte de réception, plus récentes d'abord, avec `unreadCount`. Paramètres : `limit` (1–100, défaut 30), `before` (date ISO), `unread=true` |
| `POST /api/notifications/test` | Message de test **immédiat** sur les canaux activés (3 par minute) |
| `POST /api/notifications/:id/read` | Marque lue (idempotent) ; 404 si elle n'est pas à l'utilisateur |
| `POST /api/notifications/read-all` | Marque tout lu → `{ "updated": n }` |
| `POST /api/alerts` | Crée une alerte (règles ci-dessous) ; 422 si incohérente ou au-delà de 50 |
| `GET /api/alerts` | Liste les alertes de l'utilisateur |
| `PATCH /api/alerts/:id` | Seuil, fenêtre, canal, `isActive`, `isCritical` (la condition et le symbole ne changent pas) |
| `DELETE /api/alerts/:id` | Supprime |

### Mode Nuit

Plage en minutes depuis minuit **local** (défaut 22:00 → 07:00 = `1320` → `420`), début inclus, fin exclue, passage de minuit géré. Pendant la plage, une notification **non critique** est enregistrée en `HELD` et **n'est pas envoyée** (elle sera reprise par le rapport du matin, étape 8) ; une notification **critique** passe toujours.

### Alertes : règles par condition

| Condition | `assetSymbol` | `windowMinutes` | `threshold` |
|---|---|---|---|
| `PRICE_CROSS_ABOVE` / `PRICE_CROSS_BELOW` | requis | **interdit** | prix en USD |
| `PRICE_DROP_PCT` | requis | requis (5–10 080) | % ≤ 100 |
| `PRICE_RISE_PCT` | requis | requis (5–10 080) | % ≤ 1 000 |
| `PORTFOLIO_DROP_PCT` | **interdit** | requis (5–10 080) | % ≤ 100 |

Le seuil est une **chaîne décimale** (`"3500"`, `"5"`), jamais un nombre JSON (D34). Les alertes sont enregistrées mais **pas encore évaluées** : le moteur arrive à l'étape 8.

```json
POST /api/alerts
{ "assetSymbol": "BTC", "condition": "PRICE_DROP_PCT", "threshold": "5", "windowMinutes": 60, "channel": "PUSH", "isCritical": true }
```

### Configurer Telegram

1. Créer un bot avec `@BotFather` ; mettre son jeton dans `TELEGRAM_BOT_TOKEN` (`.env`, jamais commité).
2. Écrire un message au bot, puis lire l'identifiant de conversation (par exemple `https://api.telegram.org/bot<JETON>/getUpdates`, champ `message.chat.id`).
3. `PATCH /api/notifications/settings` avec `{ "telegramEnabled": true, "telegramChatId": "<id>" }`.
4. `POST /api/notifications/test` : le message doit arriver ; sinon `deliveries` donne le code de l'échec.

### Lire le résultat d'une livraison

`deliveries` (dans chaque notification) liste un résultat par canal activé : `{ "channel": "TELEGRAM", "status": "SENT" }` ou `{ "channel": "PUSH", "status": "FAILED", "reason": "channel_not_implemented" }`.

| `reason` | Signification |
|---|---|
| `telegram_not_configured` | `TELEGRAM_BOT_TOKEN` absent |
| `telegram_no_chat` | `telegramChatId` non renseigné |
| `telegram_http_<statut>` | Telegram a refusé (401 : jeton invalide ; 400/403 : conversation inconnue ou bot bloqué) |
| `telegram_unreachable` | Réseau ou délai dépassé |
| `channel_not_implemented` | Push et Email n'ont pas encore d'envoyeur (D51) |
| `sender_error` | Un envoyeur a levé une erreur inattendue |

> **À savoir** : Push est activé par défaut mais sans envoyeur. Tant que Telegram n'est pas configuré, une alerte critique (ex. perte journalière) **n'apparaît que dans la boîte de réception**.

### Envoyer une notification depuis le code

```ts
await notifications.notify(userId, {
  title: 'Stop-loss exécuté',
  body: 'BTC vendu à 58 200 $',
  critical: true,              // passe même en Mode Nuit
  dedupeKey: `sl:${orderId}`,  // optionnel : un même événement n'est notifié qu'une fois
});
```

**Journal d'audit** : `notification_settings.updated` (noms des champs seulement), `alert.created`, `alert.updated` (noms des champs), `alert.deleted`.

**Alerte de perte journalière** : la pause envoie désormais une notification critique `Perte journalière maximale atteinte` (clé `daily-loss:<jour local>`), sans jamais défaire la pause en cas d'échec d'envoi (D54).

**Pas encore fait** : évaluation des alertes et rapport du matin (étape 8), envoyeurs Push et Email, temps réel (WebSocket), purge des anciennes notifications.

## Étape 8 — Moteur d'évaluation des alertes

**Livré** : `src/notifications/engine/` (`AlertEvaluator`, `alert-conditions.ts`, `alert-messages.ts`, `AlertsEngineProcessor` / `AlertsEngineScheduler`, `AlertsEngineModule`), `src/queue/` (`QueueModule`, `RedisConnection`), `PriceProvider.getPriceAt`, migration `add_alert_triggered_state` (colonne `alert_configs.isTriggered`). **Aucune dépendance ajoutée.**

**Fonctionnement** : toutes les minutes, un job BullMQ évalue chaque alerte active (d'un utilisateur actif) sur les prix :
1. prix courants (un appel pour tous les symboles) et, pour les variations, prix à `maintenant − fenêtre` (bougies d'une minute de Binance) ;
2. condition remplie **et** alerte armée → l'alerte passe en « déclenchée » et la notification part, sur le **canal de l'alerte** ;
3. condition redevenue fausse **et** alerte déclenchée → l'alerte se ré-arme ;
4. donnée manquante → aucun changement d'état.

Aucune route nouvelle. `GET /api/alerts` expose désormais `isTriggered` (`false` = armée) et `lastTriggeredAt`.

| Cas | Comportement |
|---|---|
| Condition vraie, alerte armée | Notification (une seule), `isTriggered = true` |
| Condition toujours vraie | Silence |
| Condition redevenue fausse | `isTriggered = false` (ré-armée) |
| Nouveau franchissement < 15 min après le précédent | Retenu (anti-rebond) ; notifié plus tard si la condition est toujours vraie |
| Seuil, fenêtre ou `isActive` modifié | Alerte ré-armée |
| Prix (ou historique) indisponible | Alerte ignorée, état inchangé |
| Envoi en erreur | État rendu, nouvel essai au passage suivant |

**Messages** (même tournure que la maquette) : `BTC −5 % en 1 h`, `SOL +8 % sur 24 h`, `ETH franchit 3 500 $ à la hausse`, `ETH passe sous 3 000 $`, `Portefeuille −10 % sur 7 jours`. Le texte donne la variation réelle et le prix actuel.

**Mode Nuit** : appliqué selon `isCritical` — une alerte non critique la nuit est mise en attente (`HELD`) et attend le rapport du matin (étape 9) ; une alerte critique passe toujours.

**Jobs de fond** : `BACKGROUND_JOBS_ENABLED=false` désactive la surveillance de la perte journalière **et** l'évaluation des alertes (voir étape 6).

**Résultat d'un passage** : `{ evaluated, triggered, rearmed, skipped, failed }` (visible dans les jobs terminés de la file `alerts-engine`).

**Vérifier sur un vrai Redis** : même procédure que pour l'étape 6 (base temporaire, Redis n° 9, `npx prisma migrate deploy`), puis créer une alerte `PRICE_CROSS_ABOVE` avec un seuil de `1` (toujours dépassé) et ajouter un job `evaluate` à la file `alerts-engine` : une notification apparaît dans `GET /api/notifications` et l'alerte passe `isTriggered: true`. Un second passage ne notifie pas.

**Pas encore fait** : rapport du matin (étape 9), envoyeurs Push et Email (sans eux, `channel: "PUSH"` ou `"EMAIL"` donne `channel_not_implemented`), prix observé et écart au seuil exposés par l'API, cache Redis des prix.
## Étape 9 — Rapport du matin

**Livré** : `src/digests/` (`DigestGenerator`, `digest-content.ts`, `DigestsService` et contrôleur, `DigestEngineModule` avec son processeur et son planificateur), migration `add_digest_link` (`notifications.digestId`, valeur d'enum `DIGESTED`), `startOfLocalDay` et `localWeekday` dans `src/common/local-day.ts`, formatage des nombres partagé dans `src/common/format.ts`. **Aucune dépendance ajoutée.**

**Fonctionnement** : toutes les 5 minutes, pour chaque utilisateur actif dont le rapport est activé :
1. l'heure locale a atteint `digestMinute` (défaut 08:00 = `480`) depuis moins de 6 h, et aucun rapport n'existe pour ce jour local ;
2. rassemble : valeur des positions actuelles aux prix d'il y a 24 h et aux prix courants, alertes critiques des dernières 24 h, notifications mises en attente par le Mode Nuit ;
3. enregistre le rapport (`TODAY`, plus `WEEK` le lundi), marque les notifications en attente `DIGESTED` avec le `digestId`, puis annonce le rapport par une notification immédiate sur les canaux activés.

### Routes

| Route | Effet |
|---|---|
| `GET /api/digests` | Rapports, plus récents d'abord, avec `unreadCount`. Paramètres : `limit` (1–100, défaut 30), `before` (date ISO), `period` (`TODAY` ou `WEEK`) |
| `GET /api/digests/:id` | Un rapport ; 404 s'il n'est pas à l'utilisateur |
| `POST /api/digests/:id/read` | Marque lu (idempotent) |

```json
GET /api/digests?period=TODAY&limit=2
→ { "unreadCount": 1, "items": [{
     "id": "…", "period": "TODAY", "periodStart": "2026-10-23T00:00:00.000Z", "periodEnd": "2026-10-23T08:05:00.000Z",
     "summary": "Nuit calme. Votre portefeuille a progressé d'environ 1,2 % sur 24 h. Aucune alerte critique ne s'est déclenchée. Une alerte non urgente a été regroupée dans ce rapport. Aucune action requise.",
     "points": ["Valeur du portefeuille : 41 000 $", "Plus forte hausse : SOL +4,2 %", "Regroupée : ETH franchit 3 500 $ à la hausse"],
     "portfolioDeltaPct": "1.2", "queuedAlertsCount": 1, "readAt": null, "generatedAt": "…" }] }
```

**Mapper la maquette** : « Ce matin » = le premier rapport `TODAY` ; « Hier » = le suivant (`TODAY` de la veille, il n'y a pas de période `YESTERDAY`) ; « 7 jours » = le premier rapport `WEEK`.

### Cas particuliers

| Cas | Comportement |
|---|---|
| Avant l'heure du rapport, ou plus de 6 h après | Aucun rapport (la journée est abandonnée au-delà) |
| Rapport déjà généré pour ce jour local | Rien (idempotent) |
| Prix indisponibles, première heure | Attente du tour suivant, rien d'enregistré |
| Prix indisponibles, après une heure | Rapport généré sans les chiffres du portefeuille |
| Position sans prix (courant ou passé) | « La valeur du portefeuille n'a pas pu être calculée » |
| Pas de position | Rapport sans partie portefeuille |
| Lundi local | `WEEK` (7 jours) en plus de `TODAY` ; sans reprise des notifications en attente |
| Échec d'envoi de l'annonce | Le rapport reste enregistré |
| `digestEnabled = false` | Aucun rapport |

**Réglages concernés** (`PATCH /api/notifications/settings`) : `digestEnabled`, `digestMinute` (minutes depuis minuit local), `nightModeEnabled`, `nightStartMinute`, `nightEndMinute`.

**Notifications** : une notification reprise a le statut `DIGESTED` et un `digestId` (visibles dans `GET /api/notifications`) ; l'annonce du rapport est une notification `DISPATCHED` « Rapport du matin » / « Rapport de la semaine ».

**Jobs de fond** : `BACKGROUND_JOBS_ENABLED=false` désactive aussi la génération des rapports.

**Résultat d'un passage** : `{ checked, generated, failed }` (visible dans les jobs terminés de la file `digest`).

**Vérifier sur un vrai Redis** : même procédure que pour l'étape 6 (base temporaire, Redis n° 9, `npx prisma migrate deploy`). Régler `digestMinute` quelques minutes avant l'heure UTC actuelle (utilisateur en `UTC`), éventuellement une plage de Mode Nuit couvrant l'heure actuelle et une alerte non critique pour avoir une notification en attente, puis ajouter un job `check` à la file `digest` : un rapport apparaît dans `GET /api/digests` et les notifications en attente passent `DIGESTED`. Un second passage ne crée rien.

**Pas encore fait** : soldes et stablecoins du rapport (nécessitent le module d'ordres), purge des anciens rapports, envoyeurs Push et Email (sans eux, l'annonce n'arrive que sur Telegram et dans la boîte de réception).