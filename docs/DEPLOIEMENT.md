# Mise en service (hébergement)

Ce document est le mode d'emploi pour mettre Veille en ligne. Il est **indépendant de la plateforme** : les étapes exactes
des écrans de chaque hébergeur (Railway, Render, Fly.io…) ne sont pas décrites ici, parce qu'elles n'ont pas été
essayées (voir « Ce qui n'est pas vérifié » en bas). Ce qui est décrit, en revanche, a été exécuté.

## Ce qu'il faut

| Élément | Rôle | Remarque |
|---|---|---|
| **API** (ce dépôt, `Dockerfile`) | Auth, portefeuille, risque, notifications, WebSocket, ordres | **Un seul exemplaire** : les tâches de fond (rapport du matin, alertes, surveillance du risque) y tournent, et un second exemplaire les doublerait |
| **Site** (`crypto-web`, `Dockerfile`) | L'application que voit le client | Peut avoir plusieurs exemplaires |
| **PostgreSQL 18** | Toutes les données | Sauvegardes quotidiennes (voir plus bas) |
| **Redis 8** | Files des tâches de fond | Avec persistance (`appendonly yes`) |
| **Un nom de domaine** | `app.<domaine>` pour le site, `api.<domaine>` pour l'API | **Obligatoire**, voir ci-dessous |

### Pourquoi un nom de domaine est obligatoire
Le cookie de renouvellement de session est en `SameSite=Strict` (jamais envoyé d'un site à un autre). Le site et l'API
doivent donc être sur **le même « site »**, c'est-à-dire sous le même domaine : `app.exemple.fr` et `api.exemple.fr`.
Les adresses fournies par les plateformes (`xxx.up.railway.app`, `xxx.onrender.com`, `xxx.fly.dev`…) appartiennent à
des domaines publics distincts : le site et l'API y seraient sur deux « sites » différents, et la session ne
se renouvellerait plus (le client serait déconnecté toutes les 15 minutes). Un domaine coûte environ 10 € par an.

## Variables d'environnement de l'API

| Variable | Valeur en production |
|---|---|
| `NODE_ENV` | `production` (active les contrôles de démarrage, ferme Swagger, cookie `secure`) |
| `PORT` | Celui que la plateforme impose (3001 par défaut) |
| `WEB_ORIGIN` | `https://app.<domaine>` : **https, sans « / » final** |
| `DATABASE_URL` | Adresse PostgreSQL fournie par la plateforme |
| `REDIS_URL` | Adresse Redis (`rediss://` si TLS) |
| `AUTH_REGISTRATION_ENABLED` | **`false`** : sinon n'importe qui peut créer un compte |
| `TRUST_PROXY` | `1` quand l'API est derrière **un** proxy (le cas des plateformes). Sans cela, tous les utilisateurs partagent la même limite de connexions et le journal d'audit note l'adresse du proxy |
| `JWT_ACCESS_SECRET` | Chaîne aléatoire de 32 caractères minimum |
| `ENCRYPTION_ACTIVE_KEY_VERSION`, `ENCRYPTION_KEY_V1` | Clé maître de 32 octets en base64 (chiffrement des clés d'échange) |
| `TRADING_DEFAULT_MODE` | `PAPER` |
| `BACKGROUND_JOBS_ENABLED` | `true` (valeur par défaut) sur l'**unique** exemplaire de l'API |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Pour le Push (`npm run vapid:generate`) |
| `TELEGRAM_BOT_TOKEN`, `SMTP_*`, `EMAIL_FROM` | Facultatifs : canaux Telegram et e-mail |
| `RUN_MIGRATIONS` | `false` seulement si les migrations sont lancées à part |
| `SWAGGER_ENABLED` | `true` seulement pour rouvrir la documentation `/docs` |

Au démarrage en production, l'API **refuse de démarrer** (avec la liste complète des problèmes) si `WEB_ORIGIN`
n'est pas en https, si l'inscription est ouverte, ou si la base ou Redis ne sont pas renseignés. Elle refuse aussi un
`JWT_ACCESS_SECRET` trop court et une clé de chiffrement absente ou de mauvaise taille.

**Générer les secrets** (une seule fois, à conserver dans le gestionnaire de secrets de la plateforme) :

```
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT_ACCESS_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"      # ENCRYPTION_KEY_V1
```

> **Garder `ENCRYPTION_KEY_V1` séparément de la base.** Une sauvegarde de la base sans cette clé ne permet plus de
> relire les clés d'échange chiffrées. Et perdre la clé revient à perdre ces clés (il faudrait les ressaisir). Tant que
> le robot reste en mode PAPER, aucune clé d'échange n'est stockée : le risque est nul, mais l'habitude se prend dès maintenant.

## Variables du site

Elles sont **figées à la construction** de l'image (`--build-arg`) : changer d'adresse demande de reconstruire.

| Argument de construction | Valeur |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api.<domaine>` (**sans `/api`**) |
| `NEXT_PUBLIC_WS_URL` | `wss://api.<domaine>` |

```
docker build -t veille-web \
  --build-arg NEXT_PUBLIC_API_URL=https://api.exemple.fr \
  --build-arg NEXT_PUBLIC_WS_URL=wss://api.exemple.fr .
```

## Ordre de mise en service

1. **Acheter le domaine** et créer deux enregistrements chez la plateforme : `app.<domaine>` → site, `api.<domaine>` → API (le https est délivré par la plateforme).
2. **Créer PostgreSQL et Redis** chez la plateforme ; activer les **sauvegardes automatiques** de la base.
3. **Déployer l'API** (`Dockerfile` de ce dépôt) avec les variables ci-dessus. Au démarrage, elle applique les migrations
   (`prisma migrate deploy`) puis se lance. Régler la **sonde de santé** sur `GET /api/health` (200 : tout va bien ; 503 : la base ou Redis ne répondent pas).
4. **Déployer le site** (`Dockerfile` de `crypto-web`, avec les deux adresses en argument de construction).
5. **Créer le compte du client** (l'inscription publique est fermée) : dans une console du service API,
   ```
   node scripts/user.mjs create client@exemple.fr --name "Nom du client" --timezone Europe/Paris
   ```
   Le mot de passe est demandé deux fois, masqué. Sans terminal interactif, le fournir par la variable `VEILLE_PASSWORD`
   (à retirer ensuite). Détails : `docs/ETAPES.md`, étape 28.
6. **Vérifier** : ouvrir `https://app.<domaine>`, se connecter, attendre 20 minutes sur une page (le jeton d'accès dure 15 min : la
   session doit se renouveler sans reconnexion), envoyer le message de test depuis les Réglages, vérifier `https://api.<domaine>/api/health`.
7. **Essayer le Push et l'installation** sur le vrai téléphone du client (voir `crypto-web/docs/ETAPES.md`, étape 28).

## Sauvegarde et restauration

La base contient tout ce qui compte (positions, historique, alertes, réglages, rapports, journal d'audit). Redis ne contient que
les files de tâches : le perdre ne perd aucune donnée du client.

**Sauvegarder** (à planifier chaque jour ; la plateforme propose souvent une sauvegarde automatique, à activer **en plus**
d'une copie hors plateforme de temps en temps) :

```
pg_dump "$DATABASE_URL" -Fc --no-owner -f veille-AAAA-MM-JJ.dump
```

**Restaurer** dans une base vide :

```
pg_restore -d "$NOUVELLE_DATABASE_URL" --no-owner --exit-on-error veille-AAAA-MM-JJ.dump
```

Puis démarrer l'API sur cette base (`prisma migrate deploy` ne trouve rien à appliquer).

**Vérifié** : une sauvegarde de la base de développement (14 tables, 9 migrations) restaurée dans une base vide a donné
exactement les mêmes nombres de lignes, table par table, et les mêmes migrations.
**À refaire une fois sur la vraie base, après la mise en ligne** (essayer la restauration dans une base jetable, jamais sur la base en service).

## Mettre à jour

1. Déployer la nouvelle image de l'API : les migrations en attente s'appliquent au démarrage. Si l'une échoue, l'API ne démarre pas.
   Selon la plateforme, l'ancien exemplaire reste servi tant que le nouveau ne passe pas la sonde de santé (à vérifier au choix de la plateforme).
2. Déployer le site.
3. **Ordre** : l'API d'abord (elle reste compatible avec l'ancien site), puis le site.

**Avant une mise à jour qui change le schéma de la base, faire une sauvegarde** (section précédente) : redéployer l'ancienne image ne défait pas une migration déjà appliquée.

## Diagnostiquer

| Symptôme | Cause probable |
|---|---|
| L'API ne démarre pas : « Configuration de production invalide » | Le message liste chaque variable à corriger |
| « Migrations en échec : l'API ne démarre pas » | Lire le message de Prisma au-dessus, et **vérifier l'état de la base avant de relancer** (Prisma indique la migration en échec ; ne pas la rejouer à l'aveugle) |
| `/api/health` renvoie 503 | `checks` dit lequel répond mal : `database` ou `redis` |
| Le client est déconnecté toutes les 15 minutes | Site et API pas sous le même domaine, ou `WEB_ORIGIN` différent de l'adresse réelle du site |
| « Trop de tentatives » pour tout le monde | `TRUST_PROXY` absent : tous les utilisateurs apparaissent avec l'adresse du proxy |
| Le site appelle `localhost:3001` | Image du site construite sans `NEXT_PUBLIC_API_URL` (la construction refuse normalement) |
| Le rapport du matin arrive en double | Deux exemplaires de l'API avec `BACKGROUND_JOBS_ENABLED=true` |
| Pas de temps réel (pastille « Reconnexion… ») | `NEXT_PUBLIC_WS_URL` faux, ou la plateforme coupe les WebSocket |

## Ce qui n'est pas vérifié

- **Aucun déploiement chez un vrai hébergeur n'a été fait** : il manque encore le choix de la plateforme et du domaine.
  Les étapes propres à chaque plateforme sont à écrire (et à essayer) au moment du choix.
- **L'image de l'API a été construite et exécutée** (démarrage, migrations, santé avec base et Redis, utilisateur non root, création du compte, connexion, arrêt propre). Elle pèse 1,17 Go (`node_modules` complet, pour les migrations au démarrage). **L'image du site** : voir la PR de `crypto-web`.
- Le comportement derrière un vrai proxy https (cookie `secure`, WebSocket `wss://`) : vérifié seulement par simulation d'un proxy
  (`X-Forwarded-For`), pas derrière un vrai.
- Les performances (nombre d'utilisateurs, mémoire nécessaire) : un seul client est prévu ; rien n'a été mesuré.
