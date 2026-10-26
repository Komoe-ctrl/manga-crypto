# CAHIER DES CHARGES : APPLICATION DE TRADING ALGORITHMIQUE & SUIVI CRYPTO (MVP)

## 1. VISION DU PROJET
L'application est un assistant d'investissement intelligent pour un client qui ne peut pas surveiller les marchés 24h/24.
Le système doit :
1. Analyser le marché en continu (H24) à la recherche d'opportunités.
2. Prendre des décisions autonomes d'achat, de vente ou de retrait de position (selon des règles strictes).
3. Soulager la charge mentale du client grâce à des rapports automatisés et des alertes intelligentes.

Principe UX non négociable : interface calme, « sans écran ». Pas de graphiques qui clignotent ; l'information vient au client (alertes, rapport du matin), pas l'inverse.

---

## 2. ARCHITECTURE TECHNIQUE & STACK

Trois dépôts séparés (pas de monorepo), chacun avec son propre `CLAUDE.md` :

```
crypto-api/        → Backend NestJS (dépôt de travail de cette étape)
├── docs/SPEC.md           → ce cahier des charges (source de vérité)
├── docker-compose.yml     → PostgreSQL + Redis pour le dev local
└── CLAUDE.md

crypto-web/        → Frontend Next.js
├── docs/design/CryptoDashboard.jsx  → maquette de référence validée par le client
└── CLAUDE.md

crypto-engine/     → Moteur Python (uv ou poetry)
└── CLAUDE.md
```

Contrat entre les dépôts (à la place de types partagés) :
- `crypto-api` expose une spec OpenAPI générée par `@nestjs/swagger` ; `crypto-web` génère ses types avec `openapi-typescript`. Pas de copier-coller de types à la main.
- Les événements WebSocket et le format des signaux du moteur sont documentés dans `crypto-api/docs/SPEC.md`.

