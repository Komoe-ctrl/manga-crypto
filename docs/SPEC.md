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
