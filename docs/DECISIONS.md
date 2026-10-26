# Journal des décisions d'architecture

Chaque décision : le choix, la raison, et ce qu'elle impose pour la suite. Les décisions sont numérotées dans l'ordre où elles ont été prises ; une décision remplacée n'est pas supprimée, elle est marquée « remplacée par ».

Source de vérité fonctionnelle : [`SPEC.md`](SPEC.md). Détail de ce qui a été livré et comment le tester : [`ETAPES.md`](ETAPES.md).

---

## Étape 1 — Schéma de données et chiffrement

### D1. Identifiants `uuid`, dates en UTC, fuseau dans `User.timezone`
Les `uuid` ne sont pas devinables (utile derrière une API) et permettent de générer l'id côté application. Les horaires « de la journée » (Mode Nuit, digest) sont des **minutes depuis minuit** dans le fuseau de l'utilisateur (22:00 = 1320) : pas de type `Time` Prisma, calcul simple côté Node avec le fuseau IANA.

### D2. Montants en `Decimal`, pourcentages en `Decimal(5,2)`
Règle non négociable du CLAUDE.md. Quantités `Decimal(38,18)`, prix `Decimal(38,8)`. Un pourcentage s'exprime en points (`5.00` = 5 %).

### D3. Aucun utilisateur n'est supprimé : `deletedAt`
`TradeLog` et `AuditLog` doivent survivre. Leurs relations vers `User` sont en `onDelete: Restrict` ; les réglages, actifs, alertes, digests et clés d'échange sont en `Cascade`. Un compte se **désactive**, il ne s'efface pas.
*Impose :* toute requête sur `User` filtre `deletedAt: null`.

### D4. `AuditLog` immuable par trigger PostgreSQL
UPDATE, DELETE et TRUNCATE sont interdits au niveau de la base (migration `init_schema`), pas seulement par convention applicative. Conséquence : `AuditLog.userId` est en `Restrict` (un `SetNull` ferait un UPDATE, que le trigger refuse). `action` est une chaîne `domaine.verbe` plutôt qu'un enum, pour ne pas migrer à chaque nouvelle action.
*Impose :* ne jamais mettre de secret dans `metadata`.

### D5. `TradeLog.clientOrderId` unique
Garantit l'idempotence : un retry BullMQ ne peut pas insérer deux fois le même ordre. Le signal d'origine est conservé en `Json` (traçabilité complète signal → ordre).

### D6. `ExchangeConfig` : clé et secret chiffrés séparément, une seule `keyVersion`
Chaque champ a son `ciphertext`, son `iv` et son `authTag`. `apiKeyHint` (4 derniers caractères) permet l'affichage sans déchiffrer. `permissions` et `verifiedAt` tracent la dernière vérification.

### D7. AES-256-GCM avec `node:crypto`, sans dépendance
- IV de 12 octets aléatoires **à chaque** chiffrement, tag d'authentification stocké.
- Clés maîtres `ENCRYPTION_KEY_V{n}` (32 octets en base64), `ENCRYPTION_ACTIVE_KEY_VERSION` choisit celle qui chiffre. Les anciennes versions restent lisibles : c'est la rotation.
- Configuration validée **au démarrage** : l'application refuse de démarrer sans clé active valide.
- **AAD** : le chiffré est lié à son contexte (`exchange-config:<id>:apiKey`). Copier un chiffré sur une autre ligne le rend indéchiffrable.
- Erreurs génériques : aucune clé, aucun texte clair dans un message.

### D8. Prisma 7 : client dans `src/generated/prisma`, adapter `@prisma/adapter-pg`
Imposé par la SPEC. `PrismaService` construit l'adapter à partir de `DATABASE_URL`. Le client généré est ignoré par git : `npm run prisma:generate` après un clone.

---

## Étape 2 — Authentification

### D9. argon2id (paquet `argon2`)
Recommandation OWASP, résistant aux GPU. Paramètres par défaut du paquet. Mot de passe : 12 à 128 caractères (le maximum borne le coût du hachage). *Dépendance ajoutée, hors SPEC, validée par l'utilisateur.*

### D10. Pas de Passport : `AuthGuard` maison + `@nestjs/jwt`
Un seul schéma (Bearer JWT) : Passport n'apporterait que des dépendances. La garde est **globale** (tout est protégé par défaut), `@Public()` ouvre une route explicitement. *Dépendance `@nestjs/jwt` ajoutée.*

### D11. Access token court + refresh token opaque en cookie
- Access token : JWT HS256, 15 min, `sub` uniquement. L'algorithme est imposé à la vérification (un token `alg: none` est refusé). Le secret `JWT_ACCESS_SECRET` doit faire ≥ 32 caractères.
- Refresh token : 256 bits aléatoires, 7 jours, dans un cookie `httpOnly`, `SameSite=Strict`, `Path=/api/auth`, `Secure` en production. Le JavaScript du front ne le voit jamais (protection XSS) ; `SameSite=Strict` protège du CSRF.
*Impose au front :* `credentials: 'include'` sur les appels d'authentification.

### D12. Révocation par famille, rotation à chaque usage
Seul le hash SHA-256 du refresh token est stocké. Chaque `refresh` consomme le token (mise à jour atomique : deux requêtes simultanées, une seule gagne) et en émet un nouveau dans la même `familyId`. Si un token **déjà consommé** revient, c'est un vol probable : toute la famille est révoquée et l'événement `auth.refresh_reuse_detected` est audité.

### D13. Anti-énumération
Même erreur (« Identifiants invalides ») pour un email inconnu et un mauvais mot de passe, et un hash factice est vérifié quand l'email est inconnu pour égaliser le temps de réponse. L'audit des échecs ne contient ni l'email ni le mot de passe.
*Limite assumée :* `register` répond 409 sur un email existant ; l'inscription est fermable (`AUTH_REGISTRATION_ENABLED=false`).

### D14. Limitation de débit `@nestjs/throttler`
120 requêtes/min/IP globalement, 5/min sur register, login et refresh. *Dépendance ajoutée.*
*À revoir en production derrière un proxy :* activer `trust proxy` pour que `req.ip` soit l'IP réelle, sinon tous les clients partagent le même compteur.

### D15. Tests HTTP sur une base en mémoire
`test/support/fake-prisma.ts` couvre les appels Prisma utilisés. Raison : `audit_logs` est immuable, un test sur la vraie base y laisserait des lignes définitives. Contrepartie : le SQL réel n'est pas exercé par ces tests (voir « Tests d'intégration » dans la liste des suites à donner).

### D16. `.gitattributes` : fins de ligne LF sur `prisma/migrations/**`
Prisma checksum chaque migration. Sous Windows, Git réécrivait les fichiers en CRLF au `pull` et Prisma signalait « migration modifiée après application ». LF est imposé pour ces fichiers.

---

## Étape 3 — Clés d'échange

### D17. Vérifier avant de stocker ; une clé « Withdrawal » n'est jamais enregistrée
Le contrôle de permissions se fait avec la clé en mémoire, **avant** le chiffrement. Une clé refusée n'entre jamais en base (pas de secret au repos inutile). Le statut `REJECTED` n'apparaît donc que lors d'une **re-vérification** d'une clé déjà stockée.

