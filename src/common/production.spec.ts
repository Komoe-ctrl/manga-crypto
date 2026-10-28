import { describe, expect, it } from 'vitest';
import {
  assertProductionConfig,
  productionConfigProblems,
  swaggerEnabled,
  trustProxySetting,
} from './production.js';

const good = {
  NODE_ENV: 'production',
  WEB_ORIGIN: 'https://app.example.org',
  AUTH_REGISTRATION_ENABLED: 'false',
  DATABASE_URL: 'postgresql://u:p@db:5432/veille',
  REDIS_URL: 'redis://redis:6379',
};

describe('trustProxySetting', () => {
  it.each([undefined, '', 'false', '0', '  '])(
    'aucun proxy de confiance pour %j',
    (value) => {
      expect(trustProxySetting({ TRUST_PROXY: value })).toBe(false);
    },
  );

  it.each([
    ['1', 1],
    ['2', 2],
    [' 3 ', 3],
  ])('%j devient le nombre de proxys %i', (value, expected) => {
    expect(trustProxySetting({ TRUST_PROXY: value })).toBe(expected);
  });

  it.each(['true', '-1', '1.5', 'loopback', '100', '1,2'])(
    'refuse %j : seul un nombre de proxys est accepté (« true » ferait confiance à tout X-Forwarded-For)',
    (value) => {
      expect(() => trustProxySetting({ TRUST_PROXY: value })).toThrow(
        /TRUST_PROXY/,
      );
    },
  );
});

describe('swaggerEnabled', () => {
  it('actif en développement, fermé en production, rouvrable explicitement', () => {
    expect(swaggerEnabled({})).toBe(true);
    expect(swaggerEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(swaggerEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(
      swaggerEnabled({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' }),
    ).toBe(true);
    expect(
      swaggerEnabled({ NODE_ENV: 'production', SWAGGER_ENABLED: 'yes' }),
    ).toBe(false);
  });
});

describe('productionConfigProblems', () => {
  it('ne contrôle rien hors production', () => {
    expect(productionConfigProblems({})).toEqual([]);
    expect(productionConfigProblems({ NODE_ENV: 'development' })).toEqual([]);
  });

  it('accepte une configuration de production complète', () => {
    expect(productionConfigProblems(good)).toEqual([]);
    expect(() => assertProductionConfig(good)).not.toThrow();
  });

  it('exige WEB_ORIGIN en https, sans « / » final', () => {
    expect(
      productionConfigProblems({ ...good, WEB_ORIGIN: undefined }),
    ).toEqual([expect.stringContaining('WEB_ORIGIN est absente')]);
    expect(
      productionConfigProblems({
        ...good,
        WEB_ORIGIN: 'http://localhost:3000',
      }),
    ).toEqual([expect.stringContaining('https://')]);
    expect(
      productionConfigProblems({ ...good, WEB_ORIGIN: 'https://a.org/' }),
    ).toEqual([expect.stringContaining('finir par « / »')]);
  });

  it("refuse l'inscription publique ouverte, y compris quand la variable est absente (défaut = ouverte)", () => {
    for (const value of [undefined, 'true', '', 'no']) {
      expect(
        productionConfigProblems({ ...good, AUTH_REGISTRATION_ENABLED: value }),
      ).toEqual([expect.stringContaining('AUTH_REGISTRATION_ENABLED')]);
    }
  });

  it('exige les adresses de la base et de Redis', () => {
    expect(
      productionConfigProblems({
        ...good,
        DATABASE_URL: undefined,
        REDIS_URL: ' ',
      }),
    ).toEqual([
      expect.stringContaining('DATABASE_URL'),
      expect.stringContaining('REDIS_URL'),
    ]);
  });

  it('signale tous les problèmes en une seule erreur, sans valeur secrète', () => {
    const env = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:secret@db/x',
    };
    expect(() => assertProductionConfig(env)).toThrow(
      /WEB_ORIGIN[\s\S]*AUTH_REGISTRATION_ENABLED[\s\S]*REDIS_URL/,
    );
    try {
      assertProductionConfig(env);
    } catch (error) {
      expect(String(error)).not.toContain('secret');
    }
  });
});
