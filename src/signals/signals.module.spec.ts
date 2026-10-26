import { signalsEnabled, SignalsModule } from './signals.module.js';

const KEYS = ['SIGNALS_ENABLED', 'BACKGROUND_JOBS_ENABLED'] as const;

describe('SignalsModule (consommation des signaux opt-in)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const isEmpty = () => {
    const module = SignalsModule.register();
    return !module.providers && !module.imports;
  };

  it('est désactivée par défaut : aucune variable, aucune consommation', () => {
    delete process.env.SIGNALS_ENABLED;
    delete process.env.BACKGROUND_JOBS_ENABLED; // jobs actifs (défaut)
    expect(signalsEnabled()).toBe(false);
    expect(isEmpty()).toBe(true);
  });

  it.each(['false', '', '1', 'yes', 'TRUE', 'True', 'on', ' true'])(
    'seule la valeur exacte « true » l’active : %j reste désactivée',
    (value) => {
      process.env.SIGNALS_ENABLED = value;
      delete process.env.BACKGROUND_JOBS_ENABLED;
      expect(signalsEnabled()).toBe(false);
      expect(isEmpty()).toBe(true);
    },
  );

  it('SIGNALS_ENABLED=true branche le consommateur', () => {
    process.env.SIGNALS_ENABLED = 'true';
    delete process.env.BACKGROUND_JOBS_ENABLED;
    expect(signalsEnabled()).toBe(true);
    const module = SignalsModule.register();
    expect(module.providers?.length).toBeGreaterThan(0);
    expect(module.imports?.length).toBeGreaterThan(0);
  });

  it('même activée, elle ne s’ouvre pas si les jobs de fond sont désactivés (tests, aucune connexion Redis)', () => {
    process.env.SIGNALS_ENABLED = 'true';
    process.env.BACKGROUND_JOBS_ENABLED = 'false';
    expect(isEmpty()).toBe(true);
  });
});
