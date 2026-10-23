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

## À prévoir (hors étapes livrées)

| Sujet | Pourquoi |
|---|---|
| Vérificateur Kraken | Débloquer la plateforme ; sinon rester sur Binance. |
| Re-vérification périodique des clés | Détecter un droit « Withdrawal » ajouté après coup, sans attendre une action manuelle. |
| Procédure de rotation de `ENCRYPTION_KEY` | `needsRotation()` existe ; il manque la tâche qui re-chiffre les lignes en version ancienne. |
| Purge des refresh tokens expirés | La table grossit ; tâche planifiée à prévoir. |
| `trust proxy` en production | Voir D14. |
| Mot de passe oublié, 2FA | Hors SPEC MVP. |
| Pause automatique sur perte journalière | Voir D30. Le portefeuille et `totalValue()` existent (étape 5) ; manque la **valeur d'ouverture du jour** : table d'instantanés d'équité + planificateur (BullMQ) qui l'enregistre au début de la journée de chaque utilisateur (fuseau `User.timezone`) et surveille la perte. |
| Historique des transactions et P&L réalisé | Voir D33 : le gain réalisé n'est qu'audité, pas stocké ni agrégé. |
| Synchronisation des soldes avec la plateforme | Voir D32 : avec le module d'ordres (`ccxt`). |
| Source de prix : cache Redis | Voir D36 : remplace l'appel direct à l'API publique. |
| Contrôle d'éligibilité LIVE à chaque ordre | Voir D28 : la vérification au passage ne suffit pas si une clé est rejetée ensuite. |
| Tests d'intégration sur PostgreSQL | Compléter les tests sur base en mémoire (D15), notamment le trigger d'audit et les contraintes uniques. |
