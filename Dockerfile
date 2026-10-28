# Image de production de crypto-api (NestJS + Prisma 7).
# Construction : docker build -t veille-api .
# Exécution    : voir docs/DEPLOIEMENT.md (variables d'environnement, base, Redis).

# ---- Construction : dépendances, client Prisma, compilation -------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
# Réessais : un téléchargement coupé (réseau de la plateforme de construction) ne doit pas faire échouer tout le déploiement.
RUN npm ci --fetch-retries=5 --fetch-retry-mintimeout=15000 --fetch-retry-maxtimeout=120000

COPY . .
# `prisma generate` lit prisma.config.ts, qui exige DATABASE_URL, mais ne se connecte pas : valeur factice, pour cette étape seule.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate && npm run build

# ---- Exécution -----------------------------------------------------------------------------------------------------
FROM node:24-slim AS run
# openssl : requis par le moteur de migrations de Prisma. ca-certificates : appels https (échanges, Telegram, Push).
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

# node_modules complet (Prisma est un outil de développement du dépôt, mais les migrations s'appliquent au démarrage).
# --chown : le processus tourne en `node` (non root), et Prisma a besoin d'écrire dans node_modules/@prisma/engines.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts ./prisma.config.ts
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/package.json ./package.json

# Processus non privilégié : une faille dans l'API ne donne pas les droits du conteneur.
USER node
EXPOSE 3001
# La sonde interroge /api/health (base et Redis) ; la plateforme peut aussi définir la sienne.
# Délai de 10 s : le premier appel à froid peut dépasser 5 s sur une machine chargée (constaté à l'essai).
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/start-prod.mjs"]