### A. Frontend (crypto-web)
- Stack : Next.js 15 (App Router), TypeScript strict, Tailwind CSS v4, lucide-react, TanStack Query (données REST), socket.io-client (prix et alertes en temps réel), React Hook Form + Zod (formulaires).
- Référence visuelle : `docs/design/CryptoDashboard.jsx` est la maquette validée (dark mode, glassmorphism, accent menthe #7DD3C0, gains #6EE7B7, pertes #F5A07A, police Manrope, chiffres en tabular-nums). C'est une RÉFÉRENCE, pas du code de production : le jour où l'on construit le front, on la découpe en composants typés (`WalletHeader`, `AssetsTable`, `Sparkline`, `AlertCenter`, `NightModeCard`, `DigestCard`, `AddTransactionAlertDialog`) et on remplace les données simulées par l'API.
- Les couleurs et la typo de la maquette deviennent des tokens dans le thème Tailwind (`@theme`), jamais des hex en dur dans les composants.

### B. Cœur de l'API & gestion utilisateur (crypto-api)
- Stack : NestJS, TypeScript, Prisma ORM, PostgreSQL.
- Rôle : authentification, gestion du portefeuille, stockage chiffré des clés API des plateformes (Binance, Kraken…), passerelle WebSocket pour le front, logs d'audit.
- C'est le SEUL service qui déchiffre les clés API et qui passe les ordres (via `ccxt` en version Node), à travers une file BullMQ. Les clés ne quittent jamais ce service.

### C. Moteur d'analyse (crypto-engine)
- Stack : Python 3.11+, FastAPI, CCXT (données de marché publiques uniquement), Pandas, TA-Lib.
- Rôle : analyse technique en tâche de fond (RSI, MACD, Bollinger, EMA 20/50, volatilité) et émission de SIGNAUX (BUY / SELL / HOLD avec score et justification).
- Le moteur n'a pas accès aux clés API et n'envoie aucun ordre lui-même : il publie ses signaux dans un Redis Stream (`signals`) consommé par l'API, qui applique la gestion des risques puis met l'ordre en file.

### D. Données & file d'attente (infrastructure)
- Stack : Redis & BullMQ (côté NestJS).
- Redis : cache des prix en temps réel (ticker) + Redis Stream pour les signaux du moteur.
- BullMQ : orchestre l'exécution des ordres avec retry et backoff. Chaque ordre porte un `clientOrderId` idempotent pour qu'un retry ne passe jamais un ordre en double.

---

## 3. FONCTIONNALITÉS CRITIQUES

### MODULE 1 : Analyse de marché autonome (engine)
- Scan permanent du top 20 des cryptomonnaies les plus liquides.
- Indicateurs composites : croisement EMA 20/50, RSI (surachat/survente), volatilité.
- Émission de signaux BUY / SELL avec niveau de confiance.

### MODULE 2 : Gestion des risques (api)
L'algorithme ne doit jamais investir au hasard. Règles absolues, stockées en base et paramétrables par utilisateur :
- Exposition max par trade : impossible d'engager plus de X % (ex. 5 %) du capital total sur une position.
- Stop-loss & take-profit automatiques : dès qu'un achat est exécuté, les deux seuils sont programmés.
- Perte journalière max (ex. −3 %) : au-delà, le robot se met en pause et prévient le client (alerte critique).
- Kill switch : le client peut arrêter le robot à tout moment, en un clic.
- Mode `PAPER` (simulation / testnet) par défaut. Le passage en `LIVE` est une action explicite et journalisée.

### MODULE 3 : Centre de notification & Mode Tranquillité (api + WebSocket)
- Alertes personnalisées (cf. maquette) : condition (baisse de X % en 1 h, hausse de X % sur 24 h, franchit un prix à la hausse, passe sous un prix), canal (Push, Telegram, Email), activation on/off, flag « critique ».
- Mode Nuit / Tranquillité : plage horaire (ex. 22:00 → 07:00, fuseau de l'utilisateur). Pendant cette plage, les alertes non critiques sont mises en attente ; les alertes critiques (stop-loss exécuté, anomalie de compte, perte journalière max) passent toujours.
- Rapport du matin (digest) : synthèse textuelle générée à heure fixe (ex. 08:00) qui résume la nuit et inclut les alertes mises en attente. Les rapports sont stockés pour l'historique.

---

## 4. SÉCURITÉ DE NIVEAU BANCAIRE (OBLIGATOIRE)
1. Chiffrement des clés API : les clés secrètes ne doivent JAMAIS apparaître en clair (ni en base, ni dans les logs, ni dans les réponses API). Chiffrement AES-256-GCM avec IV unique par chiffrement, tag d'authentification stocké, clé maître fournie par variable d'environnement (ou KMS) et versionnée pour permettre une rotation.
2. Restriction des droits API : le système doit refuser d'activer une configuration d'échange si la clé possède le droit « Withdrawal ». Seuls « Read » et « Trade » sont acceptés. Attention : CCXT n'expose pas ces permissions de façon uniforme ; prévoir un vérificateur par plateforme (ex. Binance : endpoint `apiRestrictions`) et refuser par défaut une plateforme sans vérificateur.
3. Montants : tous les montants et quantités en `Decimal` (jamais `Float`).
4. Journal d'audit immuable pour toute action sensible (ajout de clé, passage LIVE, kill switch, ordre).

---

## 5. CONVENTIONS
- TypeScript strict partout, ESLint + Prettier.
- Code modulaire, documenté (JSDoc / docstrings), testable.
- Pas de mention d'attribution (« Generated with Claude », Co-Authored-By) dans les commits et PR.

---

## 6. VERSIONS DE RÉFÉRENCE (figées à l'initialisation, oct. 2026)

| Brique | Version |
|---|---|
| Node.js / npm | 24 LTS / 11 (npm 10 a un bug d'installation sur crypto-api) |
| TypeScript | 6.0.x (la 7.0 native n'est pas encore supportée par typescript-eslint, Nest CLI, ts-jest) |
| Next.js / React | 16.4 / 19.3 |
| Tailwind CSS | 4.x (tokens dans `src/app/globals.css`, bloc `@theme`) |
| NestJS | 12.x (ESM, Vitest, oxlint) |
| Prisma | 7.10.x stable (pas la 8.0 RC) — `prisma.config.ts`, générateur `prisma-client`, adapter `@prisma/adapter-pg` |
| Python | 3.12 (uv) — FastAPI, CCXT, Pandas 3, TA-Lib 0.8 |
| PostgreSQL / Redis | 18 / 8 (docker-compose.yml de crypto-api) |

Ne pas monter ces versions majeures sans validation.

---

## 7. CONTRAT DES SIGNAUX (moteur → API)

Le moteur (`crypto-engine`) publie ses signaux dans le **Redis Stream `signals`** ; l'API les consomme (groupe de consommateurs `api`), applique la gestion des risques puis passe l'ordre. Le moteur n'a pas accès aux clés API et n'envoie aucun ordre.

### Message

Une entrée du stream = **un seul champ `data`** contenant un objet JSON (UTF-8, 8 Ko au plus), version 1 :

```json
{
  "v": 1,
  "id": "6f2b4d58-3c7f-4b6a-9d52-1c5d2b1f0a11",
  "ts": "2026-10-24T08:00:00Z",
  "symbol": "BTC",
  "action": "BUY",
  "score": 0.82,
  "price": "81700.5",
  "reason": "EMA20 > EMA50, RSI 41",
  "indicators": { "rsi": 41, "ema20": 81500, "ema50": 80900 }
}
```

| Champ | Obligatoire | Règle |
|---|---|---|
| `v` | oui | Entier `1`. Toute autre version est refusée. |
| `id` | oui | Identifiant **unique** du signal (UUID conseillé), 1 à 64 caractères parmi `A-Z a-z 0-9 - _ . :`. Sert à la déduplication : un même `id` ne passe jamais deux fois un ordre, même republié. |
| `ts` | oui | Instant de l'analyse, ISO 8601 en UTC (`Z`). Refusé s'il est à plus de 60 s dans le futur. Un signal plus vieux que 5 minutes est ignoré (son prix n'est plus valable). |
| `symbol` | oui | Actif de base en majuscules (`BTC`), 2 à 12 caractères `A-Z 0-9`. La paire négociée est `<symbol>/USDT`. Les stablecoins ne se négocient pas. |
| `action` | oui | `BUY`, `SELL` ou `HOLD`. `HOLD` est enregistré mais ne déclenche aucun ordre. |
| `score` | oui | Nombre de 0 à 1 : confiance du moteur. Sous le seuil (0,6 par défaut), le signal est ignoré ; au-dessus, il dimensionne l'achat. |
| `price` | non | Prix à l'analyse, chaîne décimale positive (informatif). Un achat est ignoré si le prix a bougé de plus de 2 % depuis. |
| `reason` | non | Justification lisible, 500 caractères au plus. |
| `indicators` | non | Objet JSON libre (valeurs de RSI, MACD…), 2 Ko au plus une fois sérialisé. |

Les champs inconnus sont ignorés (évolution compatible). Un message invalide (JSON illisible, champ manquant ou hors règle, version inconnue) n'est pas retenté : il est déplacé dans le stream **`signals:dead`** avec son motif.

### Ce que fait l'API d'un signal valide

- **`BUY`** : pour chaque utilisateur actif dont le robot n'est ni arrêté ni en pause, achète jusqu'à l'exposition maximale par position (`RiskSettings.maxExposurePct` du capital total) moins la position déjà détenue, **proportionnellement au score** (score 0,8 = 80 % de la place disponible). Mode PAPER (simulation) ou LIVE selon l'utilisateur.
- **`SELL`** : vend **toute** la position détenue du symbole.
- Dans tous les cas, l'ordre passe par les garde-fous habituels (kill switch, pause, exposition, fonds) et garde l'`id` du signal et son contenu pour la traçabilité.

### Côté moteur

- Publier avec `XADD signals MAXLEN ~ 10000 * data '<json>'` (le moteur borne la taille du stream).
- Un `id` par signal, jamais réutilisé pour un autre signal ; republier un signal avec le même `id` est sans effet.
- Ne pas supposer de réponse : l'API ne répond pas au moteur.
- **L'API ne consomme ces signaux que si `SIGNALS_ENABLED=true`**, et ne passe aucun ordre LIVE à partir d'eux sans `SIGNALS_ALLOW_LIVE=true` (le backtest du moteur n'a démontré aucun avantage de sa stratégie ; voir `docs/DECISIONS.md`, D114).
- Implémentation de référence : `crypto-engine` (identifiant `SYMBOLE-1h-<ouverture de la bougie en ms>-ACTION`, signal publié seulement quand la position recommandée change, après confirmation de plusieurs bougies fermées ; voir son `docs/FONCTIONNEMENT.md`).


---

## 8. TEMPS RÉEL (API → front, WebSocket)

L'API pousse à crypto-web les changements d'état ; le WebSocket **n'envoie que des informations** (aucune commande : tout ce qui agit passe par l'API HTTP). Ce n'est pas décrit par l'OpenAPI, d'où cette section.

### Connexion

- URL : `ws://<hôte>/api/ws` (`wss://` en production), WebSocket natif du navigateur.
- Chaque message est du JSON : `{"event": "<nom>", "data": { … }}`.
- **Premier message obligatoire, dans les 5 secondes** : `{"event":"auth","data":{"token":"<access token>"}}`. Le jeton ne doit pas être mis dans l'URL.
- Réponse : `{"event":"ready","data":{"expiresAt":"<ISO UTC>"}}`. À cette date la connexion est coupée (4401) ; le client peut renvoyer `auth` avec un jeton rafraîchi avant, pour la garder.
- Erreur : `{"event":"error","data":{"code":"<motif>"}}` puis fermeture.
- Au plus 5 connexions par utilisateur. Message client limité à 4 Ko. Ping serveur toutes les 30 s (le navigateur répond seul).

| Code de fermeture | Sens |
|---|---|
| 4401 | Jeton absent, invalide, expiré, ou compte désactivé |
| 4408 | Pas d'`auth` dans le délai |
| 4429 | Trop de connexions |
| 1009 | Message trop gros |
| 1001 | Arrêt du serveur |

### Événements (serveur → client), uniquement ceux de l'utilisateur connecté

| `event` | `data` | Quand |
|---|---|---|
| `order` | Même forme que `GET /api/orders/:id` (`id`, `status`, `symbol`, `side`, `quantity`, `filledQuantity`, `avgFillPrice`, `stopLossPrice`, `failureReason`, …) ; montants en **chaînes décimales** | À chaque changement d'état d'un ordre : `PENDING`, `SUBMITTED`, `PARTIALLY_FILLED`, `FILLED`, `REJECTED`, `CANCELLED`, `FAILED` |
| `risk` | `tradingMode`, `killSwitchActive`, `botPausedUntil`, `canTrade`, `blockedReason` | Kill switch, passage LIVE/PAPER, pause sur perte journalière |
| `notification` | `id`, `title`, `body`, `critical`, `status`, `createdAt` | Chaque nouvelle notification, y compris celles retenues par le Mode Nuit (`status: HELD`) |

### Règles pour le front

- **Pas de rejeu** : un événement émis pendant une déconnexion est perdu. À chaque (re)connexion, relire l'état par l'API REST, puis s'appuyer sur les événements.
- Reconnexion avec un délai croissant ; après 4401, rafraîchir le jeton d'abord.
- Les événements sont des **signaux de mise à jour** : en cas de doute, relire la ressource par l'API (l'état du portefeuille, par exemple, se relit sur un événement `order`).

---

## 9. NOTIFICATIONS PUSH ET EMAIL (contrat pour le front)

Les notifications sortent de la boîte de réception par Web Push, email et Telegram, selon les canaux activés dans `PATCH /api/notifications/settings` (`pushEnabled`, `emailEnabled`, `telegramEnabled`, `notificationEmail`). Le Mode Nuit retient les notifications non critiques ; une critique passe toujours.

### S'abonner au Push (côté navigateur)

1. `GET /api/notifications/push` renvoie `{ configured, publicKey, subscriptions }`. Si `configured` est faux, ne pas proposer le Push.
2. Enregistrer un **service worker** (HTTPS obligatoire, `localhost` accepté), demander la permission (`Notification.requestPermission()`), puis :
   ```js
   const registration = await navigator.serviceWorker.register('/sw.js');
   const subscription = await registration.pushManager.subscribe({
     userVisibleOnly: true,
     applicationServerKey: publicKey, // la clé publique VAPID reçue à l'étape 1
   });
   ```
3. Envoyer l'abonnement tel quel : `PUT /api/notifications/push/subscription` avec `subscription.toJSON()` (le champ `expirationTime` est accepté et ignoré). Réponse : `{ configured, publicKey, subscriptions }`.
4. Se désabonner : `DELETE /api/notifications/push/subscription` avec `{ "endpoint": subscription.endpoint }`, puis `subscription.unsubscribe()`.

Règles : **5 appareils au plus** par utilisateur (le plus ancien est écarté au sixième) ; une adresse qui n'est pas un service Push de navigateur connu est refusée en **422** ; un abonnement révoqué par le navigateur est retiré par le serveur (`subscriptions` diminue) : à la reconnexion, si `subscriptions` vaut 0 alors que l'utilisateur a activé le Push, se réabonner.

### Ce que reçoit le service worker

Un message JSON `{ "title": string, "body": string, "critical": boolean }` :

```js
self.addEventListener('push', (event) => {
  const { title, body, critical } = event.data.json();
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      requireInteraction: critical, // une alerte critique reste affichée jusqu'à ce qu'on la ferme
      tag: critical ? 'veille-critique' : 'veille',
    }),
  );
});
```

Un message critique est conservé 24 h par le service Push si l'appareil est éteint ; un autre, 1 h. Sur iPhone, Safari n'envoie des notifications Push qu'à un site **installé sur l'écran d'accueil**.

### Email

Texte brut, sans HTML ni lien de désabonnement. Destinataire : `notificationEmail` s'il est défini, sinon l'adresse du compte. `POST /api/notifications/test` envoie un message de test sur les canaux activés ; le détail par canal est dans `deliveries` (`{ channel, status: "SENT" | "FAILED", reason? }`, codes dans `docs/ETAPES.md`, étape 15).
