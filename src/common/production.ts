type Env = Record<string, string | undefined>;

/**
 * Nombre de proxys de confiance devant l'API (`TRUST_PROXY`). Sans cela, derrière le proxy d'une plateforme, `req.ip`
 * est toujours l'adresse du proxy : la limite de 5 tentatives par minute serait partagée par **tous** les
 * utilisateurs et le journal d'audit noterait la mauvaise adresse. Absent : aucun proxy de confiance (valeur par
 * défaut sûre : sans proxy, `X-Forwarded-For` est librement falsifiable par le client).
 */
export function trustProxySetting(env: Env): number | false {
  const raw = env.TRUST_PROXY?.trim();
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') {
    return false;
  }
  if (!/^[1-9]\d?$/.test(raw)) {
    throw new Error(
      'TRUST_PROXY doit être le nombre de proxys devant l’API (1 à 99), ou absent',
    );
  }
  return Number(raw);
}

/** La documentation Swagger décrit toute l'API : publique seulement hors production, sauf demande explicite. */
export function swaggerEnabled(env: Env): boolean {
  return env.NODE_ENV !== 'production' || env.SWAGGER_ENABLED === 'true';
}

/**
 * Réglages qu'une mise en production ne doit jamais laisser aux valeurs de développement. Renvoie la liste des
 * problèmes (vide si tout va bien) : le démarrage refuse de continuer plutôt que de tourner avec une faille.
 */
export function productionConfigProblems(env: Env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];

  const origin = env.WEB_ORIGIN?.trim();
  if (!origin) {
    problems.push(
      'WEB_ORIGIN est absente : adresse du site (https://…), seule origine autorisée par CORS',
    );
  } else if (!origin.startsWith('https://')) {
    problems.push(
      'WEB_ORIGIN doit commencer par https:// : le cookie de session est marqué « secure » en production',
    );
  } else if (origin.endsWith('/')) {
    problems.push(
      'WEB_ORIGIN ne doit pas finir par « / » : CORS compare l’origine telle quelle',
    );
  }

  if (env.AUTH_REGISTRATION_ENABLED !== 'false') {
    problems.push(
      'AUTH_REGISTRATION_ENABLED doit valoir false : sinon n’importe qui peut créer un compte (les comptes se créent avec « npm run user:create »)',
    );
  }

  for (const name of ['DATABASE_URL', 'REDIS_URL'] as const) {
    if (!env[name]?.trim()) problems.push(`${name} est absente`);
  }
  return problems;
}

/** Arrête le démarrage avec tous les problèmes d'un coup (un seul déploiement raté, pas un par variable). */
export function assertProductionConfig(env: Env): void {
  const problems = productionConfigProblems(env);
  if (problems.length > 0) {
    throw new Error(
      `Configuration de production invalide :\n- ${problems.join('\n- ')}`,
    );
  }
}
