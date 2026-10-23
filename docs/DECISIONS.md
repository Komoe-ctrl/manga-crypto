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

## À prévoir (hors étapes livrées)

| Sujet | Pourquoi |
|---|---|
| Vérificateur Kraken | Débloquer la plateforme ; sinon rester sur Binance. |
| Re-vérification périodique des clés | Détecter un droit « Withdrawal » ajouté après coup, sans attendre une action manuelle. |
| Procédure de rotation de `ENCRYPTION_KEY` | `needsRotation()` existe ; il manque la tâche qui re-chiffre les lignes en version ancienne. |
| Purge des refresh tokens expirés | La table grossit ; tâche planifiée à prévoir. |
| `trust proxy` en production | Voir D14. |
| Mot de passe oublié, 2FA | Hors SPEC MVP. |
| **Étape 9** : rapport du matin 08:00 | Voir D48 et D56 : générer le digest depuis les notifications `HELD` de la nuit (les marquer comme reprises), à l'heure `digestMinute` de chaque utilisateur, dans son fuseau. |
| Alertes : valeur de la dernière évaluation | L'API n'expose pas le prix observé ni l'écart au seuil (« ETH à ~2,5 % de votre seuil », maquette) ; à ajouter si le front en a besoin. |
| Cache Redis des prix et de l'historique | Voir D36 : les prix passés sont aujourd'hui en mémoire (perdus au redémarrage, non partagés entre instances). |
| Envoyeurs Push (Web Push) et Email (SMTP) | Voir D51 : demandent `web-push` et `nodemailer`, à valider. Sans eux, les alertes critiques ne sortent pas de la boîte de réception. |
| Passerelle WebSocket vers le front | La boîte de réception se lit aujourd'hui par `GET /api/notifications` ; le temps réel (socket.io) viendra avec le front. |
| Purge des anciennes notifications | La table grossit sans limite. |
| Pertes dues aux ordres du robot dans la perte journalière | Voir D43 : nécessite la lecture des soldes sur la plateforme (module d'ordres). |
| Tests d'intégration automatisés avec Redis et PostgreSQL | Voir D47 : la vérification sur un vrai Redis est aujourd'hui manuelle ; elle a trouvé un défaut que les tests unitaires ne pouvaient pas voir. |
| Purge des instantanés d'équité anciens | La table grossit d'une ligne par utilisateur et par jour. |
| Historique des transactions et P&L réalisé | Voir D33 : le gain réalisé n'est qu'audité, pas stocké ni agrégé. |
| Synchronisation des soldes avec la plateforme | Voir D32 : avec le module d'ordres (`ccxt`). |
| Source de prix : cache Redis | Voir D36 : remplace l'appel direct à l'API publique. |
| Contrôle d'éligibilité LIVE à chaque ordre | Voir D28 : la vérification au passage ne suffit pas si une clé est rejetée ensuite. |
| Tests d'intégration sur PostgreSQL | Compléter les tests sur base en mémoire (D15), notamment le trigger d'audit et les contraintes uniques. |