### D18. Un vérificateur par plateforme, refus par défaut
`VerifierRegistry` associe plateforme → vérificateur. Sans vérificateur, `POST /api/exchanges` répond 422 (SPEC 4.2, CCXT n'exposant pas les permissions de façon uniforme). Aujourd'hui : **Binance seulement**. Kraken est dans l'enum mais refusé tant qu'aucun vérificateur n'existe.

### D19. Binance : `apiRestrictions` en `fetch` natif, sans `ccxt`
`GET /sapi/v1/account/apiRestrictions`, requête signée HMAC-SHA256. Le secret ne sert qu'à signer ; il n'est ni envoyé, ni journalisé. `ccxt` (dans la stack) viendra avec les ordres ; il n'est pas nécessaire pour lire des permissions.
- Une panne (5xx), une limite de débit (418/429), une horloge décalée (-1021) ou une réponse inattendue donnent **503** : on ne conclut rien sur la clé.
- Une réponse où `enableWithdrawals` n'est pas un booléen est refusée : un champ absent n'est jamais lu comme « pas de retrait ».

### D20. Testnet (`sandbox`) accepté mais « non vérifié » et exclu du LIVE
Le testnet Binance n'expose pas `apiRestrictions` et ses fonds sont fictifs. La configuration est acceptée avec `verifiedAt = null` et une mention dans `statusReason`.
*Impose (étape « passage LIVE ») :* refuser le passage en `LIVE` tant que la configuration utilisée est `sandbox` ou non vérifiée.

### D21. AAD = id de la ligne, généré côté application
L'id est créé avant l'INSERT pour pouvoir servir de contexte au chiffrement (`exchange-config:<id>:apiKey`).

### D22. `verify` est aussi la réactivation
Une configuration `DISABLED` ou `REJECTED` ne redevient `ACTIVE` qu'après une vérification réussie : on ne réactive pas à l'aveugle une clé dont les droits ont pu changer.

### D23. `DELETE` refusé si des ordres existent
`TradeLog` référence `ExchangeConfig` en `Restrict` : le journal des ordres est conservé. Dans ce cas il faut **désactiver**. La suppression sans ordre détruit définitivement les clés chiffrées.

### D24. Réponses : jamais de champ chiffré
Un `select` explicite (`PUBLIC_SELECT`) liste les champs exposés ; les colonnes `*Cipher/*Iv/*Tag` et `keyVersion` n'en font pas partie. Des tests vérifient que ni la clé, ni le secret n'apparaissent dans une réponse, un listing, une erreur de validation ou le journal d'audit.

---

## Étape 4 — Gestion des risques et contrôle du robot

### D25. Règles de risque en fonctions pures (`risk-rules.ts`)
Taille maximale de position, dépassement d'exposition, prix de stop-loss / take-profit, perte journalière atteinte : calculs en `Decimal`, sans accès base ni effet de bord. Le module d'ordres les appellera avec les données du portefeuille, et elles se testent sans infrastructure. Les résultats ne sont pas arrondis : la précision dépend de la plateforme, l'arrondi revient à l'appelant.
Cas limites décidés : capital nul ou négatif → toute position est refusée ; valeur d'ouverture nulle → pas de perte calculable (faux) ; égalité avec la limite d'exposition → autorisée, égalité avec la limite de perte journalière → déclenchée.

### D26. Réglages bornés et audités
Exposition max, perte journalière max et stop-loss dans ]0, 100] ; take-profit dans ]0, 1000] ; deux décimales au plus (un pourcentage à trois décimales est refusé plutôt qu'arrondi en silence). `PATCH` partiel : seuls les champs fournis changent. Chaque modification est auditée avec l'**ancienne et la nouvelle valeur** (`risk.settings_updated`) ; une requête qui ne change rien n'écrit rien.
*Pourcentages renvoyés en nombres* (deux décimales sont exactes en flottant) ; les montants, eux, restent en `Decimal` côté serveur.

### D27. Kill switch : une action, sans friction, idempotente
L'activation ne demande ni mot de passe ni confirmation (SPEC : « en un clic »). Activer deux fois n'écrit qu'un audit. Il bloque **tous** les modes, PAPER compris. La réactivation n'est pas conditionnée non plus ; si cela devait changer (ré-authentification), ce serait une nouvelle décision.

### D28. Passage en LIVE : ré-authentification, confirmation et prérequis
Le passage en `LIVE` exige :
1. le **mot de passe** du compte (ré-authentification) et la phrase **`PASSER EN LIVE`** recopiée exactement ;
2. le kill switch **désactivé** ;
3. au moins une configuration d'échange **`ACTIVE`, non `sandbox` et vérifiée** (applique D20).

Chaque refus est audité avec sa raison (`mode.live_denied` : `bad_password`, `kill_switch`, `no_verified_exchange`). Un mauvais mot de passe renvoie **403 et non 401** : le front traite 401 comme une session expirée et déconnecterait l'utilisateur. Route limitée à 5 requêtes/minute. Le retour en `PAPER` est toujours immédiat et sans condition (réduire le risque ne doit jamais être bloqué).
*Limite connue :* la condition (3) est vérifiée au passage, pas à chaque ordre. Le module d'ordres devra refuser un ordre LIVE si la configuration utilisée n'est plus éligible.

### D29. `status()` est le point d'entrée « peut-on passer un ordre ? »
`TradingControlService.status()` renvoie `canTrade` et `blockedReason` (`KILL_SWITCH` ou `PAUSED_DAILY_LOSS`, via `botPausedUntil`). **Le module d'ordres devra l'appeler avant chaque ordre** et s'arrêter si `canTrade` est faux.

### D30. Pause automatique sur perte journalière : hors de cette étape
Elle demande la valorisation du portefeuille (valeur d'ouverture du jour, valeur courante), qui n'existe pas encore. La règle (`dailyLossBreached`) et le champ (`User.botPausedUntil`) sont prêts ; le déclenchement, l'alerte critique associée et l'audit viendront avec le module de portefeuille.

### D31. Délai des tests e2e porté à 20 s
Les parcours enchaînent plusieurs hachages argon2 (volontairement lents) et les fichiers e2e tournent en parallèle : le délai par défaut de 5 s rendait un test de limitation de débit instable.

---

## Étape 5 — Portefeuille et valorisation

### D32. Positions déclarées par l'utilisateur, pour l'instant
Les positions viennent d'achats/ventes saisis (`POST /api/portfolio/transactions`) ou d'un import (`PUT /api/portfolio/assets/:symbol`). Les relire depuis les soldes de la plateforme demande `ccxt` et les clés déchiffrées : cela viendra avec le module d'ordres, qui est le seul à les déchiffrer (CLAUDE.md). Aucune migration : le modèle `Asset` de l'étape 1 suffit.

### D33. Calcul pur en `Decimal` (`portfolio-math.ts`)
- Achat : quantité cumulée, **prix moyen pondéré** arrondi à 8 décimales (précision de la colonne).
- Vente : le prix moyen **ne change pas** ; le gain réalisé est `(prix − prix moyen) × quantité`. Position soldée → ligne supprimée. Vendre plus que détenu (ou sans position) → 422, rien n'est modifié.
- Le gain réalisé est renvoyé et audité, **pas persisté** : il n'existe pas encore de table d'historique des transactions.

### D34. Quantités et prix : chaînes décimales, jamais des nombres JSON
Un nombre JSON passe par un flottant et perd de la précision (règle « jamais `Float` »). Les entrées doivent être des chaînes (`"0.015"`), strictement positives, 18 décimales au plus ; `0.5`, `1e3`, `0`, `-1` sont refusés (400). Les sorties sont en notation normale (`toFixed()`, jamais d'exposant `1e-7`), arrondies à 8 décimales pour les montants calculés.

### D35. Concurrence : mise à jour conditionnelle sur `updatedAt`, pas de verrou
Deux transactions simultanées sur le même actif liraient la même position et l'une écraserait l'autre. Chaque écriture ajoute `WHERE id = … AND updatedAt = <valeur lue>` ; si aucune ligne n'est touchée, **409** « réessayez ». Aucun solde ne se perd silencieusement, sans verrou SQL ni changement de schéma. Création simultanée : la contrainte unique `(userId, symbol)` déclenche le même 409.

### D36. Source de prix derrière une interface (`PriceProvider`)
Jeton d'injection abstrait. L'implémentation actuelle lit l'API **publique** de Binance (`/api/v3/ticker/price`, sans clé) : un appel récupère toutes les paires `<SYMBOLE>USDT`, mis en **cache 15 s**, appels simultanés fusionnés, échec non mis en cache. Le cache Redis prévu par la SPEC (section D) la remplacera sans toucher à la valorisation.
- Valorisation en **USD**. Les stablecoins (`USD`, `USDT`, `USDC`, `FDUSD`, `DAI`) valent 1 : approximation assumée, à affiner si un dépeg doit être détecté.
- `User.baseCurrency` n'est pas encore utilisé : la réponse porte `currency: "USD"`.

### D37. Prix indisponibles : on dégrade, on ne plante pas
Source injoignable ou symbole inconnu → les positions concernées reviennent avec `currentPrice/value/pnl = null` et la réponse porte `complete: false`. Les **totaux, le P&L et les poids ne comptent que les positions valorisées**, pour rester cohérents entre eux ; `complete` dit si le total est partiel.

### D38. `totalValue()` renvoie `null` si le total est partiel
Prévu pour la pause sur perte journalière : agir sur un total incomplet (une position sans prix manquante) pourrait déclencher ou rater une pause à tort. Mieux vaut ne pas conclure.

### D39. La base en mémoire des tests renvoie des copies
Le faux Prisma renvoyait d'abord la ligne elle-même ; une mise à jour la modifiait sous les pieds de l'appelant, ce qui faussait l'audit (valeur « avant » écrasée) et rendait le test de concurrence incapable de détecter une course. Comme Prisma, il renvoie désormais des copies.

---

## Étape 6 — Pause automatique sur perte journalière

### D40. Dépendances : `bullmq`, `@nestjs/bullmq` et `ioredis`
BullMQ est dans la stack de la SPEC (section D) ; `@nestjs/bullmq` est son intégration Nest officielle (compatible Nest 12). **`ioredis`** est le client Redis dont BullMQ a besoin : il est déclaré « optionnel » côté BullMQ, mais **en ESM natif BullMQ ne peut pas le charger tout seul à partir d'options de connexion** (erreur au démarrage : *BullMQ could not load the optional 'ioredis' package*). Il faut lui passer un client `ioredis` déjà construit : c'est le rôle de `RedisConnection`, qui possède aussi sa fermeture à l'arrêt. Ce bug n'a été détecté que par un test sur un vrai Redis (D47), pas par les tests unitaires.

### D41. Surveillance : job répétable toutes les 5 minutes, un utilisateur à la fois
Un `upsertJobScheduler` (identifiant fixe `daily-loss-check`) programme le passage : redémarrer l'application ne crée pas de doublon. Le worker traite les utilisateurs actifs **séquentiellement** (`concurrency: 1`) et **isole les échecs** : une erreur chez un utilisateur est comptée et journalisée (nom de l'erreur seulement, jamais son message) sans empêcher la surveillance des autres. 5 minutes bornent le retard avec lequel une perte est détectée et celui de la valeur d'ouverture après minuit.

### D42. Table `EquitySnapshot` : un instantané par utilisateur et par jour *local*
Clé `(userId, localDate)` unique, `localDate` = `YYYY-MM-DD` dans le fuseau de l'utilisateur. Il garde la valeur d'ouverture et les **positions d'ouverture** (`[{ symbol, quantity, price }]` en chaînes décimales). Deux passages simultanés peuvent tenter de le créer : la contrainte unique protège, le perdant ignore l'erreur.

### D43. La perte se mesure sur les positions d'**ouverture**, pas sur la valeur totale
Perte = valeur d'ouverture − (quantités d'ouverture × prix courants). Comme les positions sont déclarées à la main (D32), comparer la valeur totale du portefeuille à celle d'ouverture déclencherait une pause à tort dès qu'on déclare une vente ou un retrait. Avec les positions d'ouverture, seule la variation de marché compte ; une position vendue depuis l'ouverture reste valorisée (ses prix sont toujours demandés). Le seuil est `RiskSettings.maxDailyLossPct`, égalité incluse.
*Limites assumées :* (a) les pertes dues à des **ordres du robot** pendant la journée ne sont pas vues tant que les soldes ne sont pas lus sur la plateforme (module d'ordres) ; (b) la valeur d'ouverture est la **première observation du jour** : si l'application est arrêtée à minuit, une perte survenue avant la première observation n'est pas comptée.

### D44. Pause jusqu'au prochain minuit local ; levée automatique
`User.botPausedUntil` = premier instant du jour local suivant ; `TradingControlService.status()` la lit déjà (`PAUSED_DAILY_LOSS`). Il n'y a **pas** de bouton « reprendre » : contourner la limite le jour même irait contre son objet (le kill switch et le retour en PAPER restent disponibles). Pas de re-déclenchement ni de nouvel audit si la pause est déjà active.
`local-day.ts` calcule la date locale et le prochain minuit avec `Intl` : jours de 23 h et 25 h (changement d'heure), fuseaux à demi-heure (Inde) ou +14 h (Kiritimati) sont testés ; une année entière est balayée pour six fuseaux. Les `Intl.DateTimeFormat` sont mis en cache par fuseau (leur création coûte environ 1 ms).

### D45. On ne conclut jamais sur des prix incomplets
Source de prix injoignable, prix manquant pour une position actuelle ou d'ouverture → résultat `no_prices`, **aucun instantané partiel, aucune pause** (applique D38). Portefeuille vide → rien à surveiller.

### D46. L'alerte critique est reportée au module de notifications *(résolu à l'étape 7, D54)*
Le centre de notifications (module 3 de la SPEC) n'existait pas encore. La pause écrit l'audit `risk.daily_loss_paused` (valeur d'ouverture, valeur courante, perte en %, seuil, fin de pause) et un log d'avertissement ; un `TODO` marque le point où brancher l'alerte critique, qui devra passer **même en Mode Nuit** (SPEC 3).

### D47. Pas de Redis dans les tests ; vérification sur un vrai Redis *(variable renommée `BACKGROUND_JOBS_ENABLED` à l'étape 8, D58)*
Les tests n'ouvrent jamais de connexion Redis : `RISK_MONITOR_ENABLED=false` est posé par la configuration Vitest et le module ne s'enregistre pas (`RiskMonitorModule.register()`). Le câblage réel a été vérifié à part, sur une **base PostgreSQL temporaire** et la base Redis n° 9 (toutes deux supprimées ensuite) : démarrage, programmation du job, création de l'instantané avec les vrais prix de Binance, pause simulée par une valeur d'ouverture gonflée, absence de doublon au passage suivant. C'est cette vérification qui a révélé le défaut de D40.
Le délai par défaut des tests **unitaires** passe aussi à 20 s (comme l'e2e, D31) : les tests de services enchaînent des hachages argon2 pendant que les fichiers tournent en parallèle.

---

## Étape 7 — Centre de notifications (cœur)

### D48. Le module 3 de la SPEC est livré en deux étapes
Étape 7 : pipeline de notification, Mode Nuit, boîte de réception, configuration des alertes, alerte critique de la perte journalière. Étape 8 : **moteur d'évaluation des alertes** (prix, historique via l'API publique de Binance) et **rapport du matin de 08:00**, qui reprend les notifications mises en attente. Raison : un seul lot dépassait ce qui se relit et se vérifie sereinement.

### D49. Une notification = un événement, qui sert aussi de boîte de réception
Table `Notification` : titre, texte, `critical`, `status` (`HELD` ou `DISPATCHED`), `deliveries` (JSON : résultat par canal), `readAt`. On stocke **un événement par ligne**, pas une ligne par canal : la boîte de réception n'affiche pas le même message trois fois, et le détail de livraison reste lisible par canal. Une notification est toujours enregistrée, même si aucun canal n'est activé ou si tous échouent.
`dedupeKey` (optionnel, unique par utilisateur, `NULL` autorisé en double) évite les doublons d'un même événement ; deux appels simultanés avec la même clé sont départagés par la contrainte unique (le perdant renvoie l'existant).

### D50. Mode Nuit : calcul pur, fuseau de l'utilisateur, les critiques passent toujours
`isInNightWindow` compare la minute locale à la plage : début inclus, fin exclue, plage pouvant passer minuit (22:00 → 07:00). Début = fin est une plage **vide** (jamais « nuit ») et l'API la refuse quand le Mode Nuit est actif. Une notification **critique** passe toujours (SPEC 3) ; `immediate` (message de test) contourne le Mode Nuit **sans** être marquée critique. Pendant la nuit, une notification non critique est `HELD` : enregistrée, non envoyée, destinée au rapport du matin (étape 8). Les heures sont des minutes depuis minuit local (D1) ; `local-day.ts` passe dans `src/common/` pour être partagé avec la surveillance de la perte journalière.

### D51. Canaux : Telegram réel ; Push et Email non disponibles sans dépendance
Un `ChannelSender` par canal. **Telegram** (API Bot, `fetch`, aucune dépendance) est réel : le jeton `TELEGRAM_BOT_TOKEN` est dans l'URL, donc il n'est jamais journalisé ni renvoyé, et toute erreur réseau (dont le message peut contenir l'URL) est réduite à un code (`telegram_unreachable`, `telegram_http_<statut>`, `telegram_not_configured`, `telegram_no_chat`). **Push** (Web Push) et **Email** (SMTP) exigeraient `web-push` et `nodemailer`, hors de la stack de la SPEC : l'envoi est marqué `FAILED: channel_not_implemented`, visible dans `deliveries`, plutôt qu'ignoré en silence. Un envoyeur ne lève jamais ; s'il le fait, seul le nom de l'erreur est gardé (`sender_error`).
**Conséquence à connaître :** Push est activé par défaut mais sans envoyeur, donc tant que Telegram n'est pas configuré (ou Push/Email implémentés), **une alerte critique n'atteint l'utilisateur que dans la boîte de réception** ; le service journalise un avertissement quand une notification critique n'est livrée sur aucun canal.
*À proposer à l'utilisateur :* `web-push` (VAPID) et `nodemailer`, ou un fournisseur d'email par HTTP.

### D52. Réglages : validation stricte, audit sans valeurs
`PATCH /api/notifications/settings` est partiel ; `null` efface `telegramChatId` et `notificationEmail`. Refus 422 : plage de Mode Nuit vide ; Telegram activé sans conversation (et retrait de la conversation pendant qu'il est actif). L'audit `notification_settings.updated` ne garde que le **nom des champs** modifiés, jamais leur valeur (identifiant Telegram, adresse). `pushSubscription` n'est pas exposé : il viendra avec l'envoyeur Push. Le message de test (`POST /api/notifications/test`, 3 par minute) vérifie la configuration de bout en bout.

### D53. Alertes : CRUD cohérent avec la maquette, évaluation reportée
Règles par condition : franchissement de prix → symbole requis, **pas de fenêtre** ; variation en % → symbole et fenêtre (5 à 10 080 minutes) requis ; portefeuille → **pas de symbole**, fenêtre requise ; baisse ≤ 100 %, hausse ≤ 1 000 %. Seuils en chaînes décimales (D34). 50 alertes au plus par utilisateur (borne le travail du moteur). La condition et le symbole ne se modifient pas (on crée une autre alerte) ; le reste se modifie, cohérence revérifiée à chaque modification. Les alertes sont enregistrées mais **pas encore évaluées** (étape 8).

### D54. L'alerte de perte journalière est branchée, et ne peut pas défaire la pause
La pause envoie une notification **critique** « Perte journalière maximale atteinte » (perte, seuil, fin de pause) avec la clé `daily-loss:<jour local>`. Elle est envoyée **après** l'enregistrement de la pause et de l'audit : si l'envoi échoue, l'erreur est journalisée (nom seulement) et la pause reste en place. Solde D46.

### D55. Vérification sur le vrai PostgreSQL et le vrai Redis
Comme à l'étape 6 (D47), l'application a été lancée sur une base temporaire et la base Redis n° 9 : réglages, quatre alertes de la maquette, message de test, puis perte simulée → notification critique unique dans la boîte de réception, lecture groupée. Les tests sur base en mémoire ne voient pas le SQL réel (types JSON, contrainte unique avec `NULL`, comptages).
*Limite de la pagination :* `before` compare les dates de création (précision à la milliseconde) ; deux notifications créées dans la même milliseconde pourraient être sautées à la frontière d'une page. Négligeable ici, à revoir si le volume augmente.

---

## Étape 8 — Moteur d'évaluation des alertes

### D56. Plan du module 3 remanié : trois étapes
Étape 7 : cœur des notifications. **Étape 8 : moteur d'évaluation des alertes.** Étape 9 : rapport du matin (digest) de 08:00, qui reprend les notifications `HELD` et solde D48.

### D57. Une alerte notifie au franchissement, pas à chaque passage
Colonne `AlertConfig.isTriggered` (migration `add_alert_triggered_state`) : l'alerte notifie quand sa condition **devient vraie**, reste silencieuse tant qu'elle est vraie, et **se ré-arme** quand elle redevient fausse. Sans cet état, une alerte « ETH franchit 3 500 $ » enverrait un message par minute.
- **Prise d'état atomique** : `UPDATE … WHERE id = … AND isTriggered = false` ; si deux évaluations se croisent, une seule obtient la ligne et notifie.
- **Échec d'envoi** : l'état est rendu (`isTriggered = false`, `lastTriggeredAt` d'origine) et l'erreur comptée ; le passage suivant réessaie au lieu de perdre l'alerte.
- **Anti-rebond de 15 minutes** entre deux déclenchements : un prix qui oscille autour du seuil ne spamme pas. Un franchissement retenu n'est pas perdu : si la condition est toujours vraie après le délai, l'alerte notifie.
- **Modifier le seuil, la fenêtre ou `isActive` ré-arme** l'alerte (l'ancien état ne vaut plus) ; modifier le canal ou la criticité, non. `AlertDto` expose `isTriggered` (armée / déclenchée).

### D58. Jobs de fond : une connexion partagée, une variable pour tous
`QueueModule` porte l'unique `BullModule.forRoot` et le client Redis (déplacé dans `src/queue/`) ; les modules de jobs ne déclarent plus que leur file. `RISK_MONITOR_ENABLED` devient **`BACKGROUND_JOBS_ENABLED`** et désactive *tous* les jobs (perte journalière, alertes) sans ouvrir de connexion Redis ; Vitest la pose à `false`.

### D59. Historique de prix : bougies d'une minute de l'API publique de Binance, sans stockage
`PriceProvider.getPriceAt(symbole, instant)` lit l'ouverture de la bougie `1m` de la paire `<SYMBOLE>USDT` (`/api/v3/klines`, sans clé). Pas de table d'historique à maintenir : la fenêtre (de 5 minutes à 7 jours) se lit à la demande. L'instant est arrondi à la minute ; cache de 5 minutes (500 entrées au plus), l'absence de donnée est aussi mise en cache.
- Paire inconnue (`-1121`) → `null` (« pas de prix », pas une panne). Panne, 418/429, réponse inattendue → `PriceUnavailableError`.
- **Actif pas encore coté à la date demandée** : Binance renvoie la première bougie *après* `startTime` ; si elle est à plus de 5 minutes de la date, on renvoie `null` plutôt que de prendre un prix qui n'est pas celui de la date.

### D60. On ne conclut pas sur des données manquantes
`conditionMet` renvoie `null` quand un prix manque (courant ou passé, ou prix passé nul) : **l'état de l'alerte n'est alors pas modifié** (ni déclenchement, ni ré-armement), et le passage compte l'alerte comme ignorée. Prix courants injoignables : tout est ignoré. Historique injoignable : seules les alertes à fenêtre sont ignorées. Applique D38 et D45. Seuil atteint = condition remplie (égalité incluse).

### D61. Variations et portefeuille
Variation = `(courant − passé) / passé × 100`, en `Decimal`. `PORTFOLIO_DROP_PCT` compare la valeur des **positions actuelles** aux prix passés à leur valeur aux prix courants (mouvement de marché, comme D43) ; une position sans prix courant ou passé fait ignorer l'alerte, un portefeuille vide aussi. Les prix passés sont partagés entre alertes du même (symbole, fenêtre) pendant un passage.

### D62. Le canal de l'alerte est respecté ; le Mode Nuit aussi
`NotifyInput.channel` impose le canal (maquette : un canal par alerte) : la notification n'est envoyée que sur celui-là, **sans tenir compte des canaux activés globalement** ; si le canal échoue (conversation Telegram manquante), l'échec est enregistré, on ne bascule pas sur un autre. Le Mode Nuit reste appliqué selon `isCritical` : une alerte non critique la nuit est mise en attente pour le rapport du matin.

### D63. Messages : petits nombres lisibles
Même tournure que les alertes de la maquette (« BTC −5 % en 1 h », « ETH franchit 3 500 $ à la hausse », « Portefeuille −10 % sur 7 jours »). **Défaut trouvé par la vérification sur le vrai système :** un seuil de 0,0001 % s'affichait « +0 % » (arrondi à 2 décimales). En dessous de 1, le formatage garde 4 chiffres significatifs (`0,0001 %`, `0,00001234 $`). Les espaces insécables du formatage français sont remplacés par des espaces simples (Telegram, journaux).

### D64. Vérification sur le vrai PostgreSQL, Redis et Binance
Comme aux étapes 6 et 7 : base temporaire et Redis n° 9, cours et historique réels de Binance. Constaté : l'historique est bien lu (alerte de hausse sur 1 h déclenchée avec la variation réelle), aucun doublon au passage suivant, ré-armement par modification du seuil, anti-rebond respecté.
*Non couvert par cette vérification :* l'alerte de portefeuille (le marché n'avait pas baissé) et le déclenchement d'une alerte de baisse ; ils sont couverts par les tests unitaires.

---

## Étape 9 — Rapport du matin

Solde D48 et D56 : le module 3 de la SPEC est complet (notifications, Mode Nuit, alertes configurables et évaluées, rapport du matin).

### D65. Un rapport par jour local et par utilisateur, généré à l'heure choisie
Un job BullMQ toutes les 5 minutes (`DigestEngineModule`) parcourt les utilisateurs ; pour chacun, si le rapport est activé et si l'heure locale a atteint `digestMinute` (08:00 par défaut) sans qu'un rapport existe pour ce jour local, il le génère. La contrainte unique `(userId, period, periodStart)` rend la génération idempotente ; `periodStart` est le **début du jour local** (`startOfLocalDay`, qui gère les jours de 23 h et 25 h). Deux passages simultanés ne créent qu'un rapport et n'envoient qu'un message (le perdant reçoit l'erreur d'unicité et s'arrête).

### D66. Fenêtre de rattrapage de 6 heures
Si l'application était arrêtée à l'heure du rapport, elle rattrape jusqu'à 6 h plus tard ; au-delà, **la journée est abandonnée** : un rapport « du matin » délivré le soir serait trompeur. (Limite : la fenêtre ne passe pas minuit ; un rapport réglé à 23:00 n'a que 60 minutes.)

### D67. Deux périodes générées : `TODAY` chaque jour, `WEEK` le lundi
`TODAY` couvre 24 h, `WEEK` 7 jours (généré en plus le lundi local). « Hier » de la maquette n'a pas de valeur propre : c'est le rapport `TODAY` de la veille, donc **`DigestPeriod.YESTERDAY` reste inutilisé** (laissé dans l'enum pour ne pas migrer). `WEEK` ne reprend pas les notifications en attente (déjà prises par le rapport du jour : pas de double compte). Si le rapport du jour existe mais pas celui de la semaine un lundi, le suivant le complète.

### D68. Texte déterministe et sobre : il constate, il ne conseille pas
Pas d'IA ni de conseil d'investissement : `buildDigest` assemble des phrases à partir de faits (variation du portefeuille, alertes critiques, alertes regroupées), dans le ton de la maquette. « Nuit calme » seulement s'il n'y a aucune alerte critique et une variation de moins de 3 % ; « stable » sous 0,1 % ; « Aucune action requise » seulement sans alerte critique, sinon « Consultez vos alertes critiques ». Les listes sont bornées (5 alertes regroupées, 3 critiques) avec un compteur du reste. Fonction pure, testée sur tous ces seuils.

### D69. Variation du portefeuille : mouvement de marché des positions actuelles
Valeur des **positions actuelles** aux prix du début de période (`getPriceAt`, D59) comparée à leur valeur aux prix courants : comme D43 et D61, un achat, une vente ou un retrait déclaré n'y compte pas. La plus forte hausse et la plus forte baisse par position sont listées (seulement si elles ont le bon signe), arrondies à 2 décimales comme la synthèse sauf si l'arrondi effacerait un mouvement non nul. Une position sans prix, courant ou passé, rend la **valeur non calculable** : le rapport le dit (« La valeur du portefeuille n'a pas pu être calculée ») plutôt que d'inventer un total partiel (D38, D45, D60).

### D70. Prix indisponibles : on réessaie une heure, puis on génère sans chiffres
Source de prix injoignable : le rapport n'est **pas** enregistré pendant la première heure (nouvel essai au tour suivant) ; passé ce délai, il est généré sans les chiffres du portefeuille plutôt que pas du tout. Un rapport enregistré est définitif (contrainte unique) : d'où l'attente avant de se contenter d'un rapport partiel.

### D71. Les notifications en attente sont reprises et tracées
`NotificationStatus.DIGESTED` et `Notification.digestId` (migration `add_digest_link`) : les notifications `HELD` de la nuit sont marquées reprises et pointent vers leur rapport. **Seules celles lues au début du passage** sont marquées (par identifiants) : une notification arrivée pendant la génération reste `HELD` pour le rapport suivant au lieu d'être marquée sans avoir été incluse. En cas de plantage entre l'enregistrement du rapport et le marquage, elles seront reprises le lendemain (au moins une fois, jamais perdues).

### D72. Le rapport est aussi envoyé, en notification immédiate
Le rapport est annoncé par une notification « Rapport du matin » (ou « de la semaine ») sur les canaux activés : `immediate` (hors Mode Nuit : c'est le but), non critique, avec la clé `digest:<période>:<jour local>`. Le rapport est enregistré **avant** l'envoi ; un échec d'envoi est journalisé (nom de l'erreur seulement) et ne le défait pas. Les mêmes limites de canaux qu'en D51 s'appliquent (Push et Email non disponibles).

### D73. API de consultation, sans génération à la demande
`GET /api/digests` (filtre `period`, pagination par date de génération, `unreadCount`), `GET /api/digests/:id`, `POST /api/digests/:id/read` (idempotent), isolés par utilisateur. Pas de route pour générer un rapport : la génération n'a lieu que via le job, ce qui évite de contourner l'idempotence et de multiplier les appels de prix.

### D74. Vérification sur le vrai PostgreSQL, Redis et Binance
Comme aux étapes 6 à 8 : base temporaire, Redis n° 9, historique réel de Binance. Constaté : une alerte non critique pendant la plage de nuit est mise en attente ; le rapport la reprend (`HELD` → `DIGESTED`, `digestId` renseigné), contient la vraie variation sur 24 h, est annoncé en notification immédiate, n'est pas dupliqué au passage suivant, et se marque lu. Cette vérification a révélé un détail d'affichage (mouvement affiché « −0,1199 % » contre « 0,12 % » dans la synthèse), corrigé.
*Non couvert par la vérification manuelle :* le rapport hebdomadaire (la vérification n'était pas un lundi) ; il est couvert par les tests unitaires, y compris sur le calcul du jour de la semaine local.

---

## Étape 10 — Exécution des ordres

### D75. Le module d'ordres est livré en deux étapes ; `ccxt` ajouté
Étape 10 : **exécution** (cette étape). Étape 11 : **consommation des signaux** du moteur (Redis Stream `signals`), avec la définition de leur format dans `docs/SPEC.md` (le moteur `crypto-engine` n'émet encore rien et la SPEC ne définit pas ce format). `ccxt` est dans la stack de la SPEC (section B) : seule dépendance ajoutée, utilisée uniquement dans `CcxtGateway`.

### D76. Un point d'entrée unique : `OrdersService.submit(userId, intent)`
L'API manuelle, le futur consommateur de signaux et la surveillance des stop-loss / take-profit construisent tous une `OrderIntent` (symbole, sens, quantité, origine) et passent par les **mêmes garde-fous**. Origines : `MANUAL`, `SIGNAL`, `STOP_LOSS`, `TAKE_PROFIT`. Un ordre refusé n'est jamais perdu en silence : il est enregistré (`REJECTED`) avec un **code de motif stable** (`failureReason`, voir `REJECTION_MESSAGES`) et audité.

### D77. Garde-fous, dans l'ordre
1. **Mode** : un ordre manuel est refusé en LIVE (D83). 2. **Symbole** : les stablecoins ne se négocient pas (pas de paire `USDT/USDT`). 3. **Robot actif** : kill switch ou pause pour perte journalière (`TradingControlService.status`), **y compris pour les ventes**. 4. **Vente** : quantité détenue suffisante. 5. **Achat** : prix disponible ; **capital total calculable** (sinon `capital_unknown` : jamais d'ordre à l'aveugle, D38) ; capital nul → `insufficient_funds` (plus clair qu'« exposition dépassée ») ; **exposition maximale** : (position déjà détenue + cet achat) × prix ≤ `maxExposurePct` × capital (SPEC module 2, égalité autorisée) ; **fonds** en PAPER seulement (l'achat est payé avec l'USDT déclaré, frais compris) — en LIVE, la plateforme fait foi.
Les garde-fous sont **revérifiés au moment d'agir** (D79) : le kill switch ou le mode ont pu changer entre la création et l'exécution.

### D78. `clientOrderId` idempotent : un retry ne double jamais un ordre
Généré **avant** tout appel (`vl-` + 32 hexadécimaux = 35 caractères, limite Binance 36), conservé pour tous les essais, unique en base, et utilisé comme `jobId` BullMQ (le même ordre ne peut pas être mis en file deux fois). Surtout : **avant chaque création, on cherche l'ordre par son `clientOrderId`** sur la plateforme. Le cas dangereux est celui où l'ordre est créé mais la réponse se perd (erreur réseau) : au retry, l'ordre est retrouvé et réconcilié, pas recréé. Testé explicitement (réponse perdue → un seul ordre sur la plateforme).

### D79. États, prise atomique et reprise
`PENDING` → `SUBMITTED` par `UPDATE … WHERE status = 'PENDING'` : deux exécutions simultanées ne passent qu'un ordre. Un ordre **déjà `SUBMITTED` n'est jamais abandonné** par un garde-fou (kill switch, pause) : il est parti, il doit se terminer ou se réconcilier. Une exécution déjà enregistrée n'est appliquée au portefeuille qu'une fois (mise à jour conditionnelle sur le statut).
**Dernier essai épuisé (`giveUp`)** : un ordre qui n'a jamais atteint la plateforme passe en `FAILED` (`retries_exhausted`) ; un ordre **LIVE peut être parti sans qu'on le sache** : il reste en l'état (pas `FAILED`, ce serait mentir), l'audit `order.unsettled` est écrit et l'utilisateur est prévenu **en critique** de le vérifier sur sa plateforme, avec son `clientOrderId`.

### D80. File BullMQ `orders`, exécution immédiate si les jobs sont désactivés
5 essais, délai exponentiel (2 s, 4 s, 8 s, 16 s), `concurrency: 1` (jamais deux ordres en parallèle). Une erreur transitoire (`RetryableOrderError` : prix, plateforme, ordre pas encore soldé) fait réessayer ; le dernier essai épuisé appelle `giveUp`. Avec `BACKGROUND_JOBS_ENABLED=false` (tests, instance sans jobs), l'ordre est exécuté **dans la requête**, sans nouvel essai : une erreur transitoire abandonne alors l'ordre proprement.

### D81. PAPER : simulateur, frais de 0,1 %, et le portefeuille reste cohérent
Exécution au prix courant, frais fictifs de 0,1 % (comme un ordre au marché standard). Chaque exécution met à jour le portefeuille déclaré avec **deux jambes** : l'actif échangé **et l'USDT** ; sans la contrepartie en USDT, le capital gonflerait à chaque achat (et l'exposition maximale n'aurait aucun sens). Conséquence pratique : **il faut déclarer son capital en USDT** (`PUT /api/portfolio/assets/USDT`) avant de pouvoir acheter en PAPER. Les jambes sont plafonnées à ce qui est détenu. Un échec de mise à jour du portefeuille est journalisé sans défaire l'ordre ; en cas de plantage entre l'enregistrement de l'exécution et la mise à jour du portefeuille, celle-ci est perdue (au plus une fois, jamais deux : choix assumé, l'audit garde la trace de l'exécution).

### D82. LIVE : `ExchangeGateway`, clés déchiffrées à chaque ordre
Le module d'ordres est le seul à déchiffrer les clés, via `ExchangesService.getLiveCredentials`, **à chaque ordre** : l'éligibilité (active, vérifiée, hors testnet) est revérifiée à chaque fois, ce qui solde la limite de D28. `ExchangeGateway` est une classe abstraite (jeton d'injection) ; `CcxtGateway` l'implémente.
- **Erreurs réduites à un code** : les messages de `ccxt` peuvent citer une URL ou une réponse ; seul le nom de l'erreur est gardé. Refus définitif (`GatewayRejectedError` : fonds insuffisants, ordre invalide, clé refusée, paire inconnue, sous le minimum) ou panne transitoire (`GatewayUnavailableError` : réseau, délai, limite de débit, erreur inconnue → on réessaie).
- **Marchés** (précisions, minimums) : chargés avec une instance **sans clés** (données publiques), mis en cache 1 h. Défaut trouvé par la vérification réelle : avec des clés, `ccxt` ajoute un appel signé au chargement ; s'il échoue (clé refusée), il masquait tous les autres contrôles. La quantité est arrondie à la précision de la paire ; un arrondi à zéro ou sous le minimum donne `below_minimum` avant tout envoi.
- **Exécution partielle** : seule la part nouvellement exécutée est appliquée au portefeuille ; un ordre encore ouvert fait réessayer (réconciliation par recherche du `clientOrderId`) ; annulé après une exécution partielle → `PARTIALLY_FILLED` soldé.
- **Frais** : en USDT, déduits de la jambe USDT ; dans l'actif de base, déduits de la quantité reçue ; dans une autre devise (BNB…), enregistrés sur l'ordre sans effet sur le portefeuille. En LIVE, la plateforme fait foi : une jambe est plafonnée à ce qui est détenu côté portefeuille déclaré.

### D83. Les ordres manuels sont réservés au mode PAPER
`POST /api/orders` refuse en LIVE (`manual_orders_paper_only`, 422, ordre enregistré) tant que le consommateur de signaux n'existe pas : le seul moyen de mettre de l'argent réel en jeu doit être le robot, après gestion des risques. À rouvrir explicitement si besoin.

### D84. Stop-loss et take-profit : programmés à l'exécution, surveillés à la minute
À l'exécution d'un achat, les deux niveaux sont calculés sur le **prix moyen exécuté** avec les réglages de l'utilisateur et enregistrés sur l'ordre. Un job (`order-exits`, chaque minute) compare le prix courant aux niveaux des positions ouvertes (`exitTriggeredAt` nul) et vend la quantité de l'entrée par `submit` (mêmes garde-fous). **Aucun ordre « stop » n'est posé sur la plateforme** : la protection est celle d'un contrôle par minute, tant que l'application tourne et que la source de prix répond.
- **Robot arrêté ou en pause** : aucune vente, **y compris une sortie** (le kill switch est un arrêt explicite). Le déclenchement n'est pas consommé (il repart dès que le robot repart) et l'utilisateur est prévenu **en critique**, une fois par jour. *Risque assumé et documenté : une position peut rester sans protection tant que le robot est arrêté.*
- **Prise atomique** de la position (`exitTriggeredAt`) : une position ne déclenche qu'une sortie, même si deux passages se croisent. Quantité vendue = `min(quantité de l'entrée, quantité détenue)` ; rien à vendre (vente manuelle entre-temps) → déclenchement consommé, audit `order.exit_skipped`.
- **Sortie refusée** (ex. plus d'échange éligible en LIVE) : le déclenchement reste consommé (pas de boucle d'ordres refusés chaque minute) et l'utilisateur est prévenu en critique.
- Prix indisponible ou manquant : on ne conclut pas (D38, D45, D60).

### D85. Annulation : seulement avant la prise en charge
`POST /api/orders/:id/cancel` n'annule qu'un ordre `PENDING` (mise à jour conditionnelle) ; un ordre au marché déjà parti ne s'annule pas (409). L'exécuteur ne reprend jamais un ordre annulé.

### D86. Notifications des ordres
Exécution : « Ordre exécuté » (non critique, donc retenue la nuit) ; **stop-loss exécuté : critique** (SPEC 3) ; take-profit exécuté : non critique ; refus en LIVE ou d'une sortie, ordre abandonné, ordre à vérifier : **critique**. Un refus d'ordre manuel en PAPER ne notifie pas (la réponse 422 le dit). Clés de déduplication par ordre ; un échec de notification ne défait jamais un ordre.

### D87. Vérification sur le vrai système (PostgreSQL, Redis, Binance, `ccxt`)
Comme aux étapes 6 à 9, plus le vrai `ccxt` avec de **fausses clés** (aucun fonds, aucun ordre possible). Constaté : achat PAPER passé par la file BullMQ avec les vrais cours (réponse immédiate `PENDING`, puis `FILLED` par le worker, frais, stop-loss et take-profit, portefeuille cohérent) ; refus d'exposition ; sortie stop-loss déclenchée par le job, notifiée en critique, un seul déclenchement ; refus du kill switch ; audit cohérent. Vrai `ccxt` : clé refusée → `exchange_auth`, aucune clé dans l'erreur ; paire inconnue → `invalid_symbol` ; sous le minimum → `below_minimum`. **Défauts trouvés** : chargement des marchés avec clés qui masquait les contrôles (corrigé, D82) ; `InvalidOrder` de l'arrondi qui sortait en `invalid_order` au lieu de `below_minimum` (corrigé).
*Non couvert :* **aucun ordre LIVE réel n'a été passé** (ni testnet, ni clé réelle) ; la chaîne LIVE est couverte par des tests avec une fausse plateforme et par la vérification des erreurs réelles ci-dessus. **Avant tout usage LIVE réel : un essai sur le testnet Binance avec une clé dédiée.**

---

## Étape 11 — Consommation des signaux

### D88. Le contrat des signaux est dans `docs/SPEC.md` (section 7), source de vérité pour le moteur
Redis Stream `signals`, un seul champ `data` contenant du JSON v1 : `v`, `id`, `ts`, `symbol`, `action` (`BUY` / `SELL` / `HOLD`), `score` (0 à 1), puis `price`, `reason`, `indicators` facultatifs. Validation **stricte** (`parseSignal`) : un message ambigu est refusé plutôt que deviné, car un signal sert à passer des ordres. Champs inconnus ignorés (évolution compatible), version inconnue refusée, `ts` à plus de 60 s dans le futur refusé, message de plus de 8 Ko refusé (mesuré en octets). Aucune dépendance : validation écrite à la main, testée sur chaque règle.
*Le moteur Python n'émet encore rien* : cette étape ne touche pas `crypto-engine`, elle fixe le contrat et fournit un outil d'essai (`npm run signals:publish`).

### D89. Consommateur : groupe `api`, acquittement après traitement, reprise, abandon
`SignalConsumer` lit avec `XREADGROUP` (groupe créé **depuis le début** du stream : les signaux publiés avant le premier démarrage sont traités, les périmés ignorés) sur une **connexion dédiée** (un `BLOCK` paralyserait la connexion partagée de BullMQ).
- Acquittement **après** traitement : au moins une fois ; la déduplication (D93) rend un retraitement inoffensif.
- Message invalide → `signals:dead` (motif, identifiant, début du contenu) puis acquittement, **sans nouvel essai** : un message corrompu ne boucle jamais.
- Traitement à retenter (prix indisponible, erreur) → reste en attente ; `XAUTOCLAIM` le reprend après 60 s d'inactivité (plantage compris) ; après **5 livraisons** → `signals:dead` (`handler_failed`).
- Une pause de 50 ms après un passage vide : si Redis répondait instantanément à vide, la boucle ne doit jamais tourner à 100 % du processeur (un test l'a rendu visible en saturant la mémoire).

### D90. Réglages : seuil, péremption, écart de prix
`SIGNAL_MIN_SCORE` (0,6), `SIGNAL_MAX_AGE_SECONDS` (300), `SIGNAL_MAX_PRICE_DRIFT_PCT` (2) ; une valeur absente, non numérique ou hors limites donne le défaut. Un signal périmé est ignoré (son prix n'est plus valable) ; un **achat** est ignoré si le prix a bougé de plus de 2 % depuis l'analyse (on ne court pas après le marché) ; une **vente** n'est pas soumise à l'écart (on ne bloque pas une sortie). Le seuil s'applique aux deux sens. À terme, ces réglages pourraient devenir des réglages par utilisateur.

### D91. Dimensionnement : la place disponible, proportionnelle au score
Achat = (plafond d'exposition × capital − position déjà détenue) × score ÷ prix, **arrondi à la baisse** à 8 décimales (`sizeBuy`, fonction pure en `Decimal`) : l'arrondi ne peut jamais faire dépasser le plafond, ce qu'un test vérifie sur des centaines de combinaisons. Position déjà au plafond → aucun ordre. Le garde-fou d'exposition des ordres le revérifie de toute façon. **Vente = toute la position détenue** du symbole.
*À savoir :* la position est celle du portefeuille **déclaré** : un signal `SELL` vend aussi ce que l'utilisateur a déclaré avoir acheté lui-même.

### D92. Un signal vaut pour tous les utilisateurs actifs, sans option supplémentaire
Le signal ne vise personne : chaque utilisateur actif passe par `OrdersService.submit`, donc par **les mêmes garde-fous que tout ordre** (kill switch, pause, exposition, fonds, mode PAPER ou LIVE). Le mode LIVE reste le seul opt-in (explicite, audité, avec mot de passe, D28) ; ajouter une option « trading automatique » dédiée n'apporterait rien tant que le client est seul. Différence avec un ordre manuel : quand le robot est **arrêté ou en pause**, le signal est simplement ignoré (`robot_blocked`) au lieu d'être enregistré en `REJECTED` : un signal n'est pas une intention de l'utilisateur, et un kill switch de plusieurs jours produirait un journal de refus sans intérêt. Les autres refus (fonds insuffisants…) sont enregistrés avec leur motif.

### D93. Déduplication garantie par la base : unique `(userId, signalStreamId)`
L'identifiant du signal (champ `id` du moteur) est stocké dans `TradeLog.signalStreamId` ; l'entrée du stream est conservée dans `signalPayload.streamEntryId` avec tout le contenu du signal (traçabilité signal → ordre). Une vérification préalable évite le travail inutile, mais **ne suffit pas** : deux traitements simultanés du même signal lisent tous deux « pas encore d'ordre ». La protection est une **contrainte unique en base** (migration `unique_signal_per_user`, remplace l'index simple) : le second `INSERT` échoue (`DuplicateOrderError`), avant tout envoi, et est compté « duplicate ». *Faille trouvée par un test que j'avais d'abord écrit trop faiblement.* Un signal traité deux fois (reprise après plantage, republication par le moteur) ne repasse donc jamais d'ordre, et le même signal reste distinct d'un utilisateur à l'autre.

### D94. Ce qui se retente et ce qui ne se retente pas
Retenté : **prix indisponible** (source injoignable, symbole sans prix) et toute **erreur inattendue** chez un utilisateur (le signal reste en attente ; les utilisateurs déjà servis sont protégés par D93, seul celui qui manque est traité). Non retenté (le résultat serait le même) : score sous le seuil, périmé, `HOLD`, stablecoin, écart de prix, position au plafond, quantité trop petite, **capital non calculable** (un prix manque : on ne passe pas d'ordre à l'aveugle, D38).

### D95. Vérification sur le vrai Redis (Streams), PostgreSQL et prix de Binance
Comme aux étapes 6 à 10 : base temporaire, Redis n° 9, application complète. Constaté : achat PAPER proportionnel au score avec stop-loss programmé et signal tracé ; republication du même `id` sans effet ; `HOLD`, score trop bas et signal périmé ignorés ; messages invalides dans `signals:dead` ; vente de toute la position ; kill switch respecté ; groupe de consommateurs sans message en attente ni retard ; signal publié application arrêtée traité **une seule fois** au redémarrage.
**Défaut trouvé par cette vérification, invisible aux tests unitaires :** `ioredis` 6 négocie **RESP3** par défaut ; dans ce protocole `XREADGROUP` renvoie une table que `call` aplatit en `[flux, entrées, …]`, alors que le code attendait les tableaux imbriqués de RESP2. L'analyse plantait (`TypeError`) à chaque message : les signaux n'étaient traités qu'environ une minute plus tard, par la reprise automatique. Les deux formes sont maintenant acceptées et testées (forme réellement observée sur Redis 8).
*Non couvert :* aucun signal réel du moteur (il n'en émet pas) ; le chemin LIVE reste celui de D87 (aucun ordre réel passé).

### D96. Limites
Pas de réponse au moteur (il ne sait pas ce qu'il est advenu d'un signal) ; pas de réglage du seuil par utilisateur ; un seul groupe de consommateurs (`api`), plusieurs instances de l'API se partagent les messages mais chaque message n'est traité que par une ; les messages en attente sont repris après 60 s, donc un signal retenté a un délai minimal d'une minute (la péremption de 5 minutes borne les reprises utiles).

## Étape 12 — WebSocket vers le front

### D97. Dépendances : `@nestjs/websockets`, `@nestjs/platform-ws` et `ws` (validées par « fait pour le mieux »)
`ws` est la bibliothèque WebSocket de référence de Node, et `@nestjs/platform-ws` est l'adaptateur officiel de Nest pour elle. Je n'ai pas retenu socket.io : il impose un client dédié côté front (`socket.io-client`), un protocole propre (sondage HTTP puis montée en WebSocket) et plus de code à sécuriser, pour des fonctions (salles, reconnexion automatique) dont on n'a pas besoin ici. Le front utilise le `WebSocket` natif du navigateur.
Prérequis à connaître : l'adaptateur doit être déclaré (`app.useWebSocketAdapter(new WsAdapter(app))`) dans `main.ts` **et dans chaque test e2e** ; sans lui, Nest arrête le processus dès qu'une passerelle existe.

### D98. Connexion sur `/api/ws`, authentification par un premier message
- **Chemin `/api/ws`** : même préfixe que l'API, donc la même règle de proxy en production.
- **Le jeton n'est pas dans l'URL.** Un navigateur ne peut pas poser d'en-tête `Authorization` sur un WebSocket ; mettre le jeton dans l'URL le ferait finir dans les journaux des proxys. Le client envoie donc `{"event":"auth","data":{"token":"…"}}` comme **premier message**, et sans lui la connexion est fermée au bout de 5 s (code 4408).
- **Mêmes règles que l'API HTTP** : jeton d'accès signé valide et compte non désactivé (relu en base, donc un compte désactivé perd l'accès tout de suite).
- **Expiration** : le jeton d'accès vit 15 minutes ; à l'échéance la connexion est coupée (4401 `token_expired`). Le client peut aussi renvoyer un message `auth` avec un jeton rafraîchi **avant** l'échéance pour la prolonger sans se reconnecter ; un jeton d'un autre utilisateur sur la même connexion est refusé.
- **Passerelle `@Public()` et `@SkipThrottle()`** : les gardes HTTP globales (en-tête `Authorization`, limitation par IP) ne s'appliquent pas à une connexion WebSocket et planteraient dessus ; l'authentification est faite par `RealtimeHub`.

### D99. Un bus interne, publication facultative et sans effet sur le métier
Les services métier publient sur un `RealtimeBus` en mémoire ; la passerelle s'y abonne. Les modules métier ne connaissent donc pas le WebSocket. Le bus est injecté avec `@Optional()` (les tests unitaires existants n'ont pas changé) et `publish` **ne lève jamais d'erreur** : une panne de diffusion ne doit jamais faire échouer un ordre, une notification ou un changement de mode. Côté exécuteur d'ordres, la lecture de l'ordre à diffuser est elle aussi protégée (`emitOrder`, best effort).
Pas de dépendance `@nestjs/event-emitter` : vingt lignes suffisent.

### D100. Trois événements : `order`, `risk`, `notification`
- **`order`** : création (`PENDING` ou `REJECTED` avec son motif), prise en charge (`SUBMITTED`), exécution (`FILLED`, `PARTIALLY_FILLED`, `CANCELLED`), refus, abandon, annulation. Le contenu est celui de `GET /api/orders/:id` (montants en chaînes décimales). L'événement d'exécution est publié **après** la mise à jour du portefeuille : un front qui relit `/api/portfolio` en réaction voit déjà le résultat.
- **`risk`** : kill switch activé ou désactivé, passage LIVE ou PAPER, pause sur perte journalière.
- **`notification`** : chaque nouvelle notification (id, titre, texte, `critical`, `status`, date), sans le détail des livraisons.
- **Pas d'événement de valorisation du portefeuille**, contrairement à ce que j'avais d'abord envisagé : rien dans l'application ne calcule la valorisation en continu (elle est calculée à la demande à partir des prix), et en pousser une toutes les N secondes demanderait un nouveau job et des appels de prix permanents pour tous les utilisateurs connectés. Le front relit `GET /api/portfolio` sur un événement `order`, ou à son rythme.

### D101. Les notifications du Mode Nuit sont aussi poussées
Une notification retenue par le Mode Nuit (`HELD`) est poussée au front avec son statut. Le Mode Nuit protège l'utilisateur des **sollicitations** (Telegram, push, email) ; or un front ouvert est un utilisateur qui regarde : lui cacher la boîte de réception serait une incohérence. Le front décide quoi afficher grâce à `status`.

### D102. Cloisonnement, limites et connexions mortes
- **Un utilisateur ne reçoit que ses événements** (registre `userId` → connexions, testé de bout en bout avec deux comptes).
- **5 connexions par utilisateur** au plus (`REALTIME_MAX_CONNECTIONS_PER_USER`), code 4429 au-delà : plusieurs onglets, pas une fuite de connexions.
- **Message client limité à 4 Ko** (`maxPayload`) : le seul message légitime est un jeton ; au-delà, la connexion est fermée (1009).
- **Ping toutes les 30 s**, connexion coupée si le pong précédent n'est pas revenu (appareil parti sans fermer).
- **Rien de sensible dans les messages** : aucune clé, aucun secret, pas de `signalPayload` ni de métadonnées internes ; on réutilise la vue d'ordre de l'API.

### D103. `toView` extrait dans son fichier (cycle d'import)
L'exécuteur d'ordres a besoin de `toView` pour diffuser ; en l'important depuis `orders.service.ts`, on créait le cycle `orders.service → order-dispatcher → order-executor → orders.service`. Résultat visible seulement à l'exécution : une dépendance injectée `undefined` (« Nest can't resolve dependencies of the InlineOrderDispatcher »), alors que `tsc` et les tests unitaires passaient. `toView` vit maintenant dans `order-view.ts`, que les deux importent.

### D104. Vérification sur l'application complète (vrai PostgreSQL, Redis, prix de Binance)
Avec `dist/main.js` (donc le vrai `main.ts`, que les tests e2e ne passent pas) et un vrai client `ws` : authentification (`ready` avec la date d'expiration) ; ordre PAPER aux prix réels → `PENDING → SUBMITTED → FILLED` avec stop-loss dans l'événement final ; kill switch → `risk`, puis ordre refusé poussé avec `kill_switch` ; notification de test poussée ; **un second utilisateur connecté ne reçoit rien** ; jeton invalide → 4401 ; aucune authentification → 4408 au bout de 5 s ; message de 10 Ko → 1009 ; l'API HTTP reste protégée (401 sans jeton, 200 avec).
*À savoir :* le message trop gros fait écrire une ligne `ERROR [WsAdapter] RangeError: Max payload size exceeded` dans les journaux (comportement de Nest, non configurable) ; une rafale de tels messages serait bruyante mais ne coûte pas de ressources, la connexion étant fermée à chaque fois.

### D105. Limites
- **Une seule instance de l'API** : le bus est en mémoire. Avec plusieurs instances, un événement n'atteindrait que les clients connectés à l'instance qui l'a produit ; il faudrait passer par Redis pub/sub.
- **Aucun rejeu** : un événement émis pendant que le client est déconnecté est perdu. **Le front doit relire l'état par l'API REST à chaque (re)connexion** (ordres, notifications, état du robot), puis s'appuyer sur les événements.
- Le WebSocket est un flux d'état, pas un canal d'alerte : il ne remplace ni Telegram, ni le push, ni l'email.
- Pas de commandes via le WebSocket (kill switch, ordres) : tout ce qui agit passe par l'API HTTP et ses gardes, d'où une seule surface à sécuriser.

---

## À prévoir (hors étapes livrées)

| Sujet | Pourquoi |
|---|---|
| Vérificateur Kraken | Débloquer la plateforme ; sinon rester sur Binance. |
| Re-vérification périodique des clés | Détecter un droit « Withdrawal » ajouté après coup, sans attendre une action manuelle. |
| Procédure de rotation de `ENCRYPTION_KEY` | `needsRotation()` existe ; il manque la tâche qui re-chiffre les lignes en version ancienne. |
| Purge des refresh tokens expirés | La table grossit ; tâche planifiée à prévoir. |
| `trust proxy` en production | Voir D14. |
| Mot de passe oublié, 2FA | Hors SPEC MVP. |
| **Émission des signaux par `crypto-engine`** | Le moteur doit publier selon `docs/SPEC.md` section 7 (D88) ; il n'émet encore rien. Rouvrir D83 si l'on veut des ordres manuels en LIVE. |
| Réglages de signaux par utilisateur | Voir D90 et D96 : seuil de score, écart de prix, péremption sont globaux (variables d'environnement). |
| Essai sur le testnet Binance | Voir D87 : aucun ordre réel n'a été passé. À faire avec une clé testnet dédiée (jamais dans git) avant tout usage LIVE ; le testnet n'expose pas `apiRestrictions` (D20), la configuration devra être étendue aux ordres testnet. |
| Ordres stop natifs sur la plateforme | Voir D84 : la protection actuelle est un contrôle par minute, sans effet si l'application est arrêtée ; un ordre stop posé côté plateforme protégerait aussi pendant une panne. |
| Réconciliation périodique des soldes | Le portefeuille est déclaratif (D32) et diverge de la plateforme (frais, dépôts) : lire les soldes réels (`fetchBalance`) et signaler l'écart, ce qui permettrait aussi d'inclure les pertes dues aux ordres dans la perte journalière (D43). |
| Passerelle d'ordres pour Kraken | Voir D18 : sans vérificateur de permissions ni passerelle, Kraken reste refusé. |
| Rapport du matin : stablecoins et soldes | La maquette mentionne « 4 200 USDC disponibles » ; sans lecture des soldes sur la plateforme (module d'ordres), le rapport ne couvre que les positions déclarées. |
| Rapport du matin : « Hier » | Voir D67 : le front lit le rapport `TODAY` précédent ; l'enum `YESTERDAY` est inutilisé. À retirer lors d'une prochaine migration du schéma. |
| Purge des anciens rapports | La table `digest_reports` grossit d'une ligne par jour et par utilisateur (plus une par semaine). |
| Alertes : valeur de la dernière évaluation | L'API n'expose pas le prix observé ni l'écart au seuil (« ETH à ~2,5 % de votre seuil », maquette) ; à ajouter si le front en a besoin. |
| Cache Redis des prix et de l'historique | Voir D36 : les prix passés sont aujourd'hui en mémoire (perdus au redémarrage, non partagés entre instances). |
| Envoyeurs Push (Web Push) et Email (SMTP) | Voir D51 : demandent `web-push` et `nodemailer`, à valider. Sans eux, les alertes critiques ne sortent pas de la boîte de réception. |
| Plusieurs instances de l'API et temps réel | Voir D105 : le bus WebSocket est en mémoire ; Redis pub/sub si l'API tourne en plusieurs instances. |
| Rejeu des événements WebSocket manqués | Voir D105 : le front relit l'état par l'API à chaque reconnexion ; un identifiant d'événement permettrait de rejouer. |
| Purge des anciennes notifications | La table grossit sans limite. |
| Pertes dues aux ordres du robot dans la perte journalière | Voir D43 : nécessite la lecture des soldes sur la plateforme (module d'ordres). |
| Tests d'intégration automatisés avec Redis et PostgreSQL | Voir D47 : la vérification sur un vrai Redis est aujourd'hui manuelle ; elle a trouvé un défaut que les tests unitaires ne pouvaient pas voir. |
| Purge des instantanés d'équité anciens | La table grossit d'une ligne par utilisateur et par jour. |
| Historique des transactions et P&L réalisé | Voir D33 : le gain réalisé n'est qu'audité, pas stocké ni agrégé. |
| Synchronisation des soldes avec la plateforme | Voir D32 : avec le module d'ordres (`ccxt`). |
| Source de prix : cache Redis | Voir D36 : remplace l'appel direct à l'API publique. |
| Contrôle d'éligibilité LIVE à chaque ordre | Voir D28 : la vérification au passage ne suffit pas si une clé est rejetée ensuite. |
| Tests d'intégration sur PostgreSQL | Compléter les tests sur base en mémoire (D15), notamment le trigger d'audit et les contraintes uniques. |
